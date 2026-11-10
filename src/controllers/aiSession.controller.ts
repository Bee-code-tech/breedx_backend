import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import env from '../config/env';
import { AI_MODELS, AiModelId, DEFAULT_MODEL, engineFor, isModelId } from '../config/models';
import AiMessage from '../models/aiMessage.model';
import AiSession from '../models/aiSession.model';
import Library from '../models/library.model';
import SpaceMember from '../models/spaceMember.model';
import LibraryFile from '../models/libraryFile.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { Citation, IAiMessage, IAiSession, MessageStep } from '../types/ai';
import { IUser } from '../types/user';
import {
  askPrompt,
  askSystemPrompt,
  historyFor,
  readAnswer,
  searchQueryFor,
  summariseIfNeeded,
  titleFor,
} from '../utils/ai/ask';
import { checkModel, energyFor, recordUsage } from '../utils/ai/energy';
import { prepareAll } from '../utils/ai/prepare';
import { describeScope, resolveScope, toPrepare, unitsOf } from '../utils/ai/scope';
import { searchChunks } from '../utils/ai/search';
import { generateStream, TokenCount } from '../utils/ai/vertex';
import { activePlan } from '../utils/plan';
import { notify } from '../utils/notify';
import { recordActivity } from '../utils/activity';
import { sendError, sendSuccess } from '../utils/response';
import { openStream, Stream } from '../utils/sse';

const TITLE_MAX = 80;
const QUESTION_MAX = 4000;
const SOURCES = 6;
const SESSION_PAGE = 30;
const MESSAGE_PAGE = 50;
const COMMENT_MAX = 1000;

// Chats answering right now, so a second question waits for the first
const busy = new Set<string>();

const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);

const idList = (value: unknown): string[] | null =>
  value === undefined ? null : Array.isArray(value) ? [...new Set(value.filter(isId))] : [];

// ── Shapes sent to the frontend ───────────────────────────────────────────────

const toPublicSession = (session: IAiSession) => ({
  id: session._id,
  mode: session.mode,
  title: session.title,
  libraryIds: session.libraries,
  fileIds: session.files,
  spaceId: session.space ?? null,
  courseIds: session.courses ?? [],
  spaceMaterialIds: session.spaceMaterials ?? [],
  model: session.aiModel,
  messageCount: session.messageCount,
  lastMessageAt: session.lastMessageAt,
  createdAt: session.createdAt,
});

const toPublicMessage = (message: IAiMessage) => ({
  id: message._id,
  role: message.role,
  content: message.content,
  sources: message.sources,
  cited: message.cited,
  steps: message.steps,
  grounding: message.grounding,
  status: message.status,
  model: message.aiModel,
  feedback: message.feedback ? { rating: message.feedback.rating, comment: message.feedback.comment } : null,
  createdAt: message.createdAt,
});

const energySummary = async (userId: string) => {
  const { percent, low, empty, fullAt } = await energyFor(userId);
  return { percent, low, empty, fullAt };
};

/** Keeps only the libraries and files that belong to this student. */
const ownScope = async (userId: string, libraryIds: string[] | null, fileIds: string[] | null) => {
  const [libraries, files] = await Promise.all([
    libraryIds?.length ? Library.find({ _id: { $in: libraryIds }, owner: userId }).distinct('_id') : [],
    fileIds?.length ? LibraryFile.find({ _id: { $in: fileIds }, owner: userId }).distinct('_id') : [],
  ]);
  return { libraries, files };
};

/** A space the chat may cover: only one the student is a member of. */
const ownSpace = async (userId: string, spaceId: unknown) =>
  isId(spaceId) && (await SpaceMember.exists({ space: spaceId, user: userId, status: 'active' }))
    ? new Types.ObjectId(spaceId)
    : null;

const findOwnSession = (userId: string, id: unknown) =>
  isId(id) ? AiSession.findOne({ _id: id, owner: userId }) : Promise.resolve(null);

// ── Sessions ──────────────────────────────────────────────────────────────────

