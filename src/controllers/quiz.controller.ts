import crypto from 'crypto';
import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import { PLAN_LIMITS, QuizAllowance } from '../config/plans';
import Quiz from '../models/quiz.model';
import QuizAttempt from '../models/quizAttempt.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import {
  DIFFICULTIES,
  Difficulty,
  IQuiz,
  IQuizAttempt,
  QUESTION_TYPES,
  QuestionType,
  QuizQuestion,
  QuizSettings,
  TRUE_FALSE,
} from '../types/quiz';
import { startOfToday } from '../utils/ai/energy';
import { pickQuestions, Slot, topicsOf } from '../utils/ai/bank';
import LibraryFile from '../models/libraryFile.model';
import { readySources } from '../utils/ai/scope';
import { planFor } from '../utils/plan';
import { recordActivity } from '../utils/activity';
import { applyCourseResult, applyQuizResult } from '../utils/mastery';
import CourseMap from '../models/courseMap.model';
import Space from '../models/space.model';
import { notify } from '../utils/notify';
import Warmup from '../models/warmup.model';
import { sendError, sendSuccess } from '../utils/response';
import { openStream, Stream } from '../utils/sse';

const TITLE_MAX = 120;
const MAX_QUESTIONS = 100;
const MAX_AI_QUESTIONS = 50;
const PROMPT_MAX = 1000;
const CHOICE_MAX = 300;
const EXPLANATION_MAX = 2000;
const MIN_CHOICES = 2;
const MAX_CHOICES = 6;
// Pictures arrive as data URLs; this keeps a quiz well under MongoDB's 16 MB limit
const IMAGE_MAX = 700_000;
const IMAGES_TOTAL_MAX = 10_000_000;

const DEFAULT_SETTINGS: QuizSettings = {
  timeLimit: null,
  retakes: null,
  randomize: true,
  showResults: true,
  hints: false,
  visibility: 'anyone',
};

const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);
const idList = (value: unknown): string[] | null =>
  value === undefined || value === null ? null : Array.isArray(value) ? [...new Set(value.filter(isId))] : [];

const planLimit = (res: Response, message: string, limit: string) =>
  sendError(res, message, 403, { code: 'PLAN_LIMIT', limit });

// ── Daily limits ──────────────────────────────────────────────────────────────

const usageToday = async (userId: string) => {
  const today = startOfToday();
  const [creates, privateTakes, publicTakes] = await Promise.all([
    // Warm-ups are made for the student and never count toward the limits
    Quiz.countDocuments({ owner: userId, method: { $ne: 'warmup' }, createdAt: { $gte: today } }),
    QuizAttempt.countDocuments({ user: userId, own: true, warmup: { $ne: true }, createdAt: { $gte: today } }),
    QuizAttempt.countDocuments({ user: userId, own: false, createdAt: { $gte: today } }),
  ]);
  return { creates, privateTakes, publicTakes };
};

const left = (limit: number | null, used: number) => (limit === null ? null : Math.max(0, limit - used));

const limitsFor = async (userId: string) => {
  const { plan } = await planFor(userId);
  const allowance: QuizAllowance = PLAN_LIMITS[plan].quizzes;
  const used = await usageToday(userId);
  return {
    plan,
    allowance,
    used,
    today: {
      creates: { used: used.creates, limit: allowance.createsPerDay, left: left(allowance.createsPerDay, used.creates) },
      privateTakes: {
        used: used.privateTakes,
        limit: allowance.privateTakesPerDay,
        left: left(allowance.privateTakesPerDay, used.privateTakes),
      },
      publicTakes: {
        used: used.publicTakes,
        limit: allowance.publicTakesPerDay,
        left: left(allowance.publicTakesPerDay, used.publicTakes),
      },
    },
  };
};

const canCreate = async (userId: string) => {
  const { allowance, used } = await limitsFor(userId);
  return allowance.createsPerDay === null || used.creates < allowance.createsPerDay ? null : allowance.createsPerDay;
};

// ── Validation ────────────────────────────────────────────────────────────────

const readSettings = (input: unknown, base: QuizSettings): QuizSettings | string => {
  if (input === undefined) return base;
  if (!input || typeof input !== 'object') return 'Settings must be an object';
  const raw = input as Record<string, unknown>;
  const settings = { ...base };

  if (raw.timeLimit !== undefined) {
    if (raw.timeLimit !== null && (!Number.isInteger(raw.timeLimit) || (raw.timeLimit as number) < 1 || (raw.timeLimit as number) > 300)) {
      return 'Time limit must be 1 to 300 minutes, or null';
    }
    settings.timeLimit = raw.timeLimit as number | null;
  }
  if (raw.retakes !== undefined) {
    if (raw.retakes !== null && (!Number.isInteger(raw.retakes) || (raw.retakes as number) < 0 || (raw.retakes as number) > 20)) {
      return 'Retakes must be 0 to 20, or null for unlimited';
    }
    settings.retakes = raw.retakes as number | null;
  }
  for (const key of ['randomize', 'showResults', 'hints'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'boolean') return `${key} must be true or false`;
      settings[key] = raw[key] as boolean;
    }
  }
  if (raw.visibility !== undefined) {
    if (raw.visibility !== 'anyone' && raw.visibility !== 'private') return 'Visibility must be "anyone" or "private"';
    settings.visibility = raw.visibility;
  }
  return settings;
};

