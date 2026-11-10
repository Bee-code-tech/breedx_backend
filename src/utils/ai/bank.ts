import { Types } from 'mongoose';
import env from '../../config/env';
import { BACKGROUND_ENGINE } from '../../config/models';
import FlashcardBankItem from '../../models/flashcardBankItem.model';
import MaterialChunk from '../../models/materialChunk.model';
import QuizBankItem from '../../models/quizBankItem.model';
import { ILibraryFile, IMaterial, TopicMap } from '../../types/library';
import {
  BankPlace,
  Difficulty,
  IFlashcardBankItem,
  IQuizBankItem,
  QuestionType,
  TRUE_FALSE,
} from '../../types/quiz';
import { recordUsage } from './energy';
import { addTokens, generateJson, TokenCount, ZERO_TOKENS } from './vertex';

// Most text from one topic sent when writing its questions
const CONTEXT_CHARS = 14_000;
// Topics shorter than this don't have enough to ask about
const MIN_CONTEXT_CHARS = 250;
// The bank stops growing at this many items per topic and difficulty; after that it's reused
const BANK_CAP = 24;
// Fewest items written per call, so the bank fills in useful batches
const MIN_BATCH = 4;
const MAX_BATCH = 12;
const PARALLEL = 3;

export interface Topic {
  key: string;
  chapterTitle: string;
  topicTitle: string;
  pageStart: number;
  pageEnd: number;
  concepts: string[];
}

/** Every topic in a material's map. A chapter without topics counts as one topic. */
export const topicsOf = (map: TopicMap | null): Topic[] =>
  (map?.chapters ?? []).flatMap((chapter, c) =>
    chapter.topics.length
      ? chapter.topics.map((topic, t) => ({
          key: `c${c}t${t}`,
          chapterTitle: chapter.title,
          topicTitle: topic.title,
          pageStart: topic.startPage,
          pageEnd: topic.endPage,
          concepts: topic.concepts,
        }))
      : [
          {
            key: `c${c}t-`,
            chapterTitle: chapter.title,
            topicTitle: chapter.title,
            pageStart: chapter.startPage,
            pageEnd: chapter.endPage,
            concepts: [],
          },
        ]
  );

/** The text of a topic's pages, in order, cut to a size the AI reads well. */
const contextOf = async (materialId: Types.ObjectId, topic: Topic) => {
  const chunks = await MaterialChunk.find({
    material: materialId,
    pageStart: { $lte: topic.pageEnd },
    pageEnd: { $gte: topic.pageStart },
  })
    .sort({ index: 1 })
    .select('text')
    .lean();
  return chunks.map((chunk) => chunk.text).join('\n\n').slice(0, CONTEXT_CHARS);
};

const LEVELS: Record<Difficulty, string> = {
  easy: 'easy: recall of key definitions and facts',
  medium: 'medium: understanding and applying ideas, small calculations',
  hard: 'hard: analysis, multi-step reasoning and close distractors',
};

const placeOf = (materialId: Types.ObjectId, topic: Topic): BankPlace => ({
  material: materialId,
  topicKey: topic.key,
  chapterTitle: topic.chapterTitle,
  topicTitle: topic.topicTitle,
  pageStart: topic.pageStart,
  pageEnd: topic.pageEnd,
});

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, ok: { type: 'boolean' } },
        required: ['n', 'ok'],
      },
    },
  },
  required: ['verdicts'],
};

/**
 * The check pass: a second read that keeps only items whose marked answer the
 * notes clearly support, with exactly one right option and a clear wording.
 */