export const listSessions = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
    const sessions = await AiSession.find({
      owner: req.user!.id,
      mode: 'ask',
      ...(before && !Number.isNaN(before.getTime()) && { lastMessageAt: { $lt: before } }),
    })
      .sort({ lastMessageAt: -1 })
      .limit(SESSION_PAGE + 1);

    sendSuccess(res, {
      sessions: sessions.slice(0, SESSION_PAGE).map(toPublicSession),
      hasMore: sessions.length > SESSION_PAGE,
    });
  } catch (error) {
    next(error);
  }
};

export const createSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const model = req.body?.model;
    if (model !== undefined && !isModelId(model)) {
      sendError(res, 'Unknown model', 400);
      return;
    }
    const { libraries, files } = await ownScope(userId, idList(req.body?.libraryIds), idList(req.body?.fileIds));
    const space = await ownSpace(userId, req.body?.spaceId);
    const session = await AiSession.create({
      owner: userId,
      mode: 'ask',
      libraries,
      files,
      space,
      courses: space ? idList(req.body?.courseIds) ?? [] : [],
      spaceMaterials: space ? idList(req.body?.spaceMaterialIds) ?? [] : [],
      aiModel: model ?? null,
    });
    sendSuccess(res, { session: toPublicSession(session) }, 'Chat created', 201);
  } catch (error) {
    next(error);
  }
};

export const getSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await findOwnSession(req.user!.id, req.params.id);
    if (!session) {
      sendError(res, 'Chat not found', 404);
      return;
    }
    // Newest page first; `before` (a message id) loads older ones
    const before = isId(req.query.before) ? await AiMessage.findById(req.query.before).select('createdAt') : null;
    const messages = await AiMessage.find({
      session: session._id,
      ...(before && { createdAt: { $lt: before.createdAt } }),
    })
      .sort({ createdAt: -1 })
      .limit(MESSAGE_PAGE + 1);

    sendSuccess(res, {
      session: toPublicSession(session),
      messages: messages.slice(0, MESSAGE_PAGE).reverse().map(toPublicMessage),
      hasMore: messages.length > MESSAGE_PAGE,
    });
  } catch (error) {
    next(error);
  }
};

export const updateSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const session = await findOwnSession(userId, req.params.id);
    if (!session) {
      sendError(res, 'Chat not found', 404);
      return;
    }

    const { title, model } = req.body ?? {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim() || title.trim().length > TITLE_MAX) {
        sendError(res, `Title must be 1 to ${TITLE_MAX} characters`, 400);
        return;
      }
      session.title = title.trim();
      session.titled = true;
    }
    if (model !== undefined) {
      if (!isModelId(model)) {
        sendError(res, 'Unknown model', 400);
        return;
      }
      session.aiModel = model;
    }
    const libraryIds = idList(req.body?.libraryIds);
    const fileIds = idList(req.body?.fileIds);
    if (libraryIds || fileIds) {
      const scope = await ownScope(userId, libraryIds, fileIds);
      if (libraryIds) session.libraries = scope.libraries;
      if (fileIds) session.files = scope.files;
    }
    if (req.body?.spaceId !== undefined) {
      session.space = req.body.spaceId === null ? null : await ownSpace(userId, req.body.spaceId);
      const toIds = (value: unknown) => (idList(value) ?? []).map((id) => new Types.ObjectId(id));
      session.courses = session.space ? toIds(req.body?.courseIds) : [];
      session.spaceMaterials = session.space ? toIds(req.body?.spaceMaterialIds) : [];
    }

    await session.save();
    sendSuccess(res, { session: toPublicSession(session) }, 'Chat updated');
  } catch (error) {
    next(error);
  }
};

export const deleteSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await findOwnSession(req.user!.id, req.params.id);
    if (!session) {
      sendError(res, 'Chat not found', 404);
      return;
    }
    await AiMessage.deleteMany({ session: session._id });
    await session.deleteOne();
    sendSuccess(res, null, 'Chat deleted');
  } catch (error) {
    next(error);
  }
};

// ── Ask ───────────────────────────────────────────────────────────────────────

// About four characters make a token; used when an answer is stopped before the AI reports its count
const estimate = (chars: number) => Math.ceil(chars / 4);

/**
 * Answers a question from the student's files. Streams thought steps, the
 * sources found, then the answer piece by piece. The student pays energy for
 * the answer only (tokens × the model's rate); searching and naming are free.
 */