const isDifficulty = (value: unknown): value is Difficulty =>
  typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);

const readImage = (value: unknown): string | null | false => {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(value) && value.length <= IMAGE_MAX
    ? value
    : false;
};

/** Checks questions written by hand or imported. Returns them cleaned, or what's wrong. */
const readQuestions = (input: unknown, previous: QuizQuestion[] = []): QuizQuestion[] | string => {
  if (!Array.isArray(input) || !input.length) return 'Add at least one question';
  if (input.length > MAX_QUESTIONS) return `A quiz can have up to ${MAX_QUESTIONS} questions`;

  const byId = new Map(previous.map((question) => [question.id, question]));
  const questions: QuizQuestion[] = [];
  let imageBytes = 0;

  for (const [index, raw] of input.entries()) {
    const n = index + 1;
    if (!raw || typeof raw !== 'object') return `Question ${n} is not valid`;
    const q = raw as Record<string, unknown>;
    const type = q.type as QuestionType;
    if (!(QUESTION_TYPES as readonly string[]).includes(type)) return `Question ${n}: type must be "mcqs" or "true-false"`;

    const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : '';
    if (!prompt || prompt.length > PROMPT_MAX) return `Question ${n}: write the question (up to ${PROMPT_MAX} characters)`;

    const choices =
      type === 'true-false'
        ? [...TRUE_FALSE]
        : Array.isArray(q.choices)
          ? q.choices.map((choice) => (typeof choice === 'string' ? choice.trim() : ''))
          : [];
    if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) return `Question ${n}: give ${MIN_CHOICES} to ${MAX_CHOICES} options`;
    if (choices.some((choice) => !choice || choice.length > CHOICE_MAX)) return `Question ${n}: every option needs text (up to ${CHOICE_MAX} characters)`;

    const correct = q.correct;
    if (!Number.isInteger(correct) || (correct as number) < 0 || (correct as number) >= choices.length) {
      return `Question ${n}: pick the correct answer`;
    }

    const explanation = typeof q.explanation === 'string' ? q.explanation.trim() : '';
    if (explanation.length > EXPLANATION_MAX) return `Question ${n}: the explanation is too long`;

    const image = readImage(q.image);
    if (image === false) return `Question ${n}: the picture must be a PNG, JPEG, WebP or GIF under 500 KB`;
    const choiceImages = Array.isArray(q.choiceImages) ? q.choiceImages.map(readImage) : [];
    if (choiceImages.some((picture) => picture === false)) return `Question ${n}: an option's picture is not valid`;
    imageBytes += (image?.length ?? 0) + choiceImages.reduce((sum, picture) => sum + ((picture as string | null)?.length ?? 0), 0);
    if (imageBytes > IMAGES_TOTAL_MAX) return 'The pictures in this quiz are too large altogether';

    // Questions keep their id when edited, so earlier answers still line up
    const id = typeof q.id === 'string' && q.id.length <= 64 ? q.id : crypto.randomUUID();
    const before = byId.get(id);
    questions.push({
      id,
      type,
      prompt,
      choices,
      correct: correct as number,
      explanation,
      hint: typeof q.hint === 'string' ? q.hint.trim().slice(0, 500) : before?.hint ?? '',
      image,
      choiceImages: choiceImages as (string | null)[],
      // An edited AI question keeps its evidence and source
      quote: before?.quote ?? '',
      sourceTitle: before?.sourceTitle ?? '',
      spaceMaterial: before?.spaceMaterial ?? null,
      bankItem: before?.bankItem ?? null,
      fileId: before?.fileId ?? null,
      pageStart: before?.pageStart ?? null,
      pageEnd: before?.pageEnd ?? null,
    });
  }

  if (new Set(questions.map((question) => question.id)).size !== questions.length) return 'Two questions share an id';
  return questions;
};

// ── Shapes sent to the frontend ───────────────────────────────────────────────

interface Creator {
  name: string;
  avatar: string | null;
}

/** The name and photo of each quiz's owner, for the public page and cards. */
const creatorsOf = async (quizzes: IQuiz[]): Promise<Map<string, Creator>> => {
  const owners = await User.find({ _id: { $in: [...new Set(quizzes.map((quiz) => String(quiz.owner)))] } })
    .select('firstName lastName avatar')
    .lean();
  return new Map(
    owners.map((owner) => [
      String(owner._id),
      { name: `${owner.firstName} ${owner.lastName ?? ''}`.trim(), avatar: owner.avatar ?? null },
    ])
  );
};

const toCard = (quiz: IQuiz, creator?: Creator) => ({
  id: quiz._id,
  title: quiz.title,
  method: quiz.method,
  // "material" shows "Based on <file>"; "manual" shows who wrote it
  origin: quiz.method === 'ai' ? 'material' : 'manual',
  creatorName: creator?.name ?? null,
  creatorAvatar: creator?.avatar ?? null,
  questionCount: quiz.questions.length,
  difficulty: quiz.difficulty,
  types: quiz.types,
  sourceName: quiz.sourceName,
  createdAt: quiz.createdAt,
  timeLimit: quiz.settings.timeLimit,
  retakes: quiz.settings.retakes,
  randomize: quiz.settings.randomize,
  showResults: quiz.settings.showResults,
  hints: quiz.settings.hints,
  visibility: quiz.settings.visibility,
});

