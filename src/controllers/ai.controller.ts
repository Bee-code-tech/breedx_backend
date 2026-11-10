import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import env from '../config/env';
import { AI_MODELS, AiModelId, DEFAULT_MODEL, engineFor, isModelId } from '../config/models';
import MaterialChunk from '../models/materialChunk.model';
import User from '../models/user.model';
import { IUser } from '../types/user';
import { aboutStudent } from '../utils/ai/ask';
import { generateStream, TokenCount } from '../utils/ai/vertex';
import { activePlan } from '../utils/plan';
import { notify } from '../utils/notify';
import { speak, speakable, SPEECH_MAX_CHARS, speechThisMonth, VOICES, VoiceId } from '../utils/speech';
import { readObject } from '../utils/storage';
import { recordActivity } from '../utils/activity';
import LibraryFile from '../models/libraryFile.model';
import Material from '../models/material.model';
import { AuthRequest } from '../types/auth';
import { ILibraryFile, IMaterial } from '../types/library';
import { checkModel, energyFor, modelsFor, recordUsage } from '../utils/ai/energy';
import { prepareAll } from '../utils/ai/prepare';
import { describeScope, readySources, resolveScope, toPrepare, unitsOf } from '../utils/ai/scope';
import { searchChunks } from '../utils/ai/search';
import { sendError, sendSuccess } from '../utils/response';
import { openStream, Stream } from '../utils/sse';

const QUERY_MAX = 500;
const FIND_DEFAULT = 8;
const FIND_MAX = 20;

const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);

const idList = (value: unknown): string[] | null => {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value.filter(isId) : [];
};

// ── Energy and models ─────────────────────────────────────────────────────────

export const getUsage = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, await energyFor(req.user!.id));
  } catch (error) {
    next(error);
  }
};

export const listModels = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { plan } = await energyFor(req.user!.id);
    sendSuccess(res, { models: await modelsFor(req.user!.id, plan), defaultModel: DEFAULT_MODEL[plan] });
  } catch (error) {
    next(error);
  }
};

// ── Find ──────────────────────────────────────────────────────────────────────

/**
 * Searches the student's files by meaning ("where is recursion explained?").
 * Streams thought steps, then a `result` event. Free: costs no energy.
 */
export type FindResult = {
  fileId: unknown;
  spaceSlug: string | null;
  spaceMaterialId: unknown;
  fileName: string;
  libraryId: unknown;
  libraryName: string;
  pageStart: number;
  pageEnd: number;
  unit: string;
  chapter: string;
  topic: string;
  text: string;
  score: number;
};

/**
 * The search itself, shared by a one-off Find and a saved Find session: reads
 * any files not read yet (streaming the steps), searches by meaning and
 * returns the matches. The caller sends them on and ends the stream.
 */
export const runFind = async (
  stream: Stream,
  userId: string,
  scopeOptions: Parameters<typeof resolveScope>[1],
  query: string,
  limit: number
): Promise<{ results: FindResult[]; message?: string } | null> => {
  const scope = await resolveScope(userId, scopeOptions);
  if (!scope.byMaterial.size) return { results: [], message: 'Add some files to your libraries to search them.' };

  stream.step('scope', `Looking through ${describeScope(scope)}…`, { status: 'done' });
  const ready = await prepareAll(stream, userId, toPrepare(scope));
  if (stream.closed) return null;
  if (!ready.size) return { results: [], message: 'None of these files could be read yet.' };

  stream.step('search', 'Searching by meaning…', { status: 'active' });
  const { hits, tokens } = await searchChunks(query, [...ready].map((id) => new Types.ObjectId(id)), limit, stream.signal);
  await recordUsage({ userId, feature: 'find', engine: env.AI_EMBED_MODEL, tokens });
  const units = await unitsOf([...ready]);
  const { byMaterial, libraryNames } = scope;

  const results = hits.map((hit) => {
    const file = byMaterial.get(String(hit.material))!;
    return {
      fileId: file._id,
      // Course materials open in their space: /spaces/:spaceSlug/materials/:spaceMaterialId
      spaceSlug: file.spaceSlug ?? null,
      spaceMaterialId: file.spaceSlug ? file._id : null,
      fileName: file.name,
      libraryId: file.library,
      libraryName: libraryNames.get(String(file.library)) ?? '',
      pageStart: hit.pageStart,
      pageEnd: hit.pageEnd,
      unit: units.get(String(hit.material)) ?? 'page',
      chapter: hit.chapterTitle,
      topic: hit.topicTitle,
      text: hit.text,
      score: Number(hit.score.toFixed(3)),
    };
  });
  stream.step('search', results.length ? `Found ${results.length} match${results.length === 1 ? '' : 'es'}` : 'No matches found', {
    status: 'done',
  });
  return { results };
};