const keepVerified = async (
  context: string,
  numbered: string,
  count: number,
  strict = false
): Promise<{ keep: Set<number>; tokens: TokenCount }> => {
  try {
    const { data, tokens } = await generateJson<{ verdicts: { n: number; ok: boolean }[] }>({
      engine: BACKGROUND_ENGINE,
      temperature: 0,
      json: VERDICT_SCHEMA,
      system:
        'You check study questions against the notes they were written from. Mark an item ok only if: the marked answer ' +
        'is correct according to the notes, exactly one option is right, and the wording is clear and fair. Be strict.' +
        (strict
          ? ' Also reject any question that common sense or general knowledge alone could answer without studying these notes, ' +
            'and any that only copies a sentence from the notes into a blank.'
          : ''),
      prompt: `Notes:\n${context}\n\nItems to check (the marked answer is after →):\n${numbered}\n\nGive a verdict for every item, n from 1 to ${count}.`,
    });
    return { keep: new Set(data.verdicts.filter((verdict) => verdict.ok).map((verdict) => verdict.n)), tokens };
  } catch (error) {
    // If the check itself fails, nothing is kept: a wrong answer costs more trust than a missing question
    console.error('Bank check failed:', (error as Error).message);
    return { keep: new Set(), tokens: ZERO_TOKENS };
  }
};

// ── Quiz questions ────────────────────────────────────────────────────────────

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['mcqs', 'true-false'] },
          prompt: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' } },
          correct: { type: 'integer' },
          explanation: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['type', 'prompt', 'choices', 'correct', 'explanation', 'hint'],
      },
    },
  },
  required: ['questions'],
};

interface RawQuestion {
  type: QuestionType;
  prompt: string;
  choices: string[];
  correct: number;
  explanation: string;
  hint: string;
}

/** Fixes small slips and drops questions that can't be played. */
const cleanQuestion = (raw: RawQuestion, types: QuestionType[]): RawQuestion | null => {
  const prompt = String(raw.prompt ?? '').trim();
  if (!prompt || !types.includes(raw.type)) return null;
  if (raw.type === 'true-false') {
    const correct = Number(raw.correct);
    return correct === 0 || correct === 1
      ? { ...raw, prompt, choices: [...TRUE_FALSE], correct, explanation: String(raw.explanation ?? '').trim(), hint: String(raw.hint ?? '').trim() }
      : null;
  }
  const choices = (raw.choices ?? []).map((choice) => String(choice).trim());
  const correct = Number(raw.correct);
  const unique = new Set(choices.map((choice) => choice.toLowerCase()));
  if (choices.length < 3 || choices.length > 5 || unique.size !== choices.length || choices.some((choice) => !choice)) return null;
  if (!Number.isInteger(correct) || correct < 0 || correct >= choices.length) return null;
  return { ...raw, prompt, choices, correct, explanation: String(raw.explanation ?? '').trim(), hint: String(raw.hint ?? '').trim() };
};

const writeQuestions = async (
  materialId: Types.ObjectId,
  topic: Topic,
  difficulty: Difficulty,
  types: QuestionType[],
  count: number
): Promise<{ written: number; kept: number; tokens: TokenCount }> => {
  const context = await contextOf(materialId, topic);
  if (context.length < MIN_CONTEXT_CHARS) return { written: 0, kept: 0, tokens: ZERO_TOKENS };

  const kinds =
    types.length === 2
      ? 'Mostly multiple choice, with about one in four true/false.'
      : types[0] === 'true-false'
        ? 'All true/false.'
        : 'All multiple choice.';

  const { data, tokens } = await generateJson<{ questions: RawQuestion[] }>({
    engine: BACKGROUND_ENGINE,
    temperature: 0.7,
    json: QUESTION_SCHEMA,
    system:
      "You write exam-style questions for university students from their own course notes. Every question must be answerable from the notes alone. " +
      'Multiple choice ("mcqs"): 4 options, exactly one correct, and wrong options that are plausible because they match common mistakes. ' +
      'True/false ("true-false"): choices ["True","False"]; correct is 0 for True, 1 for False. `correct` is the index of the right option. ' +
      'Never write "all/none of the above", never mention "the notes", "the text" or page numbers in a question. ' +
      'The explanation says in one or two sentences why the answer is right. The hint nudges without giving the answer away.',
    prompt:
      `Topic: ${topic.chapterTitle} › ${topic.topicTitle}` +
      (topic.concepts.length ? `\nKey concepts: ${topic.concepts.join(', ')}` : '') +
      `\nDifficulty: ${LEVELS[difficulty]}\n${kinds}\nWrite ${count} different questions.\n\nNotes:\n${context}`,
  });

  const questions = (data.questions ?? []).map((raw) => cleanQuestion(raw, types)).filter((q): q is RawQuestion => Boolean(q));
  if (!questions.length) return { written: 0, kept: 0, tokens };

  const numbered = questions
    .map((q, i) => `${i + 1}. ${q.prompt}\n${q.choices.map((choice, c) => `   ${String.fromCharCode(65 + c)}) ${choice}`).join('\n')}\n   → ${String.fromCharCode(65 + q.correct)}`)
    .join('\n');
  const check = await keepVerified(context, numbered, questions.length);

  const kept = questions.filter((_, i) => check.keep.has(i + 1));
  if (kept.length) {
    await QuizBankItem.insertMany(kept.map((q) => ({ ...placeOf(materialId, topic), ...q, difficulty })));
  }
  return { written: questions.length, kept: kept.length, tokens: addTokens(tokens, check.tokens) };
};