/** The questions, with answers and explanations only when `reveal` is true. */
/**
 * Where an answer is covered, for "Open at page": the file, its pages, and the
 * exact words that prove it (highlighted when it opens). Library files open in
 * Study; course materials open in their space.
 */
const evidenceOf = (question: IQuiz['questions'][number], spaceSlug: string | null) => ({
  fileId: question.fileId,
  pageStart: question.pageStart,
  pageEnd: question.pageEnd,
  quote: question.quote ?? '',
  sourceTitle: question.sourceTitle ?? '',
  libraryId: question.libraryId ?? null,
  spaceSlug: question.spaceMaterial ? spaceSlug : null,
  spaceMaterialId: question.spaceMaterial ?? null,
});

const questionsOf = (quiz: IQuiz, reveal: boolean, spaceSlug: string | null = null) =>
  quiz.questions.map((question) => ({
    id: question.id,
    type: question.type,
    prompt: question.prompt,
    choices: question.choices,
    image: question.image,
    choiceImages: question.choiceImages,
    ...(reveal
      ? {
          correct: question.correct,
          explanation: question.explanation,
          hint: question.hint,
          ...evidenceOf(question, spaceSlug),
        }
      : quiz.settings.hints && question.hint
        ? { hint: question.hint }
        : {}),
  }));

/** Everything, answers included: for the quiz's owner. */
const toFullQuiz = (quiz: IQuiz, creator?: Creator, spaceSlug: string | null = null) => ({
  ...toCard(quiz, creator),
  ownerId: quiz.owner,
  fileIds: quiz.files,
  questions: questionsOf(quiz, true, spaceSlug),
});

/** Each warm-up's space address, so its questions can open course materials. */
const spaceSlugsOf = async (quizzes: IQuiz[]) => {
  const ids = [...new Set(quizzes.map((quiz) => quiz.space).filter(Boolean).map(String))];
  if (!ids.length) return new Map<string, string>();
  const spaces = await Space.find({ _id: { $in: ids } }).select('slug').lean();
  return new Map(spaces.map((space) => [String(space._id), space.slug]));
};

/** For taking it: no answers or explanations until it's handed in. The app shuffles when `randomize` is on. */
const toPlayQuiz = (quiz: IQuiz, creator?: Creator) => ({
  ...toCard(quiz, creator),
  questions: questionsOf(quiz, false),
});

const findOwnQuiz = (userId: string, id: unknown) =>
  isId(id) ? Quiz.findOne({ _id: id, owner: userId }) : Promise.resolve(null);

/** A quiz this student may take: their own, or one shared with anyone who has the link. */
const findPlayableQuiz = async (userId: string, id: unknown) => {
  if (!isId(id)) return null;
  const quiz = await Quiz.findById(id);
  if (!quiz) return null;
  return String(quiz.owner) === userId || quiz.settings.visibility === 'anyone' ? quiz : null;
};

/** One attempt as the history screen shows it, with the option picked for each question. */
const toHistoryAttempt = (attempt: IQuizAttempt, number: number) => ({
  id: attempt._id,
  number,
  correct: attempt.correct,
  total: attempt.total,
  score: attempt.score,
  seconds: attempt.seconds,
  takenAt: attempt.createdAt,
  answers: Object.fromEntries(
    attempt.answers.filter((answer) => answer.choice !== null).map((answer) => [answer.questionId, answer.choice])
  ),
});

// ── List and limits ───────────────────────────────────────────────────────────

export const getQuizUsage = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { plan, today } = await limitsFor(req.user!.id);
    sendSuccess(res, { plan, today });
  } catch (error) {
    next(error);
  }
};

/**
 * The Quizzes page in one call:
 * - `created`: quizzes you made, with how many other people took them
 * - `taken`: every quiz you've taken (yours or shared), with each attempt and the answers you picked
 */