export const FIND_LIMITS = { default: FIND_DEFAULT, max: FIND_MAX, queryMax: QUERY_MAX };

export const find = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const userId = req.user!.id;
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  const libraryIds = idList(req.body?.libraryIds);
  const fileIds = idList(req.body?.fileIds);
  // A space's course materials: the whole space, or some courses or materials in it
  const space = isId(req.body?.spaceId)
    ? { id: req.body.spaceId as string, courseIds: idList(req.body?.courseIds), materialIds: idList(req.body?.spaceMaterialIds) }
    : null;
  const limit = Math.min(Math.max(Number(req.body?.limit) || FIND_DEFAULT, 1), FIND_MAX);

  if (query.length < 2 || query.length > QUERY_MAX) {
    sendError(res, `Search for 2 to ${QUERY_MAX} characters`, 400);
    return;
  }

  let stream: Stream | null = null;
  try {
    stream = openStream(req, res);
    const found = await runFind(stream, userId, { libraryIds, fileIds, space }, query, limit);
    if (!found || stream.closed) return;
    stream.send('result', found);
    stream.end();
  } catch (error) {
    if (!stream) return next(error);
    if (stream.closed) return;
    console.error('Find failed:', error);
    stream.fail('Search failed. Please try again.');
  }
};

// ── One file ──────────────────────────────────────────────────────────────────

const findOwnFile = (userId: string, fileId: unknown) =>
  isId(fileId) ? LibraryFile.findOne({ _id: fileId, owner: userId, status: 'ready' }).lean<ILibraryFile>() : null;

const toPublicMaterial = (material: IMaterial | null) => ({
  status: material?.status ?? 'stored',
  pageCount: material?.pageCount ?? null,
  unit: material?.pageUnit ?? 'page',
  map: material?.status === 'ready' ? material.map : null,
  error: material?.status === 'failed' ? material.error : null,
});

/** Whether the AI has read a file yet, and its topic map once it has. */
export const getFileAi = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const file = await findOwnFile(req.user!.id, req.params.fileId);
    if (!file) {
      sendError(res, 'File not found', 404);
      return;
    }
    const material = await Material.findById(file.material).lean<IMaterial>();
    sendSuccess(res, toPublicMaterial(material));
  } catch (error) {
    next(error);
  }
};

/**
 * Reads a file now so the first question about it is instant. Streams the
 * same steps as Find, then a `result` event with the topic map. Free.
 */
export const prepareFile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  let stream: Stream | null = null;
  try {
    const file = await findOwnFile(req.user!.id, req.params.fileId);
    if (!file) {
      sendError(res, 'File not found', 404);
      return;
    }
    const material = await Material.findById(file.material).select('status').lean<IMaterial>();

    stream = openStream(req, res);
    await prepareAll(stream, req.user!.id, [{ material: String(file.material), name: file.name, status: material?.status }]);
    if (stream.closed) return;

    stream.send('result', toPublicMaterial(await Material.findById(file.material).lean<IMaterial>()));
    stream.end();
  } catch (error) {
    if (!stream) return next(error);
    if (stream.closed) return;
    console.error('Preparing a file failed:', error);
    stream.fail("We couldn't read this file. Please try again.");
  }
};

// ── Simplify, explain, summarise, example ─────────────────────────────────────

const ACTIONS = ['simplify', 'explain', 'summarize', 'example'] as const;
type Action = (typeof ACTIONS)[number];
const LEVELS = ['simple', 'standard', 'exam'] as const;
type Level = (typeof LEVELS)[number];

const TEXT_MAX = 8000;
const PAGE_SPAN_MAX = 10;
const PAGE_TEXT_MAX = 16_000;

