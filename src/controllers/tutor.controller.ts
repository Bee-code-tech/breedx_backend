import Anthropic from '@anthropic-ai/sdk';
import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import LibraryFile from '../models/libraryFile.model';
import Material from '../models/material.model';
import Space from '../models/space.model';
import SpaceMember from '../models/spaceMember.model';
import { StudentProfile, TeacherGuide, TutorEvent, TutorSession } from '../models/tutor.model';
import { AuthRequest } from '../types/auth';
import { ISpaceMaterial } from '../types/space';
import { GuideSource, ITeacherGuide, ITutorSession } from '../types/tutor';
import { topicsOf } from '../utils/ai/bank';
import { courseMapFor } from '../utils/ai/courseMap';
import { prepareMaterial } from '../utils/ai/process';
import { planFor } from '../utils/plan';
import { sendError, sendSuccess } from '../utils/response';
import { clipPathOf, pendingClip, recentClip } from '../utils/speech';
import { openStream, Stream } from '../utils/sse';
import { readObject } from '../utils/storage';
import { currentProvider } from '../utils/tutor/ai';
import { guideFor, prebuildGuide, signatureOf } from '../utils/tutor/guide';
import { finish, runTurn, StudentEvent } from '../utils/tutor/engine';

const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);
// A live session untouched this long is treated as abandoned
const ABANDONED_MS = 30 * 60 * 1000;

const startOfMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

/** Sessions used and left on the student's plan. Only started sessions count. */
const allowanceFor = async (userId: string) => {
  const { plan, limits } = await planFor(userId);
  const { tutor } = limits;
  const used = await TutorSession.countDocuments({
    user: userId,
    startedAt: tutor.lifetime ? { $ne: null } : { $gte: startOfMonth() },
  });
  return {
    plan,
    sessions: tutor.sessions,
    used,
    left: Math.max(0, tutor.sessions - used),
    period: tutor.lifetime ? 'trial' : 'month',
    minutes: tutor.minutes,
  };
};

const toPublicSession = (session: ITutorSession) => ({
  id: session._id,
  title: session.title,
  scope: session.scope,
  status: session.status,
  stage: session.stage,
  goalIndex: session.goalIndex,
  progress: session.progress,
  board: session.board,
  // Finished boards, for the thumbnail strip
  boards: session.boards ?? [],
  notes: session.notes,
  pending: session.pending ? { level: session.pending.level, question: session.pending.question, options: session.pending.options ?? [] } : null,
  voice: session.voice,
  minutes: session.minutes,
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  summary: session.summary,
  createdAt: session.createdAt,
});

const findOwnSession = (userId: string, id: unknown) =>
  isId(id) ? TutorSession.findOne({ _id: id, user: userId }) : null;

/** Where a topic is taught from, from a library file or a space course. */
const resolveTopic = async (
  userId: string,
  body: Record<string, unknown>
): Promise<{ sources: GuideSource[]; title: string; scope: ITutorSession['scope'] } | { error: string; status: number }> => {
  const topicKey = typeof body.topicKey === 'string' ? body.topicKey : '';
  if (!topicKey) return { error: 'Choose a topic', status: 400 };

  if (isId(body.fileId)) {
    const file = await LibraryFile.findOne({ _id: body.fileId, owner: userId, status: 'ready' }).lean();
    if (!file?.material) return { error: 'File not found', status: 404 };
    const material = await Material.findById(file.material).lean();
    const topic = topicsOf(material?.map ?? null).find((item) => item.key === topicKey);
    if (!material || !topic) return { error: 'Topic not found in this file', status: 404 };
    return {
      title: topic.topicTitle,
      scope: { kind: 'file', fileId: file._id as Types.ObjectId, topicKey },
      sources: [{ material: material._id as Types.ObjectId, topicKey, fileName: file.name, pageStart: topic.pageStart, pageEnd: topic.pageEnd }],
    };
  }

  if (isId(body.spaceId) && isId(body.courseId)) {
    const member = await SpaceMember.exists({ space: body.spaceId, user: userId, status: 'active' });
    const space = member ? await Space.findById(body.spaceId) : null;
    const course = space?.courses.id(body.courseId);
    if (!space || !course) return { error: 'Course not found', status: 404 };
    const map = await courseMapFor(space._id, course as unknown as Parameters<typeof courseMapFor>[1], userId);
    const topic = map?.topics.find((item) => item.key === topicKey);
    if (!topic) return { error: 'Topic not found in this course', status: 404 };
    return {
      title: topic.title,
      scope: { kind: 'course', spaceId: space._id, courseId: course._id as Types.ObjectId, topicKey },
      sources: topic.sources.map((source) => ({
        material: source.material,
        topicKey: source.topicKey,
        fileName: source.fileName,
        pageStart: source.pageStart,
        pageEnd: source.pageEnd,
      })),
    };
  }
  return { error: 'Send fileId, or spaceId and courseId', status: 400 };
};

// GET /tutor/allowance
export const getAllowance = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, await allowanceFor(req.user!.id));
  } catch (error) {
    next(error);
  }
};