export const listQuizzes = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = new Types.ObjectId(req.user!.id);
    const created = await Quiz.find({ owner: userId, method: { $ne: 'warmup' } }).sort({ createdAt: -1 });

    // People are counted by account, or by browser for guests
    const takers = await QuizAttempt.aggregate<{ _id: Types.ObjectId; people: number; attempts: number }>([
      { $match: { quiz: { $in: created.map((quiz) => quiz._id) }, own: false } },
      { $group: { _id: { quiz: '$quiz', who: { $ifNull: ['$user', '$guestId'] } }, attempts: { $sum: 1 } } },
      { $group: { _id: '$_id.quiz', people: { $sum: 1 }, attempts: { $sum: '$attempts' } } },
    ]);
    const takersByQuiz = new Map(takers.map((row) => [String(row._id), row]));

    const attempts = await QuizAttempt.find({ user: userId }).sort({ createdAt: 1 });
    const attemptsByQuiz = new Map<string, IQuizAttempt[]>();
    for (const attempt of attempts) {
      const key = String(attempt.quiz);
      if (!attemptsByQuiz.has(key)) attemptsByQuiz.set(key, []);
      attemptsByQuiz.get(key)!.push(attempt);
    }
    const createdIds = new Set(created.map((quiz) => String(quiz._id)));
    const others = await Quiz.find({ _id: { $in: [...attemptsByQuiz.keys()].filter((id) => !createdIds.has(id)) } });
    const [creators, slugs] = await Promise.all([creatorsOf([...created, ...others]), spaceSlugsOf([...created, ...others])]);
    const byId = new Map([...created, ...others].map((quiz) => [String(quiz._id), quiz]));

    const taken = [...attemptsByQuiz.entries()]
      .map(([quizId, tries]) => {
        const quiz = byId.get(quizId);
        if (!quiz) return null;
        const own = createdIds.has(quizId);
        return {
          ...toCard(quiz, creators.get(String(quiz.owner))),
          // Answers are shown in review when it's yours or the owner allows results
          questions: questionsOf(quiz, own || quiz.settings.showResults, quiz.space ? slugs.get(String(quiz.space)) ?? null : null),
          attempts: tries.map((attempt, index) => toHistoryAttempt(attempt, index + 1)).reverse(),
          lastTakenAt: tries[tries.length - 1].createdAt,
        };
      })
      .filter((quiz): quiz is NonNullable<typeof quiz> => Boolean(quiz))
      .sort((a, b) => b.lastTakenAt.getTime() - a.lastTakenAt.getTime());

    sendSuccess(res, {
      created: created.map((quiz) => {
        const stats = takersByQuiz.get(String(quiz._id));
        return {
          ...toFullQuiz(quiz, creators.get(String(quiz.owner))),
          participants: stats?.people ?? 0,
          participantAttempts: stats?.attempts ?? 0,
        };
      }),
      taken,
      today: (await limitsFor(req.user!.id)).today,
    });
  } catch (error) {
    next(error);
  }
};

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Makes a quiz from the student's files with AI. Streams the steps the
 * generating screen shows (reading, mapping, concepts, planning, creating,
 * reviewing, balancing, assembling), each with `data` for its numbers,
 * then `result` with the quiz. Questions come from the shared bank, so this
 * costs no energy; it counts toward the daily quiz limit.
 */