const ACTION_VERBS: Record<Action, string> = {
  simplify: 'Simplifying',
  explain: 'Explaining',
  summarize: 'Summarising',
  example: 'Writing examples',
};

const LEVEL_GUIDE: Record<Level, string> = {
  simple:
    'Explain it so a first-year with no background gets it: plain words, one everyday analogy, and define any technical term the first time.',
  standard: 'Explain it clearly and precisely, the way a good lecturer would, keeping the key terms.',
  exam:
    'Make it exam-ready: short bullet notes with the exact definitions, formulas and points an examiner looks for, and one common mistake to avoid.',
};

const ACTION_GUIDE: Record<Action, string> = {
  simplify: '',
  explain: 'Explain it in depth: what it is, why it works, and how it connects to the ideas around it.',
  summarize: 'Summarise it in at most 10 short bullet points, keeping every key term, formula and number.',
  example:
    'Give two worked examples that apply it, step by step, from simple to harder. Use everyday settings the student will recognise.',
};

/**
 * Rewrites a passage the student picked, or pages of a file, streamed as it's
 * written. Costs energy like Ask (tokens × the model's rate).
 */
export const simplify = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const userId = req.user!.id;
  const body = req.body ?? {};
  const action: Action = body.action ?? 'simplify';
  const level: Level = body.level ?? 'simple';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  // Pages of a library file, or of a course material in a space
  const fileId = isId(body.fileId) ? body.fileId : null;
  const courseMaterial =
    isId(body.spaceId) && isId(body.spaceMaterialId) ? { id: body.spaceId as string, materialIds: [body.spaceMaterialId as string] } : null;
  const fromFile = Boolean(fileId || courseMaterial);
  const pageStart = Number(body.pageStart);
  const pageEnd = body.pageEnd === undefined ? pageStart : Number(body.pageEnd);

  if (!(ACTIONS as readonly string[]).includes(action)) {
    sendError(res, 'Action must be simplify, explain, summarize or example', 400);
    return;
  }
  if (!(LEVELS as readonly string[]).includes(level)) {
    sendError(res, 'Level must be simple, standard or exam', 400);
    return;
  }
  if (!text && !fromFile) {
    sendError(res, 'Send the text, or a file and its pages', 400);
    return;
  }
  if (text.length > TEXT_MAX) {
    sendError(res, `Pick up to ${TEXT_MAX} characters at a time`, 400);
    return;
  }
  if (fromFile && (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd) || pageStart < 1 || pageEnd < pageStart || pageEnd - pageStart >= PAGE_SPAN_MAX)) {
    sendError(res, `Choose 1 to ${PAGE_SPAN_MAX} pages`, 400);
    return;
  }
  if (body.model !== undefined && !isModelId(body.model)) {
    sendError(res, 'Unknown model', 400);
    return;
  }

  let stream: Stream | null = null;
  try {
    const user = await User.findById(userId).select('firstName academicProfile learningStyle plan planExpiresAt').lean<IUser>();
    if (!user) {
      sendError(res, 'Unauthorized', 401);
      return;
    }
    const plan = activePlan(user);
    const modelId: AiModelId = body.model ?? DEFAULT_MODEL[plan];
    const block = await checkModel(userId, modelId);
    if (block) {
      sendError(res, block.message, 403, { ...block });
      return;
    }

    stream = openStream(req, res);
    const live = stream;

    let passage = text;
    if (fromFile) {
      const [source] = await readySources(live, userId, courseMaterial ? { space: courseMaterial } : { fileIds: [fileId!] });
      if (live.closed) return;
      if (!source) {
        live.fail("We couldn't read this file.");
        return;
      }
      const pages = pageStart === pageEnd ? `p. ${pageStart}` : `p. ${pageStart}–${pageEnd}`;
      live.step('read', `Reading ${pages} of ${source.file.name}…`, { status: 'active' });
      const chunks = await MaterialChunk.find({
        material: source.material._id,
        pageStart: { $lte: pageEnd },
        pageEnd: { $gte: pageStart },
      })
        .sort({ index: 1 })
        .select('text')
        .lean();
      passage = chunks.map((chunk) => chunk.text).join('\n\n').slice(0, PAGE_TEXT_MAX);
      if (!passage) {
        live.fail(`There's no text on ${pages}.`);
        return;
      }
      live.step('read', `Read ${pages} of ${source.file.name}`, { status: 'done' });
    }

    const model = AI_MODELS[modelId];
    live.step('write', `${ACTION_VERBS[action]} with ${model.name}…`, { status: 'active' });
    const engine = engineFor(modelId, plan);
    const system = [
      `You are BreedX, a study assistant helping ${user.firstName || 'a student'} with their course material.`,
      aboutStudent(user),
      action === 'simplify' ? LEVEL_GUIDE[level] : ACTION_GUIDE[action],
      'Stay faithful to the passage: never change facts, numbers or formulas. Use Markdown, **bold** key terms and LaTeX between $ signs for maths.',
      "Start with the content itself, no greeting. Never mention which company's AI you run on.",
    ]
      .filter(Boolean)
      .join('\n');
    const prompt = `Passage:\n${passage}`;

    let written = '';
    let tokens: TokenCount | null = null;
    let status: 'complete' | 'stopped' = 'complete';
    try {
      const result = await generateStream({ engine, system, prompt, signal: live.signal }, (piece) => {
        written += piece;
        live.send('token', { text: piece });
      });
      tokens = result.tokens;
    } catch (error) {
      if (!live.signal.aborted) throw error;
      status = 'stopped';
    }
    if (!tokens || (!tokens.inputTokens && !tokens.outputTokens)) {
      tokens = { inputTokens: Math.ceil((system.length + prompt.length) / 4), outputTokens: Math.ceil(written.length / 4) };
    }

    const { charge } = await recordUsage({ userId, feature: 'simplify', model: modelId, engine: engine.model, tokens });
    void recordActivity(userId, 'ai');
    if (charge?.crossedLow) {
      void notify(
        [userId],
        {
          category: 'ai',
          kind: 'energy-low',
          title: 'Your AI energy is low ⚡',
          body: 'About 10% left. It refills every hour, or top up to keep going.',
          link: '/settings?tab=billing',
        },
        { push: true }
      );
    }

    live.step('write', status === 'stopped' ? 'Stopped' : 'Done', { status: 'done' });
    const { percent, low, empty, fullAt } = await energyFor(userId);
    live.send('done', { status, energy: { percent, low, empty, fullAt } });
    live.end();
  } catch (error) {
    if (!stream) return next(error);
    if (stream.closed) return;
    console.error('Simplify failed:', error);
    stream.fail('Something went wrong. Please try again.');
  }
};