// ── Deep questions (warm-ups) ─────────────────────────────────────────────────

// Course questions are written by the stronger model and checked by the cheap one
const DEEP_ENGINE = { model: env.AI_ENGINE_BALANCED, thinkingBudget: 0 };
// Evidence shorter than this can't really prove an answer
const MIN_QUOTE = 25;
const SKILLS = ['define', 'apply', 'why', 'predict', 'spot-error', 'compare', 'calculate'] as const;

const DEEP_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['mcqs', 'true-false'] },
          skill: { type: 'string', enum: [...SKILLS] },
          prompt: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' } },
          correct: { type: 'integer' },
          explanation: { type: 'string' },
          hint: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['type', 'skill', 'prompt', 'choices', 'correct', 'explanation', 'hint', 'quote'],
      },
    },
  },
  required: ['questions'],
};

/** Collapses spacing, case and quote marks, so an exact quote still matches across line breaks. */
const squash = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‘’‛`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

/** True when the quote really appears, word for word, in the notes. */
const quoted = (quote: string, context: string) => {
  const needle = squash(quote).replace(/^["']|["'.]$/g, '');
  return needle.length >= MIN_QUOTE && squash(context).includes(needle);
};

const looksLikePastQuestions = (name: string) => /past|pq|exam|question|test/i.test(name);

/**
 * Writes questions that test understanding, from one topic of one course
 * material: applying ideas, explaining why, predicting results, spotting
 * mistakes, comparing and calculating. Each carries the exact words in the
 * notes that prove it; a question whose quote isn't really there, or that
 * common sense alone could answer, is dropped.
 */
const writeDeepQuestions = async (
  materialId: Types.ObjectId,
  topic: Topic,
  count: number,
  fileName: string
): Promise<{ written: number; kept: number; tokens: TokenCount }> => {
  const context = await contextOf(materialId, topic);
  if (context.length < MIN_CONTEXT_CHARS) return { written: 0, kept: 0, tokens: ZERO_TOKENS };
  const pastPapers = looksLikePastQuestions(fileName);

  const { data, tokens } = await generateJson<{ questions: (RawQuestion & { skill: string; quote: string })[] }>({
    engine: DEEP_ENGINE,
    temperature: 0.6,
    json: DEEP_SCHEMA,
    system:
      "You are a demanding university lecturer writing a pre-class quiz from this course's own materials. " +
      'Test understanding, not memory. Of every 10 questions write at most 2 that ask for a definition ("define"); the rest must ' +
      'apply an idea to a new case ("apply"), ask why something is true ("why"), predict a result ("predict"), find the flaw in a ' +
      'claim or working ("spot-error"), contrast two ideas ("compare") or need a short calculation ("calculate"). ' +
      "Use the course's own terms, notation, formulas and worked examples, so a student who studied this course has an edge over " +
      'someone using general knowledge. A question must not be answerable by common sense alone, and must not just copy a sentence ' +
      'from the notes into a blank. Medium difficulty: a student who understood the topic should get it right in under a minute. ' +
      'Multiple choice ("mcqs"): 4 options, exactly one right; every wrong option is a mistake students really make. ' +
      'True/false ("true-false"): choices ["True","False"], correct 0 for True and 1 for False, used for subtle claims only. ' +
      '`correct` is the index of the right option. Never write "all/none of the above"; never mention "the notes", "the text" or pages. ' +
      'The explanation says why the answer is right and why the tempting wrong option is wrong. The hint nudges without giving it away. ' +
      'Write maths in plain text the way it reads on a phone (O(n log n), x^2, n - 1), never LaTeX or $ signs. ' +
      '`quote` is one or two sentences copied EXACTLY, word for word, from the notes, that prove the answer.' +
      (pastPapers ? ' These materials include past exam questions: write in the same style and wording as those questions.' : ''),
    prompt:
      `Course topic: ${topic.chapterTitle} › ${topic.topicTitle}` +
      (topic.concepts.length ? `\nKey concepts: ${topic.concepts.join(', ')}` : '') +
      `\nMostly multiple choice, about one in five true/false.\nWrite ${count} different questions.\n\nMaterial "${fileName}":\n${context}`,
  });

  const questions = (data.questions ?? [])
    .map((raw) => {
      const clean = cleanQuestion(raw, ['mcqs', 'true-false']);
      if (!clean || !quoted(String(raw.quote ?? ''), context)) return null;
      return { ...clean, quote: String(raw.quote).trim(), skill: SKILLS.includes(raw.skill as never) ? raw.skill : 'apply' };
    })
    .filter((question): question is RawQuestion & { quote: string; skill: string } => Boolean(question));
  if (!questions.length) return { written: data.questions?.length ?? 0, kept: 0, tokens };

  const numbered = questions
    .map(
      (q, i) =>
        `${i + 1}. ${q.prompt}\n${q.choices.map((choice, c) => `   ${String.fromCharCode(65 + c)}) ${choice}`).join('\n')}\n   → ${String.fromCharCode(65 + q.correct)}`
    )
    .join('\n');
  const check = await keepVerified(context, numbered, questions.length, true);
  const kept = questions.filter((_, i) => check.keep.has(i + 1));
  if (kept.length) {
    await QuizBankItem.insertMany(kept.map((q) => ({ ...placeOf(materialId, topic), ...q, difficulty: 'medium', depth: 'deep' })));
  }
  return { written: data.questions?.length ?? 0, kept: kept.length, tokens: addTokens(tokens, check.tokens) };
};

// ── Flashcards ────────────────────────────────────────────────────────────────

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          front: { type: 'string' },
          a1: { type: 'string' },
          a2: { type: 'string' },
          correct: { type: 'integer' },
          answer: { type: 'string' },
        },
        required: ['front', 'a1', 'a2', 'correct', 'answer'],
      },
    },
  },
  required: ['cards'],
};

interface RawCard {
  front: string;
  a1: string;
  a2: string;
  correct: 1 | 2;
  answer: string;
}

const writeCards = async (
  materialId: Types.ObjectId,
  topic: Topic,
  difficulty: Difficulty,
  count: number,
  focus: string
): Promise<{ written: number; kept: number; tokens: TokenCount }> => {
  const context = await contextOf(materialId, topic);
  if (context.length < MIN_CONTEXT_CHARS) return { written: 0, kept: 0, tokens: ZERO_TOKENS };

  const { data, tokens } = await generateJson<{ cards: RawCard[] }>({
    engine: BACKGROUND_ENGINE,
    temperature: 0.7,
    json: CARD_SCHEMA,
    system:
      'You write short active-recall flashcards for university students from their own course notes. ' +
      'Each front is ONE brief question or cue a student can answer in a few words — definition ("What is X?"), ' +
      'formula ("Write the formula for X"), cause/effect ("What happens if…?"), naming ("Name the…"), or fill-in-the-blank. ' +
      'Never write essay prompts such as "explain", "discuss", "describe in detail", "outline", or "compare and contrast". ' +
      'Keep front under 140 characters. a1 and a2 are two short answers (under 80 characters each): one correct, ' +
      'one a believable mix-up of a related concept from the same notes; `correct` is 1 or 2 (mix which side is right). ' +
      'answer is a 1–3 sentence explanation with a formula or tiny example when useful. ' +
      'Everything must come from the notes. Never mention "the notes" or page numbers.',
    prompt:
      `Topic: ${topic.chapterTitle} › ${topic.topicTitle}` +
      (topic.concepts.length ? `\nKey concepts: ${topic.concepts.join(', ')}` : '') +
      (focus ? `\nThe student wants to focus on: ${focus}` : '') +
      `\nDifficulty: ${LEVELS[difficulty]}\nWrite ${count} different active-recall flashcards.\n\nNotes:\n${context}`,
  });

  const cards = (data.cards ?? [])
    .map((card) => ({
      front: String(card.front ?? '').trim().slice(0, 140),
      a1: String(card.a1 ?? '').trim().slice(0, 80),
      a2: String(card.a2 ?? '').trim().slice(0, 80),
      correct: Number(card.correct) === 2 ? 2 : 1,
      answer: String(card.answer ?? '').trim(),
    }))
    .filter((card) => card.front && card.a1 && card.a2 && card.a1.toLowerCase() !== card.a2.toLowerCase()) as RawCard[];
  if (!cards.length) return { written: 0, kept: 0, tokens };

  const numbered = cards
    .map((card, i) => `${i + 1}. ${card.front}\n   A) ${card.a1}\n   B) ${card.a2}\n   → ${card.correct === 1 ? 'A' : 'B'}`)
    .join('\n');
  const check = await keepVerified(context, numbered, cards.length);

  const kept = cards.filter((_, i) => check.keep.has(i + 1));
  if (kept.length) {
    await FlashcardBankItem.insertMany(kept.map((card) => ({ ...placeOf(materialId, topic), ...card, difficulty })));
  }
  return { written: cards.length, kept: kept.length, tokens: addTokens(tokens, check.tokens) };
};

// ── Picking ───────────────────────────────────────────────────────────────────

export interface Source {
  material: IMaterial;
  file: ILibraryFile;
}

/** How many items to take from one topic of one file. */
export interface Slot {
  source: Source;
  topic: Topic;
  need: number;
}

/**
 * Spreads `count` items over every topic of every file, so a quiz covers the
 * whole material instead of the first chapter. With fewer items than topics,
 * topics are taken evenly from start to end.
 */
const allocate = (sources: Source[], count: number): Slot[] => {
  const all = sources.flatMap((source) => topicsOf(source.material.map).map((topic) => ({ source, topic, need: 0 })));
  if (!all.length) return [];
  const chosen =
    count >= all.length ? all : Array.from({ length: count }, (_, i) => all[Math.floor((i * all.length) / count)]);
  for (let i = 0; i < count; i++) chosen[i % chosen.length].need++;
  return chosen;
};

const shuffle = <T>(items: T[]): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

/** Recall questions go after understanding ones, so a quiz uses them only to fill gaps. */
const definitionsLast = <T>(items: T[]): T[] => [
  ...items.filter((item) => (item as { skill?: string }).skill !== 'define'),
  ...items.filter((item) => (item as { skill?: string }).skill === 'define'),
];

export interface PickProgress {
  stage: 'creating' | 'reviewing';
  done: number;
  total: number;
  written: number;
  kept: number;
  /** The topic that just finished, for the live steps. */
  topic?: string;
}

interface PickOptions {
  /** Understanding-first questions (warm-ups), written by the stronger model. */
  deep?: boolean;
  userId: string;
  sources: Source[];
  count: number;
  difficulty: Difficulty;
  /** Bank items the student has already had, used only when nothing new is left. */
  seen: Set<string>;
  onProgress?: (progress: PickProgress) => void;
  /** Exact topics to take from (e.g. one topic for a warm-up). Without it, `count` is spread over every topic. */
  slots?: Slot[];
  /** Keep at least this many items in each topic's bank, so retries get fresh ones. */
  minBank?: number;
}

/**
 * Fills each topic's slot from the bank, writing and checking new items only
 * where the bank runs short. Writing is free for the student; it's logged as
 * ours. Returns the picked items with the file each came from.
 */
const pick = async <T extends IQuizBankItem | IFlashcardBankItem>(
  options: PickOptions,
  find: (slot: Slot) => Promise<T[]>,
  write: (slot: Slot, count: number) => Promise<{ written: number; kept: number; tokens: TokenCount }>,
  feature: 'quiz' | 'flashcards'
): Promise<{ item: T; file: ILibraryFile }[]> => {
  const slots = options.slots ?? allocate(options.sources, options.count);
  const progress: PickProgress = { stage: 'creating', done: 0, total: slots.length, written: 0, kept: 0 };
  const picked: { item: T; file: ILibraryFile }[] = [];

  const fill = async (slot: Slot) => {
    let bank = await find(slot);
    const fresh = bank.filter((item) => !options.seen.has(String(item._id)));
    const short = Math.max(slot.need - fresh.length, (options.minBank ?? 0) - bank.length);
    if (short > 0 && bank.length < BANK_CAP) {
      const count = Math.min(MAX_BATCH, Math.max(MIN_BATCH, short), BANK_CAP - bank.length);
      try {
        const result = await write(slot, count);
        progress.written += result.written;
        progress.kept += result.kept;
        await recordUsage({
          userId: options.userId,
          feature,
          // Deep questions are written by the stronger model (and checked by the cheap one)
          engine: options.deep ? DEEP_ENGINE.model : BACKGROUND_ENGINE.model,
          tokens: result.tokens,
          material: slot.source.material._id as Types.ObjectId,
        });
        if (result.kept) bank = await find(slot);
      } catch (error) {
        console.error(`Writing ${feature} for ${slot.topic.topicTitle} failed:`, (error as Error).message);
      }
    }
    // New items first, then ones the student has had before
    const ordered = [
      ...definitionsLast(shuffle(bank.filter((item) => !options.seen.has(String(item._id))))),
      ...definitionsLast(shuffle(bank.filter((item) => options.seen.has(String(item._id))))),
    ];
    picked.push(...ordered.slice(0, slot.need).map((item) => ({ item, file: slot.source.file })));
    progress.done++;
    options.onProgress?.({ ...progress, topic: slot.topic.topicTitle, stage: progress.done === progress.total ? 'reviewing' : 'creating' });
  };

  for (let i = 0; i < slots.length; i += PARALLEL) {
    await Promise.all(slots.slice(i, i + PARALLEL).map(fill));
  }

  // Keep the material's order: earlier topics first
  const order = new Map(slots.map((slot, index) => [`${slot.source.material._id}:${slot.topic.key}`, index]));
  return picked.sort(
    (a, b) =>
      (order.get(`${a.item.material}:${a.item.topicKey}`) ?? 0) - (order.get(`${b.item.material}:${b.item.topicKey}`) ?? 0)
  );
};

export const pickQuestions = (options: PickOptions & { types: QuestionType[] }) =>
  pick<IQuizBankItem>(
    options,
    async (slot) => {
      if (!options.deep) {
        return QuizBankItem.find({
          material: slot.source.material._id,
          topicKey: slot.topic.key,
          difficulty: options.difficulty,
          type: { $in: options.types },
          depth: { $ne: 'deep' },
        });
      }
      // Understanding first: definition questions only fill in when nothing else is left
      const items = await QuizBankItem.find({ material: slot.source.material._id, topicKey: slot.topic.key, depth: 'deep' });
      return [...items.filter((item) => item.skill !== 'define'), ...items.filter((item) => item.skill === 'define')];
    },
    (slot, count) =>
      options.deep
        ? writeDeepQuestions(slot.source.material._id as Types.ObjectId, slot.topic, count, slot.source.file.name)
        : writeQuestions(slot.source.material._id as Types.ObjectId, slot.topic, options.difficulty, options.types, count),
    'quiz'
  );

export const pickCards = (options: PickOptions & { focus: string }) =>
  pick<IFlashcardBankItem>(
    options,
    (slot) =>
      FlashcardBankItem.find({
        material: slot.source.material._id,
        topicKey: slot.topic.key,
        difficulty: options.difficulty,
      }),
    (slot, count) => writeCards(slot.source.material._id as Types.ObjectId, slot.topic, options.difficulty, count, options.focus),
    'flashcards'
  );