export const generateQuiz = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const userId = req.user!.id;
  const body = req.body ?? {};
  const fileIds = idList(body.fileIds);
  const libraryIds = idList(body.libraryIds);
  const count = Number(body.count ?? 10);
  const difficulty = body.difficulty ?? 'medium';
  const types: QuestionType[] = Array.isArray(body.types) && body.types.length ? [...new Set(body.types as QuestionType[])] : ['mcqs'];
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  // "By topic": only these topics, e.g. [{ fileId, topicKey: "c2t0" }] from GET /progress
  const topicPicks: { fileId: string; topicKey: string }[] | null = Array.isArray(body.topics)
    ? (body.topics as unknown[])
        .filter(
          (pick): pick is { fileId: string; topicKey: string } =>
            Boolean(pick) &&
            isId((pick as { fileId?: unknown }).fileId) &&
            typeof (pick as { topicKey?: unknown }).topicKey === 'string' &&
            (pick as { topicKey: string }).topicKey.length <= 20
        )
        .slice(0, 30)
    : null;
  if (topicPicks && !topicPicks.length) {
    sendError(res, 'Choose at least one topic', 400);
    return;
  }
  const sourceFileIds = topicPicks ? [...new Set(topicPicks.map((pick) => pick.fileId))] : fileIds;

  if (!sourceFileIds?.length && !libraryIds?.length) {
    sendError(res, 'Choose at least one file or library', 400);
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_AI_QUESTIONS) {
    sendError(res, `Ask for 1 to ${MAX_AI_QUESTIONS} questions`, 400);
    return;
  }
  if (!isDifficulty(difficulty)) {
    sendError(res, 'Difficulty must be easy, medium or hard', 400);
    return;
  }
  if (types.some((type) => !(QUESTION_TYPES as readonly string[]).includes(type))) {
    sendError(res, 'Question types can be "mcqs" and "true-false". Short answer is coming soon.', 400);
    return;
  }
  if (title.length > TITLE_MAX) {
    sendError(res, `Title must be up to ${TITLE_MAX} characters`, 400);
    return;
  }
  const settings = readSettings(body.settings, DEFAULT_SETTINGS);
  if (typeof settings === 'string') {
    sendError(res, settings, 400);
    return;
  }

  let stream: Stream | null = null;
  try {
    const limit = await canCreate(userId);
    if (limit !== null) {
      planLimit(res, `Your plan allows ${limit} new quizzes a day. Upgrade to create more.`, 'quizCreates');
      return;
    }

    stream = openStream(req, res);
    // Eight steps, each with the real numbers behind it (`data`), so the
    // generating screen can say what's happening in the student's language.
    stream.step('reading', 'Reading your materials…', { status: 'active' });
    const sources = await readySources(stream, userId, { fileIds: sourceFileIds, libraryIds: topicPicks ? null : libraryIds });
    if (stream.closed) return;
    if (!sources.length) {
      stream.fail("None of these files could be read. Try a PDF, Word, PowerPoint or text file.");
      return;
    }
    const pages = sources.reduce((sum, source) => sum + (source.material.pageCount ?? 0), 0);
    stream.step('reading', `Read ${sources.length} file${sources.length === 1 ? '' : 's'}`, {
      status: 'done',
      data: { files: sources.length, pages },
    });

    const chapters = sources.flatMap((source) => source.material.map?.chapters ?? []);
    const topicTitles = chapters.flatMap((chapter) =>
      chapter.topics.length ? chapter.topics.map((topic) => topic.title) : [chapter.title]
    );
    stream.step('mapping', `Found ${chapters.length} chapters and ${topicTitles.length} topics`, {
      status: 'done',
      data: { chapters: chapters.length, topics: topicTitles.length },
    });

    const concepts = chapters.flatMap((chapter) => chapter.topics.flatMap((topic) => topic.concepts ?? []));
    stream.step('concepts', `Key ideas: ${topicTitles.slice(0, 3).join(', ')}`, {
      status: 'done',
      data: { names: topicTitles.slice(0, 3), concepts: concepts.length },
    });

    // Questions already in the student's quizzes come last, so new quizzes feel new
    const seen = new Set((await Quiz.distinct('questions.bankItem', { owner: userId })).filter(Boolean).map(String));
    stream.step('planning', `Planning ${count} ${difficulty} questions`, {
      status: 'done',
      data: { count, difficulty, types, seen: seen.size },
    });

    // Chosen topics share the questions evenly; otherwise they're spread over every topic
    let slots: Slot[] | undefined;
    if (topicPicks) {
      const fileMaterials = new Map(
        (await LibraryFile.find({ _id: { $in: sourceFileIds }, owner: userId }).select('material').lean()).map((file) => [
          String(file._id),
          String(file.material),
        ])
      );
      const chosen = topicPicks
        .map((pick) => {
          const source = sources.find((entry) => String(entry.material._id) === fileMaterials.get(pick.fileId));
          const topic = source && topicsOf(source.material.map).find((entry) => entry.key === pick.topicKey);
          return source && topic ? { source, topic, need: 0 } : null;
        })
        .filter((slot): slot is Slot => Boolean(slot));
      if (!chosen.length) {
        stream.fail("Those topics aren't in these files any more. Pick them again.");
        return;
      }
      for (let i = 0; i < count; i++) chosen[i % chosen.length].need++;
      slots = chosen.filter((slot) => slot.need > 0);
    }

    const live = stream;
    let topicsWritten = 0;
    live.step('creating', 'Writing questions…', { status: 'active', data: { done: 0, total: 0 } });
    const picked = await pickQuestions({
      userId,
      sources,
      count,
      difficulty,
      types,
      seen,
      slots,
      onProgress: (progress) => {
        topicsWritten = progress.total;
        live.step('creating', `Writing questions (${progress.done}/${progress.total} topics)…`, {
          status: progress.done === progress.total ? 'done' : 'active',
          data: { done: progress.done, total: progress.total, topic: progress.topic ?? null },
        });
        if (progress.written) {
          live.step('reviewing', `Checked ${progress.written} new questions against your notes, kept ${progress.kept}`, {
            status: 'active',
            data: { written: progress.written, kept: progress.kept },
          });
        }
      },
    });
    if (live.closed) return;
    live.step('creating', 'Questions ready', { status: 'done', data: { done: topicsWritten, total: topicsWritten } });
    live.step('reviewing', 'Every answer checked against your notes', { status: 'done', data: { checked: picked.length } });

    if (!picked.length) {
      live.fail("We couldn't make questions from these files. Try another file or difficulty.");
      return;
    }

    const covered = new Set(picked.map(({ item }) => `${item.material}:${item.topicKey}`)).size;
    const repeats = picked.filter(({ item }) => seen.has(String(item._id))).length;
    live.step('balancing', `Spread across ${covered} topics`, {
      status: 'done',
      data: { topics: covered, repeats },
    });

    live.step('assembling', 'Putting your quiz together…', { status: 'active' });
    const sourceName =
      sources.length === 1 ? sources[0].file.name : `${sources.length} files`;
    const quiz = await Quiz.create({
      owner: userId,
      title: title || `${sources.length === 1 ? sources[0].file.name.replace(/\.[^.]+$/, '') : 'Mixed'} Quiz`,
      method: 'ai',
      difficulty,
      types: [...new Set(picked.map(({ item }) => item.type))],
      sourceName,
      files: sources.map((source) => source.file._id),
      settings,
      questions: picked.map(({ item, file }) => ({
        id: crypto.randomUUID(),
        type: item.type,
        prompt: item.prompt,
        choices: item.choices,
        correct: item.correct,
        explanation: item.explanation,
        hint: item.hint,
        image: null,
        choiceImages: [],
        bankItem: item._id,
        fileId: file._id,
        libraryId: file.library,
        quote: item.quote ?? '',
        sourceTitle: file.name,
        pageStart: item.pageStart,
        pageEnd: item.pageEnd,
      })),
    });
    live.step(
      'assembling',
      picked.length < count ? `Made ${picked.length} questions (your files had enough for ${picked.length})` : `Made ${picked.length} questions`,
      { status: 'done', data: { made: picked.length, asked: count } }
    );
    live.send('result', { quiz: toFullQuiz(quiz) });
    live.end();
  } catch (error) {
    if (!stream) return next(error);
    if (stream.closed) return;
    console.error('Quiz generation failed:', error);
    stream.fail('Something went wrong while making your quiz. Please try again.');
  }
};

