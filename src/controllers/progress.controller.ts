import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import CourseMap from '../models/courseMap.model';
import CourseMastery from '../models/courseMastery.model';
import Library from '../models/library.model';
import LibraryFile from '../models/libraryFile.model';
import Material from '../models/material.model';
import Space from '../models/space.model';
import SpaceMember from '../models/spaceMember.model';
import TopicMastery from '../models/topicMastery.model';
import User from '../models/user.model';
import Warmup from '../models/warmup.model';
import { AuthRequest } from '../types/auth';
import { ILibraryFile, IMaterial } from '../types/library';
import { ITopicMastery, IWarmup } from '../types/progress';
import { topicsOf } from '../utils/ai/bank';
import { sendError, sendSuccess } from '../utils/response';

const WEAKEST = 5;
const RECENT_WARMUPS = 20;

const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);

/**
 * Topic by topic, how well the student knows each of their files: mastery 0–100,
 * status (new, learning, mastered), and when it's due again. Plus their weakest
 * topics overall. `?libraryId=` for one library.
 */
export const getProgress = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const libraryId = isId(req.query.libraryId) ? req.query.libraryId : null;
    const [libraries, files] = await Promise.all([
      Library.find({ owner: userId, ...(libraryId && { _id: libraryId }) }).select('name').sort({ createdAt: 1 }).lean(),
      LibraryFile.find({ owner: userId, status: 'ready', material: { $ne: null }, ...(libraryId && { library: libraryId }) })
        .sort({ createdAt: 1 })
        .lean<ILibraryFile[]>(),
    ]);
    const materials = await Material.find({ _id: { $in: files.map((file) => file.material) } })
      .select('status map')
      .lean<IMaterial[]>();
    const materialById = new Map(materials.map((material) => [String(material._id), material]));
    const masteries = await TopicMastery.find({ user: userId, material: { $in: materials.map((material) => material._id) } }).lean<
      ITopicMastery[]
    >();
    const masteryOf = new Map(masteries.map((entry) => [`${entry.material}:${entry.topicKey}`, entry]));
    const now = Date.now();

    const describeFile = (file: ILibraryFile) => {
      const material = materialById.get(String(file.material));
      const topics = topicsOf(material?.status === 'ready' ? material.map : null).map((topic) => {
        const mastery = masteryOf.get(`${file.material}:${topic.key}`);
        return {
          key: topic.key,
          title: topic.topicTitle,
          chapter: topic.chapterTitle,
          pageStart: topic.pageStart,
          pageEnd: topic.pageEnd,
          mastery: mastery?.mastery ?? null,
          status: mastery?.status ?? 'new',
          lastScore: mastery?.lastScore ?? null,
          lastPracticedAt: mastery?.lastPracticedAt ?? null,
          due: Boolean(mastery?.reviewAt && mastery.reviewAt.getTime() <= now),
        };
      });
      return {
        fileId: file._id,
        name: file.name,
        // `stored`: the AI hasn't read it yet, so its topics aren't known
        status: material?.status ?? 'stored',
        topics,
        mastered: topics.filter((topic) => topic.status === 'mastered').length,
      };
    };

    const result = libraries.map((library) => ({
      id: library._id,
      name: library.name,
      files: files.filter((file) => String(file.library) === String(library._id)).map(describeFile),
    }));

    // Weakest practised topics first, from any file that's still in a library
    const fileByMaterial = new Map(files.map((file) => [String(file.material), file]));
    const weakest = masteries
      .filter((entry) => entry.status === 'learning' && fileByMaterial.has(String(entry.material)))
      .sort((a, b) => a.mastery - b.mastery)
      .slice(0, WEAKEST)
      .map((entry) => {
        const file = fileByMaterial.get(String(entry.material))!;
        return {
          fileId: file._id,
          libraryId: file.library,
          fileName: file.name,
          key: entry.topicKey,
          title: entry.topicTitle,
          chapter: entry.chapterTitle,
          mastery: entry.mastery,
          lastScore: entry.lastScore,
        };
      });

    sendSuccess(res, { libraries: result, weakest });
  } catch (error) {
    next(error);
  }
};

/**
 * The courses in the student's spaces, each with how much of it they've
 * covered in warm-ups and whether warm-ups are on for it.
 */
