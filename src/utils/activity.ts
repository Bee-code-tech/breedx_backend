import StudyDay from '../models/studyDay.model';
import User from '../models/user.model';
import { ActivityKind } from '../types/activity';
import { zonedParts } from './schedule';

// Used until the app has told us the student's timezone
export const DEFAULT_TIMEZONE = 'Africa/Lagos';
// Days looked back for the best streak
const HISTORY_DAYS = 400;

export const isTimeZone = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** Today's date (YYYY-MM-DD) and weekday (1 = Monday) in a timezone. */
export const today = (timeZone: string, at = new Date()) => {
  const { date, day } = zonedParts(at, timeZone);
  return { date, weekday: day };
};

/** A YYYY-MM-DD date moved by some days. */
export const addDays = (date: string, days: number) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

const timezoneOf = async (userId: string) => {
  const user = await User.findById(userId).select('timezone').lean();
  return user?.timezone && isTimeZone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE;
};

/**
 * Marks today as a study day for the student. Called after reading, asking the
 * AI, taking a quiz or reviewing flashcards. Never throws: a missed mark is
 * better than a failed request.
 */
export const recordActivity = async (userId: string, kind: ActivityKind): Promise<void> => {
  try {
    const { date } = today(await timezoneOf(userId));
    await StudyDay.updateOne({ user: userId, day: date }, { $inc: { [`counts.${kind}`]: 1 } }, { upsert: true });
  } catch (error) {
    // Two first-of-the-day marks at once: the unique index lets one in, and the other just counts
    if ((error as { code?: number }).code === 11000) {
      const { date } = today(await timezoneOf(userId));
      await StudyDay.updateOne({ user: userId, day: date }, { $inc: { [`counts.${kind}`]: 1 } }).catch(() => undefined);
      return;
    }
    console.error('Recording study activity failed:', error);
  }
};

/**
 * The student's streak: days in a row they studied, counting back from today.
 * Not studying yet today doesn't break it; missing yesterday does.
 */
export const streakFor = async (userId: string, timeZone: string) => {
  const { date: todayDate, weekday } = today(timeZone);
  const days = new Set(
    (await StudyDay.find({ user: userId, day: { $gte: addDays(todayDate, -HISTORY_DAYS) } }).select('day').lean()).map(
      (entry) => entry.day
    )
  );

  const activeToday = days.has(todayDate);
  let current = 0;
  for (let cursor = activeToday ? todayDate : addDays(todayDate, -1); days.has(cursor); cursor = addDays(cursor, -1)) {
    current++;
  }

  let best = 0;
  let run = 0;
  let previous = '';
  for (const day of [...days].sort()) {
    run = previous && addDays(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }

  // Monday to Sunday of this week, for the dots under the number
  const monday = addDays(todayDate, -(weekday - 1));
  const week = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(monday, index);
    return { day, active: days.has(day), future: day > todayDate };
  });

  return { current, best, activeToday, week };
};