/** A quiz written by hand or imported from a spreadsheet. */
export const createQuiz = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const body = req.body ?? {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > TITLE_MAX) {
      sendError(res, `Title must be 1 to ${TITLE_MAX} characters`, 400);
      return;
    }
    const method = body.method === 'import' ? 'import' : 'manual';
    const difficulty = body.difficulty ?? 'medium';
    if (!isDifficulty(difficulty)) {
      sendError(res, 'Difficulty must be easy, medium or hard', 400);
      return;
    }
    const questions = readQuestions(body.questions);
    if (typeof questions === 'string') {
      sendError(res, questions, 400);
      return;
    }
    const settings = readSettings(body.settings, DEFAULT_SETTINGS);
    if (typeof settings === 'string') {
      sendError(res, settings, 400);
      return;
    }

    const limit = await canCreate(userId);
    if (limit !== null) {
      planLimit(res, `Your plan allows ${limit} new quizzes a day. Upgrade to create more.`, 'quizCreates');
      return;
    }

    const quiz = await Quiz.create({
      owner: userId,
      title,
      method,
      difficulty,
      types: [...new Set(questions.map((question) => question.type))],
      sourceName: typeof body.sourceName === 'string' ? body.sourceName.trim().slice(0, 200) : method === 'import' ? 'CSV File' : '',
      settings,
      questions,
    });
    sendSuccess(res, { quiz: toFullQuiz(quiz) }, 'Quiz created', 201);
  } catch (error) {
    next(error);
  }
};

// ── One quiz ──────────────────────────────────────────────────────────────────

/** The owner gets everything; anyone else with the link gets it ready to take, without answers. */
export const getQuiz = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const quiz = await findPlayableQuiz(userId, req.params.id);
    if (!quiz) {
      sendError(res, 'Quiz not found', 404);
      return;
    }
    const isOwner = String(quiz.owner) === userId;
    const [attempts, creators, slugs] = await Promise.all([
      QuizAttempt.countDocuments({ quiz: quiz._id, user: userId }),
      creatorsOf([quiz]),
      spaceSlugsOf([quiz]),
    ]);
    const creator = creators.get(String(quiz.owner));
    const spaceSlug = quiz.space ? slugs.get(String(quiz.space)) ?? null : null;
    const allowed = quiz.settings.retakes === null ? null : quiz.settings.retakes + 1;

    sendSuccess(res, {
      quiz: isOwner && req.query.play !== 'true' ? toFullQuiz(quiz, creator, spaceSlug) : toPlayQuiz(quiz, creator),
      isOwner,
      attempts: { used: attempts, allowed, left: allowed === null ? null : Math.max(0, allowed - attempts) },
    });
  } catch (error) {
    next(error);
  }
};

export const updateQuiz = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const quiz = await findOwnQuiz(req.user!.id, req.params.id);
    if (!quiz) {
      sendError(res, 'Quiz not found', 404);
      return;
    }
    const body = req.body ?? {};
    if (body.title !== undefined) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > TITLE_MAX) {
        sendError(res, `Title must be 1 to ${TITLE_MAX} characters`, 400);
        return;
      }
      quiz.title = title;
    }
    if (body.difficulty !== undefined) {
      if (!isDifficulty(body.difficulty)) {
        sendError(res, 'Difficulty must be easy, medium or hard', 400);
        return;
      }
      quiz.difficulty = body.difficulty;
    }
    if (body.settings !== undefined) {
      const settings = readSettings(body.settings, quiz.settings);
      if (typeof settings === 'string') {
        sendError(res, settings, 400);
        return;
      }
      quiz.settings = settings;
    }
    if (body.questions !== undefined) {
      const questions = readQuestions(body.questions, quiz.questions);
      if (typeof questions === 'string') {
        sendError(res, questions, 400);
        return;
      }
      quiz.questions = questions;
      quiz.types = [...new Set(questions.map((question) => question.type))];
    }
    await quiz.save();
    sendSuccess(res, { quiz: toFullQuiz(quiz) }, 'Quiz updated');
  } catch (error) {
    next(error);
  }
};

export const deleteQuiz = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const quiz = await findOwnQuiz(req.user!.id, req.params.id);
    if (!quiz) {
      sendError(res, 'Quiz not found', 404);
      return;
    }
    await QuizAttempt.deleteMany({ quiz: quiz._id });
    await quiz.deleteOne();
    sendSuccess(res, null, 'Quiz deleted');
  } catch (error) {
    next(error);
  }
};

// ── Taking ────────────────────────────────────────────────────────────────────

/** Lets a quiz's owner know someone took it. Takers that day share one notification. */
const tellOwner = async (quiz: IQuiz, takerId: string | null) => {
  const taker = takerId ? await User.findById(takerId).select('firstName').lean() : null;
  const name = taker?.firstName ?? 'Someone';
  await notify(
    [quiz.owner],
    {
      category: 'quizzes',
      kind: 'quiz-taken',
      title: '',
      link: `/quizzes?analytics=${quiz._id}`,
      group: {
        key: `quiz-taken:${quiz._id}`,
        title: (count) => (count === 1 ? `${name} took your quiz` : `${count} people took your quiz`),
        body: () => `"${quiz.title}". See how they did.`,
      },
    },
    { push: true }
  );
};

const toPublicAttempt = (attempt: IQuizAttempt) => ({
  id: attempt._id,
  correct: attempt.correct,
  total: attempt.total,
  score: attempt.score,
  seconds: attempt.seconds,
  createdAt: attempt.createdAt,
});

type Marked = { questionId: string; choice: number | null; correct: boolean };

