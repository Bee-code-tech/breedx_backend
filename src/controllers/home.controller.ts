import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import CgpaRecord from '../models/cgpa.model';
import Library from '../models/library.model';
import LibraryFile from '../models/libraryFile.model';
import Material from '../models/material.model';
import QuizAttempt from '../models/quizAttempt.model';
import ReadingProgress from '../models/readingProgress.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { addDays, DEFAULT_TIMEZONE, isTimeZone, streakFor, today } from '../utils/activity';
import { summarize } from '../utils/cgpa';
import { sendSuccess } from '../utils/response';
import { zonedParts } from '../utils/schedule';

// Files shown under "Continue studying"
const CONTINUE_LIMIT = 6;
// A rough reading pace for "min left"
const MINUTES_PER_PAGE = 2;

/** The student's CGPA, and how much the latest semester moved it. */
const cgpaFor = async (userId: string) => {
  const record = await CgpaRecord.findOne({ user: userId }).select('scale levels').lean();
  if (!record) return { value: null, scale: '5.0', change: null, semesters: 0 };
  const summary = summarize(record.levels, record.scale);
  const last = summary.semesters[summary.semesters.length - 1];
  const before = summary.semesters[summary.semesters.length - 2];
  return {
    value: summary.periods ? summary.cgpa : null,
    scale: record.scale,
    change: last && before ? Number((last.cgpa - before.cgpa).toFixed(2)) : null,
    semesters: summary.periods,
  };
};

/** Quizzes taken this week (Monday to today) and last week, in the student's timezone. */
const quizWeekFor = async (userId: string, timeZone: string) => {
  const { date, weekday } = today(timeZone);
  const thisMonday = addDays(date, -(weekday - 1));
  const lastMonday = addDays(thisMonday, -7);
  // A day of slack either side covers any timezone
  const attempts = await QuizAttempt.find({
    user: userId,
    createdAt: { $gte: new Date(`${addDays(lastMonday, -1)}T00:00:00Z`) },
  })
    .select('score createdAt')
    .lean();

  const thisWeek: number[] = [];
  let lastWeek = 0;
  for (const attempt of attempts) {
    const day = zonedParts(attempt.createdAt, timeZone).date;
    if (day >= thisMonday) thisWeek.push(attempt.score);
    else if (day >= lastMonday) lastWeek++;
  }
  return {
    count: thisWeek.length,
    lastWeek,
    averageScore: thisWeek.length ? Math.round(thisWeek.reduce((sum, score) => sum + score, 0) / thisWeek.length) : null,
  };
};

/** Files the student was reading, most recent first, with how far they got. */
const continueFor = async (userId: string) => {
  const progress = await ReadingProgress.find({ user: userId }).sort({ lastOpenedAt: -1 }).limit(CONTINUE_LIMIT * 3).lean();
  const files = await LibraryFile.find({ _id: { $in: progress.map((entry) => entry.file) }, owner: userId, status: 'ready' })
    .select('name library material')
    .lean();
  const fileById = new Map(files.map((file) => [String(file._id), file]));
  const [libraries, materials] = await Promise.all([
    Library.find({ _id: { $in: files.map((file) => file.library) } }).select('name').lean(),
    Material.find({ _id: { $in: files.map((file) => file.material) } }).select('pageCount').lean(),
  ]);
  const libraryName = new Map(libraries.map((library) => [String(library._id), library.name]));
  const pagesOf = new Map(materials.map((material) => [String(material._id), material.pageCount]));

  return progress
    .map((entry) => {
      const file = fileById.get(String(entry.file));
      if (!file) return null;
      const pages = entry.pageCount ?? pagesOf.get(String(file.material)) ?? null;
      const reached = Math.min(entry.furthestPage, pages ?? entry.furthestPage);
      const percent = pages ? Math.round((reached / pages) * 100) : 0;
      return {
        fileId: file._id,
        libraryId: file.library,
        name: file.name,
        libraryName: libraryName.get(String(file.library)) ?? '',
        page: entry.page,
        pageCount: pages,
        percent,
        minutesLeft: pages ? Math.max(0, (pages - reached) * MINUTES_PER_PAGE) : null,
        lastOpenedAt: entry.lastOpenedAt,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item) && item!.percent < 100)
    .slice(0, CONTINUE_LIMIT);
};

/**
 * Everything on Home except the schedule (that's GET /schedule/home):
 * streak, CGPA, quizzes this week and "Continue studying".
 *
 * `?tz=Africa/Lagos` is the app's timezone. It's saved, so streak days and
 * weeks are counted in the student's own time.
 */
export const getHome = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const user = await User.findById(userId).select('timezone').lean();
    let timeZone = user?.timezone && isTimeZone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE;
    if (isTimeZone(req.query.tz) && req.query.tz !== user?.timezone) {
      timeZone = req.query.tz;
      await User.updateOne({ _id: new Types.ObjectId(userId) }, { $set: { timezone: timeZone } });
    }

    const [streak, cgpa, quizzes, continueStudying] = await Promise.all([
      streakFor(userId, timeZone),
      cgpaFor(userId),
      quizWeekFor(userId, timeZone),
      continueFor(userId),
    ]);
    sendSuccess(res, { timezone: timeZone, streak, cgpa, quizzes, continueStudying });
  } catch (error) {
    next(error);
  }
};