/**
 * GET /tutor/topics?fileId=… or ?spaceId=…&courseId=…: the topics a student
 * can be tutored on. A file not read by the AI yet is read first.
 */
export const listTopics = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { fileId, spaceId, courseId } = req.query;
    if (isId(fileId)) {
      const file = await LibraryFile.findOne({ _id: fileId, owner: userId, status: 'ready' }).lean();
      if (!file?.material) {
        sendError(res, 'File not found', 404);
        return;
      }
      const material = await prepareMaterial(String(file.material), { fileName: file.name, userId });
      sendSuccess(res, {
        topics: topicsOf(material.map).map((topic) => ({
          key: topic.key,
          title: topic.topicTitle,
          chapter: topic.chapterTitle,
          pageStart: topic.pageStart,
          pageEnd: topic.pageEnd,
        })),
      });
      return;
    }
    if (isId(spaceId) && isId(courseId)) {
      const member = await SpaceMember.exists({ space: spaceId, user: userId, status: 'active' });
      const space = member ? await Space.findById(spaceId) : null;
      const course = space?.courses.id(courseId);
      if (!space || !course) {
        sendError(res, 'Course not found', 404);
        return;
      }
      const map = await courseMapFor(space._id, course as unknown as { _id: Types.ObjectId; title: string; code: string; materials: ISpaceMaterial[] }, userId);
      sendSuccess(res, {
        topics: (map?.topics ?? []).map((topic) => ({
          key: topic.key,
          title: topic.title,
          sources: topic.sources.map((source) => ({ fileName: source.fileName, pageStart: source.pageStart, pageEnd: source.pageEnd })),
        })),
      });
      return;
    }
    sendError(res, 'Send fileId, or spaceId and courseId', 400);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /tutor/sessions { fileId, topicKey } or { spaceId, courseId, topicKey }, optional voice.
 * Creates the session; it counts toward the plan once it starts.
 */
export const createSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const allowance = await allowanceFor(userId);
    if (allowance.left <= 0) {
      sendError(
        res,
        allowance.period === 'trial' ? "You've used your free tutor session" : "You've used this month's tutor sessions",
        403,
        { code: 'PLAN_LIMIT', limit: 'tutorSessions', allowance }
      );
      return;
    }
    const topic = await resolveTopic(userId, req.body ?? {});
    if ('error' in topic) {
      sendError(res, topic.error, topic.status);
      return;
    }
    const session = await TutorSession.create({
      user: userId,
      sources: topic.sources,
      scope: topic.scope,
      title: topic.title,
      voice: req.body?.voice === 'calm' ? 'calm' : 'warm',
      minutes: allowance.minutes,
      provider: currentProvider(),
    });
    sendSuccess(res, { session: toPublicSession(session), allowance }, 'Session ready', 201);
    // Start preparing the tutor now, so "Start" is instant once the student taps it
    prebuildGuide(topic.sources, topic.title, userId);
  } catch (error) {
    next(error);
  }
};

const EVENT_TYPES = ['start', 'beat_done', 'answer', 'speak', 'interrupt'] as const;

/**
 * POST /tutor/sessions/:id/events { type, text?, choice? } → a stream of the
 * tutor's next beat: `step` (while preparing), `grade`, `op` (say, draw,
 * highlight, fade, new_board, remove, note, ask, stage), then `beat_end` or `ended`.
 */
export const sendEvent = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const userId = req.user!.id;
  const type = req.body?.type;
  if (!(EVENT_TYPES as readonly string[]).includes(type)) {
    sendError(res, `type must be one of ${EVENT_TYPES.join(', ')}`, 400);
    return;
  }
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 2000) : '';
  if ((type === 'speak' || type === 'interrupt') && !text.trim()) {
    sendError(res, 'Send what the student said', 400);
    return;
  }
  if (type === 'answer' && !text.trim() && typeof req.body?.choice !== 'number') {
    sendError(res, 'Send the answer as text or choice', 400);
    return;
  }

  let stream: Stream | null = null;
  try {
    const session = await findOwnSession(userId, req.params.id);
    if (!session) {
      sendError(res, 'Session not found', 404);
      return;
    }
    if (session.status === 'ended') {
      sendError(res, 'This session has ended', 409);
      return;
    }
    if (!session.startedAt) {
      if (type !== 'start') {
        sendError(res, 'Start the session first', 409);
        return;
      }
      if ((await allowanceFor(userId)).left <= 0) {
        sendError(res, "You've used your tutor sessions for now", 403, { code: 'PLAN_LIMIT', limit: 'tutorSessions' });
        return;
      }
    }

    stream = openStream(req, res);
    let guide: ITeacherGuide | null = session.guide ? await TeacherGuide.findById(session.guide) : null;
    if (!guide || guide.status !== 'ready') {
      stream.step('guide', 'Preparing your tutor…', { status: 'active' });
      guide = await guideFor(session.sources, session.title, userId, (message) =>
        stream!.step('guide', message, { status: 'active' })
      );
      session.guide = guide._id as Types.ObjectId;
      await session.save();
      stream.step('guide', 'Your tutor is ready', { status: 'done' });
    }

    const event: StudentEvent =
      type === 'answer'
        ? { type, text, ...(typeof req.body?.choice === 'number' ? { choice: req.body.choice } : {}) }
        : type === 'interrupt'
          ? { type, text, ...(Number.isInteger(req.body?.clip) && req.body.clip >= 0 ? { clip: req.body.clip } : {}) }
          : type === 'speak'
            ? { type, text }
            : { type };
    const fill = req.body?.boardFill;
    if (typeof fill === 'number' && fill >= 0 && fill <= 1) event.boardFill = fill;
    await runTurn(String(session._id), guide, event, stream);
  } catch (error) {
    if (!stream) return next(error);
    if (stream.closed) return;
    console.error('Tutor turn failed:', error);
    const status = (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;
    const busy = error instanceof Anthropic.RateLimitError || status === 429;
    stream.fail(
      busy
        ? 'Tutors are busy right now. Please try again in a minute.'
        : (error as Error).message?.startsWith('Not enough')
          ? (error as Error).message
          : 'The tutor hit a problem. Please try again.',
      busy ? { code: 'BUSY' } : {}
    );
  }
};