/** Marks answers sent as `[{ questionId, choice }]` against the quiz. */
const mark = (quiz: IQuiz, input: unknown) => {
  const chosen = new Map<string, number | null>();
  if (Array.isArray(input)) {
    for (const answer of input) {
      if (answer && typeof answer.questionId === 'string') {
        chosen.set(answer.questionId, Number.isInteger(answer.choice) ? answer.choice : null);
      }
    }
  }
  const answers: Marked[] = quiz.questions.map((question) => {
    const choice = chosen.get(question.id) ?? null;
    return { questionId: question.id, choice, correct: choice === question.correct };
  });
  const correct = answers.filter((answer) => answer.correct).length;
  const total = quiz.questions.length;
  return { answers, correct, total, score: total ? Math.round((correct / total) * 100) : 0 };
};

const readSeconds = (value: unknown) => Math.max(0, Math.min(Math.round(Number(value) || 0), 24 * 60 * 60));

/** The marked questions, when the taker may see them. */
const resultsOf = (quiz: IQuiz, answers: Marked[], own: boolean, spaceSlug: string | null = null) =>
  own || quiz.settings.showResults
    ? quiz.questions.map((question, index) => ({
        questionId: question.id,
        choice: answers[index].choice,
        correct: question.correct,
        isCorrect: answers[index].correct,
        explanation: question.explanation,
        // Only the quiz's owner gets links into the notes
        ...(own
          ? evidenceOf(question, spaceSlug)
          : { fileId: null, libraryId: null, pageStart: null, pageEnd: null, quote: '', sourceTitle: '', spaceSlug: null, spaceMaterialId: null }),
      }))
    : null;

/**
 * Hands in an attempt and marks it. Counts toward the daily limit: private for
 * your own quizzes, public for ones others shared.
 */
export const submitAttempt = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const quiz = await findPlayableQuiz(userId, req.params.id);
    if (!quiz) {
      sendError(res, 'Quiz not found', 404);
      return;
    }
    const own = String(quiz.owner) === userId;
    if (!Array.isArray(req.body?.answers)) {
      sendError(res, 'Send your answers', 400);
      return;
    }

    const used = await QuizAttempt.countDocuments({ quiz: quiz._id, user: userId });
    if (quiz.settings.retakes !== null && used >= quiz.settings.retakes + 1) {
      sendError(res, 'You have no attempts left for this quiz', 403, { code: 'NO_ATTEMPTS_LEFT' });
      return;
    }

    const warmup = quiz.method === 'warmup';
    const { allowance, used: today } = await limitsFor(userId);
    const dailyLimit = own ? allowance.privateTakesPerDay : allowance.publicTakesPerDay;
    const dailyUsed = own ? today.privateTakes : today.publicTakes;
    if (!warmup && dailyLimit !== null && dailyUsed >= dailyLimit) {
      planLimit(
        res,
        own
          ? `Your plan allows ${dailyLimit} attempt${dailyLimit === 1 ? '' : 's'} a day at your own quizzes. Upgrade to practise more.`
          : `Your plan allows ${dailyLimit} shared quizzes a day. Upgrade to take more.`,
        own ? 'privateTakes' : 'publicTakes'
      );
      return;
    }

    const marked = mark(quiz, req.body.answers);
    const attempt = await QuizAttempt.create({ quiz: quiz._id, user: userId, own, warmup, ...marked, seconds: readSeconds(req.body?.seconds) });
    void recordActivity(userId, 'quiz');
    // How each topic went, and what that means for the student's path: a
    // warm-up counts toward its course's topics, any other quiz toward its files'
    let topics: Awaited<ReturnType<typeof applyQuizResult>> = [];
    if (warmup) {
      const record = await Warmup.findOneAndUpdate(
        { quiz: quiz._id, user: userId },
        { $set: { status: 'taken', score: marked.score } },
        { new: true }
      );
      const map = record?.course ? await CourseMap.findOne({ space: record.space, course: record.course }).lean() : null;
      if (record && map) {
        topics = (await applyCourseResult(userId, record.space, record.course!, map.topics, quiz, marked.answers)).map((topic) => ({
          ...topic,
          material: '',
        }));
      }
    } else {
      topics = await applyQuizResult(userId, quiz, marked.answers);
    }
    if (!own) void tellOwner(quiz, userId);
    const spaceSlug = quiz.space ? (await Space.findById(quiz.space).select('slug').lean())?.slug ?? null : null;

    sendSuccess(
      res,
      {
        attempt: toPublicAttempt(attempt),
        showResults: own || quiz.settings.showResults,
        results: resultsOf(quiz, marked.answers, own, spaceSlug),
        attemptsLeft: quiz.settings.retakes === null ? null : Math.max(0, quiz.settings.retakes - used),
        topics,
      },
      'Quiz submitted',
      201
    );
  } catch (error) {
    next(error);
  }
};

/** Your own attempts at a quiz, newest first. */
export const listAttempts = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const quiz = await findPlayableQuiz(req.user!.id, req.params.id);
    if (!quiz) {
      sendError(res, 'Quiz not found', 404);
      return;
    }
    const attempts = await QuizAttempt.find({ quiz: quiz._id, user: req.user!.id }).sort({ createdAt: 1 });
    sendSuccess(res, { attempts: attempts.map((attempt, index) => toHistoryAttempt(attempt, index + 1)).reverse() });
  } catch (error) {
    next(error);
  }
};

/**
 * Who took a quiz you shared, for the analytics screen: each person's best
 * attempt, how many tries, and which questions they got right. Guests who
 * haven't signed up show with no name.
 */