export const ask = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const userId = req.user!.id;
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question || question.length > QUESTION_MAX) {
    sendError(res, `Ask in 1 to ${QUESTION_MAX} characters`, 400);
    return;
  }
  if (req.body?.model !== undefined && !isModelId(req.body.model)) {
    sendError(res, 'Unknown model', 400);
    return;
  }

  let stream: Stream | null = null;
  let sessionId = '';
  try {
    const [session, user] = await Promise.all([
      findOwnSession(userId, req.params.id),
      User.findById(userId).select('firstName academicProfile learningStyle plan planExpiresAt').lean<IUser>(),
    ]);
    if (!session || !user) {
      sendError(res, 'Chat not found', 404);
      return;
    }
    sessionId = String(session._id);
    if (busy.has(sessionId)) {
      sendError(res, 'Wait for the current answer to finish', 409);
      return;
    }

    const plan = activePlan(user);
    const modelId: AiModelId = req.body?.model ?? session.aiModel ?? DEFAULT_MODEL[plan];
    const block = await checkModel(userId, modelId);
    if (block) {
      sendError(res, block.message, 403, { ...block });
      return;
    }

    busy.add(sessionId);
    stream = openStream(req, res);
    const live = stream;

    // Steps are shown live and saved with the answer, so they show again when the chat is reopened
    const steps: MessageStep[] = [];
    const step = (id: string, text: string, status: MessageStep['status'] = 'done') => {
      const existing = steps.find((entry) => entry.id === id);
      if (existing) Object.assign(existing, { text, status });
      else steps.push({ id, text, status });
      live.step(id, text, { status });
    };
    const trackingStream: Stream = {
      ...live,
      step: (id, text, extra) => step(id, text, (extra?.status as MessageStep['status']) ?? 'done'),
      get closed() {
        return live.closed;
      },
    };

    const history = await historyFor(session);
    const userMessage = await AiMessage.create({ session: session._id, owner: userId, role: 'user', content: question });
    // Counted straight away, so a question stopped before its answer still lines up with the summary
    await AiSession.updateOne({ _id: session._id }, { $inc: { messageCount: 1 }, $set: { lastMessageAt: new Date() } });
    live.send('message', { userMessageId: userMessage._id });

    // 1. Understand the question (follow-ups are rewritten to stand alone)
    step('read', 'Reading your question…', 'active');
    const searchQuery = await searchQueryFor(question, history, userId, live.signal);
    step('read', 'Read your question');

    // 2. Find the right pages in the chat's files
    const scope = await resolveScope(userId, {
      libraryIds: session.libraries,
      fileIds: session.files,
      space: session.space ? { id: session.space, courseIds: session.courses, materialIds: session.spaceMaterials } : null,
    });
    let sources: Citation[] = [];
    if (!scope.byMaterial.size) {
      step('search', 'No files in this chat, so answering from general knowledge');
    } else {
      step('search', `Searching ${describeScope(scope)}…`, 'active');
      const ready = await prepareAll(trackingStream, userId, toPrepare(scope));
      if (live.closed) return;

      if (ready.size) {
        const { hits, tokens } = await searchChunks(
          searchQuery,
          [...ready].map((id) => new Types.ObjectId(id)),
          SOURCES,
          live.signal
        );
        await recordUsage({ userId, feature: 'ask', engine: env.AI_EMBED_MODEL, tokens, session: sessionId });
        const units = await unitsOf([...ready]);
        sources = hits.map((hit, index) => {
          const file = scope.byMaterial.get(String(hit.material))!;
          return {
            n: index + 1,
            fileId: file._id as Types.ObjectId,
            fileName: file.name,
            libraryId: file.library,
            pageStart: hit.pageStart,
            pageEnd: hit.pageEnd,
            unit: units.get(String(hit.material)) ?? 'page',
            chapter: hit.chapterTitle,
            topic: hit.topicTitle,
            text: hit.text,
            // Course materials open in their space
            spaceSlug: file.spaceSlug ?? null,
            spaceMaterialId: file.spaceSlug ? (file._id as Types.ObjectId) : null,
          };
        });
      }

      if (sources.length) {
        const pages = sources.map((source) => source.pageStart);
        const range = Math.min(...pages) === Math.max(...pages) ? `${pages[0]}` : `${Math.min(...pages)}–${Math.max(...pages)}`;
        const files = new Set(sources.map((source) => String(source.fileId))).size;
        step(
          'search',
          files === 1
            ? `Found ${sources.length} section${sources.length === 1 ? '' : 's'} (p. ${range})`
            : `Found ${sources.length} sections in ${files} files`
        );
      } else {
        step('search', 'Nothing in your files yet, so answering from general knowledge');
      }
    }
    live.send('sources', { sources });

    // 3. Write the answer, streamed as it's written
    const model = AI_MODELS[modelId];
    step('write', `Writing with ${model.name}…`, 'active');
    const system = askSystemPrompt(user, modelId, session.summary);
    const prompt = askPrompt(question, sources);

    let text = '';
    let tokens: TokenCount | null = null;
    let status: IAiMessage['status'] = 'complete';
    try {
      const result = await generateStream(
        { engine: engineFor(modelId, plan), system, history, prompt, signal: live.signal },
        (piece) => {
          text += piece;
          live.send('token', { text: piece });
        }
      );
      tokens = result.tokens;
    } catch (error) {
      if (!live.signal.aborted) throw error;
      status = 'stopped';
    }

    // A stopped answer is charged for what was written, estimated
    if (!tokens || (!tokens.inputTokens && !tokens.outputTokens)) {
      const sent = system.length + prompt.length + history.reduce((sum, turn) => sum + turn.text.length, 0);
      tokens = { inputTokens: estimate(sent), outputTokens: estimate(text.length) };
    }
    step('write', status === 'stopped' ? 'Stopped' : 'Done');

    const { cited, grounding } = readAnswer(text, sources.length);
    const { energy, charge } = await recordUsage({
      userId,
      feature: 'ask',
      model: modelId,
      engine: engineFor(modelId, plan).model,
      tokens,
      session: sessionId,
    });

    const answer = await AiMessage.create({
      session: session._id,
      owner: userId,
      role: 'assistant',
      content: text,
      sources,
      cited,
      steps,
      grounding,
      status,
      aiModel: modelId,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      energy,
    });

    void recordActivity(userId, 'ai');
    const isFirst = session.messageCount === 0;
    await AiSession.updateOne(
      { _id: session._id },
      { $inc: { messageCount: 1, energyUsed: energy }, $set: { lastMessageAt: new Date(), aiModel: modelId } }
    );

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

    if (!live.closed) {
      live.send('done', {
        messageId: answer._id,
        status,
        cited,
        grounding,
        energy: await energySummary(userId),
      });
    }

    // Name a new chat from its first question
    if (isFirst && !session.titled && !live.closed) {
      const title = await titleFor(question, userId);
      if (title) {
        await AiSession.updateOne({ _id: session._id, titled: false }, { $set: { title, titled: true } });
        live.send('title', { title });
      }
    }
    live.end();

    summariseIfNeeded(sessionId, userId).catch((error) => console.error('Chat summary failed:', error));
  } catch (error) {
    if (!stream) return next(error);
    if (stream.closed) return;
    console.error('Ask failed:', error);
    stream.fail('Something went wrong while answering. Please try again.');
  } finally {
    if (sessionId) busy.delete(sessionId);
  }
};

// ── Feedback ──────────────────────────────────────────────────────────────────

export const setFeedback = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { rating, comment } = req.body ?? {};
    if (rating !== null && rating !== 'up' && rating !== 'down') {
      sendError(res, 'Rating must be "up", "down" or null', 400);
      return;
    }
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > COMMENT_MAX)) {
      sendError(res, `Comment must be up to ${COMMENT_MAX} characters`, 400);
      return;
    }
    const message = isId(req.params.id)
      ? await AiMessage.findOne({ _id: req.params.id, owner: req.user!.id, role: 'assistant' })
      : null;
    if (!message) {
      sendError(res, 'Message not found', 404);
      return;
    }

    message.feedback = rating ? { rating, comment: (comment ?? '').trim(), at: new Date() } : null;
    await message.save();
    sendSuccess(res, { feedback: message.feedback ? { rating, comment: message.feedback.comment } : null }, 'Thanks for the feedback');
  } catch (error) {
    next(error);
  }
};