// POST /tutor/sessions/:id/end
export const endSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await findOwnSession(req.user!.id, req.params.id);
    if (!session) {
      sendError(res, 'Session not found', 404);
      return;
    }
    if (session.status !== 'ended') await finish(session, null, 'student');
    sendSuccess(res, { session: toPublicSession(session) }, 'Session ended');
  } catch (error) {
    next(error);
  }
};

// GET /tutor/sessions: history, newest first
export const listSessions = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    // Abandoned live sessions are closed as they're listed
    await TutorSession.updateMany(
      { user: userId, status: 'live', updatedAt: { $lt: new Date(Date.now() - ABANDONED_MS) } },
      { $set: { status: 'ended', endedAt: new Date() } }
    );
    const sessions = await TutorSession.find({ user: userId, startedAt: { $ne: null } })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('-messages -toolResults');
    sendSuccess(res, { sessions: sessions.map(toPublicSession) });
  } catch (error) {
    next(error);
  }
};

// GET /tutor/sessions/:id
export const getSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await findOwnSession(req.user!.id, req.params.id);
    if (!session) {
      sendError(res, 'Session not found', 404);
      return;
    }
    const guide = session.guide
      ? await TeacherGuide.findById(session.guide).select('title summary status goals.id goals.title').lean()
      : await TeacherGuide.findOne({ signature: signatureOf(session.sources) }).select('title summary status goals.id goals.title').lean();
    sendSuccess(res, {
      session: toPublicSession(session),
      // "ready" means Start begins teaching at once; "building" means the tutor is still preparing
      guideStatus: guide?.status ?? 'building',
      goals: guide?.status === 'ready' ? guide.goals : [],
    });
  } catch (error) {
    next(error);
  }
};

/** GET /tutor/sessions/:id/replay: everything that happened, in order, to play back like a video. */
export const getReplay = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await findOwnSession(req.user!.id, req.params.id);
    if (!session) {
      sendError(res, 'Session not found', 404);
      return;
    }
    const events = await TutorEvent.find({ session: session._id }).sort({ seq: 1 }).select('seq at type data -_id').lean();
    const duration = session.startedAt && session.endedAt ? session.endedAt.getTime() - session.startedAt.getTime() : events.at(-1)?.at ?? 0;
    sendSuccess(res, { session: toPublicSession(session), duration, events });
  } catch (error) {
    next(error);
  }
};

/** GET /tutor/audio/:clipId: one spoken line (MP3), for live play and replays. */
export const getAudio = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const path = clipPathOf(String(req.params.clipId));
    if (!path) {
      sendError(res, 'Clip not found', 404);
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    // Still being made: wait for it (usually a second or two)
    const making = pendingClip(String(req.params.clipId));
    if (making && !(await making)) {
      sendError(res, 'This line has no audio; use the device voice', 404);
      return;
    }
    const fresh = recentClip(String(req.params.clipId));
    if (fresh) {
      res.setHeader('Content-Length', String(fresh.length));
      res.end(fresh);
      return;
    }
    readObject(path)
      .on('error', () => (res.headersSent ? res.destroy() : sendError(res, 'Clip not found', 404)))
      .pipe(res);
  } catch (error) {
    next(error);
  }
};

// GET /tutor/profile: what the tutor remembers about how you learn
export const getProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const profile = await StudentProfile.findOne({ user: req.user!.id }).lean();
    sendSuccess(res, {
      profile: profile
        ? { terms: profile.terms, misconceptions: profile.misconceptions, interests: profile.interests }
        : { terms: [], misconceptions: [], interests: [] },
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /tutor/profile: forget it all
export const deleteProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await StudentProfile.deleteOne({ user: req.user!.id });
    sendSuccess(res, null, 'The tutor has forgotten what it learnt about you');
  } catch (error) {
    next(error);
  }
};