export const listParticipants = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const quiz = await findOwnQuiz(req.user!.id, req.params.id);
    if (!quiz) {
      sendError(res, 'Quiz not found', 404);
      return;
    }
    const attempts = await QuizAttempt.find({ quiz: quiz._id, own: false }).sort({ createdAt: 1 }).lean<IQuizAttempt[]>();
    const byPerson = new Map<string, IQuizAttempt[]>();
    for (const attempt of attempts) {
      const key = attempt.user ? `u:${attempt.user}` : `g:${attempt.guestId}`;
      if (!byPerson.has(key)) byPerson.set(key, []);
      byPerson.get(key)!.push(attempt);
    }
    const userIds = attempts.map((attempt) => attempt.user).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName email').lean();
    const userById = new Map(users.map((user) => [String(user._id), user]));
    const order = quiz.questions.map((question) => question.id);

    const participants = [...byPerson.entries()].map(([key, tries]) => {
      // Best score wins; on a tie, the faster one
      const best = tries.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.seconds < a.seconds) ? b : a));
      const latest = tries[tries.length - 1];
      const user = latest.user ? userById.get(String(latest.user)) : null;
      const right = new Map(best.answers.map((answer) => [answer.questionId, answer.correct]));
      return {
        id: key,
        name: user ? `${user.firstName} ${user.lastName ?? ''}`.trim() : null,
        email: user?.email ?? null,
        correct: best.correct,
        total: best.total,
        seconds: best.seconds,
        attempts: tries.length,
        submittedAt: latest.createdAt,
        answers: order.map((questionId) => right.get(questionId) ?? false),
        latestScore: latest.score,
      };
    });

    sendSuccess(res, {
      prompts: quiz.questions.map((question) => question.prompt),
      participants: participants.sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime()),
    });
  } catch (error) {
    next(error);
  }
};

// ── The public link: no account needed ────────────────────────────────────────

const GUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const findPublicQuiz = async (id: unknown) => {
  if (!isId(id)) return null;
  const quiz = await Quiz.findById(id);
  return quiz && quiz.settings.visibility === 'anyone' ? quiz : null;
};

/** A shared quiz for anyone with the link, ready to take: no answers. */
export const getPublicQuiz = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const quiz = await findPublicQuiz(req.params.id);
    if (!quiz) {
      sendError(res, 'Quiz not found', 404);
      return;
    }
    const creators = await creatorsOf([quiz]);
    sendSuccess(res, { quiz: toPlayQuiz(quiz, creators.get(String(quiz.owner))) });
  } catch (error) {
    next(error);
  }
};

/**
 * A guest hands in an attempt. It's marked and saved (so the quiz owner sees
 * it). The guest gets their score and a claim token, but not the answers: they
 * see those once they sign up and claim the attempt.
 */
export const submitGuestAttempt = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const quiz = await findPublicQuiz(req.params.id);
    if (!quiz) {
      sendError(res, 'Quiz not found', 404);
      return;
    }
    const guestId = typeof req.body?.guestId === 'string' ? req.body.guestId : '';
    if (!GUEST_ID.test(guestId)) {
      sendError(res, 'guestId must be 8 to 64 letters, numbers, - or _', 400);
      return;
    }
    if (!Array.isArray(req.body?.answers)) {
      sendError(res, 'Send your answers', 400);
      return;
    }
    const used = await QuizAttempt.countDocuments({ quiz: quiz._id, guestId });
    if (quiz.settings.retakes !== null && used >= quiz.settings.retakes + 1) {
      sendError(res, 'You have no attempts left for this quiz', 403, { code: 'NO_ATTEMPTS_LEFT' });
      return;
    }

    const claimToken = crypto.randomBytes(24).toString('hex');
    const attempt = await QuizAttempt.create({
      quiz: quiz._id,
      user: null,
      guestId,
      claimToken,
      own: false,
      ...mark(quiz, req.body.answers),
      seconds: readSeconds(req.body?.seconds),
    });
    void tellOwner(quiz, null);
    // The score is shown blurred until they sign up; answers stay hidden
    sendSuccess(res, { attempt: toPublicAttempt(attempt), claimToken }, 'Sign up to see your answers', 201);
  } catch (error) {
    next(error);
  }
};

/**
 * After signing up, a guest attaches their attempt to their new account and
 * gets the result they earned. Doesn't count toward the daily limit.
 */
export const claimAttempt = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const token = typeof req.body?.claimToken === 'string' ? req.body.claimToken : '';
    const attempt = isId(req.params.attemptId)
      ? await QuizAttempt.findOne({ _id: req.params.attemptId, user: null }).select('+claimToken')
      : null;
    const valid =
      attempt?.claimToken &&
      token.length === attempt.claimToken.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(attempt.claimToken));
    const quiz = valid ? await Quiz.findById(attempt.quiz) : null;
    if (!attempt || !valid || !quiz) {
      sendError(res, 'Attempt not found', 404);
      return;
    }

    const own = String(quiz.owner) === userId;
    attempt.set({ user: userId, own, guestId: null, claimToken: null });
    await attempt.save();
    await applyQuizResult(userId, quiz, attempt.answers);
    void recordActivity(userId, 'quiz');
    sendSuccess(res, {
      quizId: quiz._id,
      attempt: toPublicAttempt(attempt),
      showResults: own || quiz.settings.showResults,
      results: resultsOf(quiz, attempt.answers, own),
    });
  } catch (error) {
    next(error);
  }
};