// ── Read aloud ────────────────────────────────────────────────────────────────

/**
 * Reads text aloud in a human voice. Answers with MP3 audio, or with JSON
 * `{ useDeviceVoice: true, reason }` when today's or this month's free
 * allowance is used up, so the app speaks it with the phone's own voice.
 * Costs no AI energy. Send long answers in pieces, first sentence first, so
 * playback starts at once.
 */
export const readAloud = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const voice = req.body?.voice ?? 'warm';
    if (!(VOICES as readonly string[]).includes(voice)) {
      sendError(res, 'Voice must be warm or calm', 400);
      return;
    }
    const text = typeof req.body?.text === 'string' ? speakable(req.body.text) : '';
    if (!text) {
      sendError(res, 'Send the text to read', 400);
      return;
    }
    if (text.length > SPEECH_MAX_CHARS) {
      sendError(res, `Send up to ${SPEECH_MAX_CHARS} characters at a time`, 400);
      return;
    }

    const result = await speak(req.user!.id, text, voice as VoiceId);
    if ('useDeviceVoice' in result) {
      sendSuccess(res, result, "Use the device's voice");
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Voice-Tier', result.tier);
    res.setHeader('X-Voice-Cached', String(result.cached));
    if ('data' in result.audio) {
      res.setHeader('Content-Length', String(result.audio.data.length));
      res.end(result.audio.data);
    } else {
      readObject(result.audio.path)
        .on('error', (error) => (res.headersSent ? res.destroy(error) : next(error)))
        .pipe(res);
    }
  } catch (error) {
    next(error);
  }
};

/** Admins: how much of this month's free voice allowance is used. */
export const readAloudUsage = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.user?.role !== 'admin') {
      sendError(res, 'Admins only', 403);
      return;
    }
    sendSuccess(res, await speechThisMonth());
  } catch (error) {
    next(error);
  }
};