export const listCourses = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const [memberships, user] = await Promise.all([
      SpaceMember.find({ user: userId, status: 'active' }).select('space mutedCourses').lean(),
      User.findById(userId).select('warmups').lean(),
    ]);
    const spaces = await Space.find({ _id: { $in: memberships.map((member) => member.space) } })
      .select('name slug courses rules')
      .lean();
    const [maps, masteries] = await Promise.all([
      CourseMap.find({ space: { $in: spaces.map((space) => space._id) } }).select('space course topics.key').lean(),
      CourseMastery.find({ user: userId, space: { $in: spaces.map((space) => space._id) } })
        .select('space course status answered')
        .lean(),
    ]);
    const topicCount = new Map(maps.map((map) => [`${map.space}:${map.course}`, map.topics.length]));
    const mutedBy = new Map(memberships.map((member) => [String(member.space), new Set((member.mutedCourses ?? []).map(String))]));

    const courses = spaces.flatMap((space) =>
      (space.courses ?? []).map((course) => {
        const key = `${space._id}:${course._id}`;
        const mine = masteries.filter((entry) => `${entry.space}:${entry.course}` === key);
        return {
          spaceId: space._id,
          spaceName: space.name,
          spaceSlug: space.slug,
          courseId: course._id,
          code: course.code,
          title: course.title,
          materials: (course.materials ?? []).filter((material: { status?: string }) => material.status === 'ready').length,
          // Off when the student doesn't take this course, or the space's owner turned warm-ups off
          warmups: !mutedBy.get(String(space._id))?.has(String(course._id)),
          spaceWarmups: space.rules?.warmups !== false,
          coverage: {
            total: topicCount.get(key) ?? 0,
            covered: mine.filter((entry) => entry.answered > 0).length,
            mastered: mine.filter((entry) => entry.status === 'mastered').length,
          },
        };
      })
    );
    sendSuccess(res, { warmups: user?.warmups !== false, courses });
  } catch (error) {
    next(error);
  }
};

/** `{ "warmups": false }` for a course the student doesn't take (an elective); `true` turns it back on. */
export const setCourseWarmups = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { spaceId, courseId } = req.params;
    if (typeof req.body?.warmups !== 'boolean') {
      sendError(res, 'warmups must be true or false', 400);
      return;
    }
    if (!isId(spaceId) || !isId(courseId)) {
      sendError(res, 'Course not found', 404);
      return;
    }
    const space = await Space.findById(spaceId).select('courses._id').lean();
    if (!space?.courses?.some((course) => String(course._id) === courseId)) {
      sendError(res, 'Course not found', 404);
      return;
    }
    const updated = await SpaceMember.updateOne(
      { space: spaceId, user: userId, status: 'active' },
      req.body.warmups
        ? { $pull: { mutedCourses: new Types.ObjectId(courseId) } }
        : { $addToSet: { mutedCourses: new Types.ObjectId(courseId) } }
    );
    if (!updated.matchedCount) {
      sendError(res, 'Course not found', 404);
      return;
    }
    sendSuccess(res, { warmups: req.body.warmups }, 'Course updated');
  } catch (error) {
    next(error);
  }
};

/** Turns pre-class warm-ups on or off for every course. */
export const updateSettings = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (typeof req.body?.warmups !== 'boolean') {
      sendError(res, 'warmups must be true or false', 400);
      return;
    }
    await User.updateOne({ _id: req.user!.id }, { $set: { warmups: req.body.warmups } });
    sendSuccess(res, { warmups: req.body.warmups }, 'Settings saved');
  } catch (error) {
    next(error);
  }
};

const toPublicWarmup = (warmup: IWarmup) => ({
  id: warmup._id,
  quizId: warmup.quiz,
  courseCode: warmup.courseCode,
  topic: warmup.topicTitle,
  courseId: warmup.course,
  // Course topics practised before this warm-up, out of the course's total
  covered: warmup.covered ?? 0,
  totalTopics: warmup.totalTopics,
  reason: warmup.reason,
  status: warmup.status,
  score: warmup.score,
  date: warmup.date,
  createdAt: warmup.createdAt,
});

/** Recent warm-ups, newest first. Open one with GET /quizzes/:quizId. */
export const listWarmups = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const warmups = await Warmup.find({ user: req.user!.id }).sort({ createdAt: -1 }).limit(RECENT_WARMUPS).lean<IWarmup[]>();
    sendSuccess(res, { warmups: warmups.map(toPublicWarmup) });
  } catch (error) {
    next(error);
  }
};

export const getWarmup = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const warmup = isId(req.params.id) ? await Warmup.findOne({ _id: req.params.id, user: req.user!.id }).lean<IWarmup>() : null;
    if (!warmup) {
      sendError(res, 'Warm-up not found', 404);
      return;
    }
    sendSuccess(res, { warmup: toPublicWarmup(warmup) });
  } catch (error) {
    next(error);
  }
};
