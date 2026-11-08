import { Types } from 'mongoose';
import ScheduleEntry from '../models/scheduleEntry.model';
import SpaceMember from '../models/spaceMember.model';
import { IScheduleEntry, ISpaceMember, SCHEDULE_ENTRY_KINDS, ScheduleEntryKind } from '../types/space';

export const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export type SchedulePrefs = Record<ScheduleEntryKind, { home: boolean; remind: boolean }>;

/** A member's per-kind Home and reminder choices, with everything unset as on. */
export const prefsOf = (membership?: Pick<ISpaceMember, 'schedulePrefs'> | null): SchedulePrefs =>
  Object.fromEntries(
    SCHEDULE_ENTRY_KINDS.map((kind) => {
      const saved = membership?.schedulePrefs?.[kind];
      return [kind, { home: saved?.home !== false, remind: saved?.remind !== false }];
    })
  ) as SchedulePrefs;

/** "08:00" → "8:00 AM" */
export const clock = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  const suffix = hours < 12 ? 'AM' : 'PM';
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`;
};

/** "2026-11-21" → "Sat 21 Nov" */
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`)
  );

/** What the entry is called: "GET 316 · Engine Math IV". */
export const entryName = (entry: Pick<IScheduleEntry, 'courseCode' | 'title'>) =>
  [entry.courseCode, entry.title].filter(Boolean).join(' · ');

/** When it happens: "Monday, 8:00 AM – 10:00 AM" or "Sat 21 Nov, 9:00 AM – 12:00 PM". */
export const entryWhen = (entry: Pick<IScheduleEntry, 'kind' | 'day' | 'date' | 'startTime' | 'endTime'>) =>
  `${entry.day ? DAY_NAMES[entry.day] : shortDate(entry.date ?? '')}, ${clock(entry.startTime)} – ${clock(entry.endTime)}`;

/**
 * The space whose schedule shows on someone's Home: the one they picked, or
 * else the first space they joined that has a schedule. Null if none has one.
 */
export const homeSpaceIdFor = async (userId: string | Types.ObjectId): Promise<Types.ObjectId | null> => {
  const memberships = await SpaceMember.find({ user: userId, status: 'active' }).sort({ joinedAt: 1 }).lean();
  const picked = memberships.find((membership) => membership.onHome === true);
  if (picked) return picked.space;
  // They turned Home's schedule off
  if (memberships.some((membership) => membership.onHome === false)) return null;

  const withSchedule = new Set(
    (await ScheduleEntry.distinct('space', { space: { $in: memberships.map((m) => m.space) } })).map(String)
  );
  return memberships.find((membership) => withSchedule.has(String(membership.space)))?.space ?? null;
};

/** The parts of "now" the reminder loop needs, in one timezone. */
export const zonedParts = (at: Date, timeZone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, day };
};
