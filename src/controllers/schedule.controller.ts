import { Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import ScheduleEntry from '../models/scheduleEntry.model';
import Space from '../models/space.model';
import SpaceMember from '../models/spaceMember.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { ISpace, IScheduleEntry, SCHEDULE_ENTRY_KINDS, ScheduleEntryKind, ScheduleKind } from '../types/space';

type SharedKind = Exclude<ScheduleEntryKind, 'study'>;

// Everything in the space, plus this member's own study timetable
const visibleTo = (spaceId: Types.ObjectId, userId: string) => ({
  space: spaceId,
  $or: [{ kind: { $ne: 'study' } }, { kind: 'study', owner: new Types.ObjectId(userId) }],
});
import { notify } from '../utils/notify';
import { sendError, sendSuccess } from '../utils/response';
import { entryName, entryWhen, homeSpaceIdFor, prefsOf } from '../utils/schedule';
import { loadSpace } from './space.controller';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_MAX = 20;
const TITLE_MAX = 100;
const VENUE_MAX = 60;
const NOTE_MAX = 200;
const ENTRIES_MAX = 300;
// Edits close together become one feed item and one notification
const GROUP_WINDOW_MS = 30 * 60 * 1000;
const PUSH_QUIET_MS = 2 * 60 * 1000;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');

const CLASSES_MAX = 100;

// A linked course's current code and name win, so renaming a course updates
// the timetable too
const toPublicEntry = (space: Pick<ISpace, 'courses'>) => (entry: IScheduleEntry) => {
  const course = entry.course ? space.courses.id(entry.course) : null;
  return {
    id: String(entry._id),
    kind: entry.kind,
    ...(entry.day ? { day: entry.day } : { date: entry.date }),
    courseId: course ? String(course._id) : null,
    startTime: entry.startTime,
    endTime: entry.endTime,
    courseCode: course?.code ?? entry.courseCode,
    title: course?.title ?? entry.title,
    venue: entry.venue,
    note: entry.note,
  };
};

const sortEntries = (entries: IScheduleEntry[]) =>
  [...entries].sort(
    (a, b) =>
      (a.day ? String(a.day) : (a.date ?? '')).localeCompare(b.day ? String(b.day) : (b.date ?? '')) ||
      a.startTime.localeCompare(b.startTime)
  );

type EntryValues = Pick<IScheduleEntry, 'startTime' | 'endTime' | 'courseCode' | 'title' | 'venue' | 'note'> & {
  day?: number;
  date?: string;
  course?: Types.ObjectId;
};

// Checks a whole entry; `kind` decides whether it needs a weekday or a date.
// Classes and exams can name a space course by `courseId` instead of typing it
const parseEntry = (
  kind: ScheduleEntryKind,
  body: Record<string, unknown>,
  space: ISpace
): EntryValues | { error: string } => {
  const startTime = text(body.startTime);
  const endTime = text(body.endTime);
  const courseId = text(body.courseId);
  const course = Types.ObjectId.isValid(courseId) ? space.courses.id(courseId) : null;
  if (courseId && !course) return { error: 'That course is no longer in this space' };
  const courseCode = course ? course.code : text(body.courseCode).toUpperCase();
  const title = course ? course.title : text(body.title);
  const venue = text(body.venue);
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  if (!TIME.test(startTime) || !TIME.test(endTime)) return { error: 'Use times like 08:00' };
  if (endTime <= startTime) return { error: 'The end time must be after the start time' };
  if (courseCode.length > CODE_MAX) return { error: 'That course code is too long' };
  if (title.length > TITLE_MAX) return { error: 'That title is too long' };
  if (venue.length > VENUE_MAX) return { error: 'That venue is too long' };
  if (note.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters` };
  if (!courseCode) return { error: 'Choose a course' };

  if (kind === 'class') {
    const day = Number(body.day);
    if (!Number.isInteger(day) || day < 1 || day > 7) return { error: 'Choose a day' };
    return { day, startTime, endTime, courseCode, title, venue, note, course: course?._id };
  }
  const date = text(body.date);
  if (!DATE.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return { error: 'Choose a date' };
  return { date, startTime, endTime, courseCode, title, venue, note, course: course?._id };
};

// ── Telling members ───────────────────────────────────────────────────────────

const FEED_TITLE: Record<SharedKind, string> = {
  class: 'Class timetable updated',
  test: 'Test timetable updated',
  exam: 'Exam timetable updated',
};

const pendingPush = new Map<string, NodeJS.Timeout>();

// One feed item per burst of edits, and one push to members once the owner
// has stopped editing for a couple of minutes
const announce = async (space: ISpace, ownerId: string, kind: ScheduleEntryKind, detail: string, removed = false) => {
  // Study is private: nothing to tell anyone
  if (kind === 'study') return;
  const owner = await User.findById(ownerId).select('firstName').lean();
  const postedBy = owner?.firstName ?? 'The owner';
  const feedKind: ScheduleKind = removed ? 'cancelled' : kind === 'class' ? 'timetable' : kind;
  const title = FEED_TITLE[kind];

  const latest = space.scheduleUpdates[space.scheduleUpdates.length - 1];
  if (
    latest &&
    latest.title === title &&
    latest.postedBy === postedBy &&
    Date.now() - latest.at.getTime() < GROUP_WINDOW_MS
  ) {
    latest.detail = detail;
    latest.at = new Date();
  } else {
    space.scheduleUpdates.push({ kind: feedKind, title, detail, postedBy, at: new Date() });
  }
  // Keep the feed short
  if (space.scheduleUpdates.length > 50) space.scheduleUpdates.splice(0, space.scheduleUpdates.length - 50);
  await space.save();

  const key = `${space._id}:${kind}`;
  clearTimeout(pendingPush.get(key));
  pendingPush.set(
    key,
    setTimeout(async () => {
      pendingPush.delete(key);
      const members = await SpaceMember.find({
        space: space._id,
        status: 'active',
        user: { $ne: new Types.ObjectId(ownerId) },
      }).lean();
      await notify(
        members.map((member) => member.user!).filter(Boolean),
        {
          category: 'schedule',
          kind: 'schedule-change',
          title: `${title} · ${space.name}`,
          body: detail,
          link: `/classes/${space.slug}?tab=schedule`,
          image: space.imageUrl ?? null,
        },
        { push: true }
      );
    }, PUSH_QUIET_MS)
  );
};

// ── Routes ────────────────────────────────────────────────────────────────────

const respondSchedule = async (res: Response, space: ISpace, userId: string, role: string, status = 200, message?: string) => {
  const [entries, membership] = await Promise.all([
    ScheduleEntry.find(visibleTo(space._id, userId)),
    SpaceMember.findOne({ space: space._id, user: userId }).lean(),
  ]);
  const homeId = membership?.onHome === true ? space._id : await homeSpaceIdFor(userId);
  sendSuccess(
    res,
    {
      timezone: space.timezone,
      canEdit: role === 'owner',
      onHome: Boolean(homeId && String(homeId) === String(space._id)),
      prefs: prefsOf(membership),
      entries: sortEntries(entries).map(toPublicEntry(space)),
    },
    message,
    status
  );
};

// GET /api/v1/spaces/:slug/schedule
export const getSchedule = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    await respondSchedule(res, found.space, found.userId, found.membership.role);
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/spaces/:slug/schedule (owner)
export const addEntry = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (membership.role !== 'owner') return sendError(res, 'Only the owner can change the schedule', 403);

    const kind = req.body?.kind as ScheduleEntryKind;
    if (!SCHEDULE_ENTRY_KINDS.includes(kind) || kind === 'study') return sendError(res, 'Choose class, test or exam', 400);
    const values = parseEntry(kind, req.body ?? {}, space);
    if ('error' in values) return sendError(res, values.error, 400);
    if ((await ScheduleEntry.countDocuments({ space: space._id })) >= ENTRIES_MAX) {
      return sendError(res, `A schedule can hold up to ${ENTRIES_MAX} entries`, 400);
    }

    const entry = await ScheduleEntry.create({ ...values, kind, space: space._id, createdBy: userId });
    await announce(space, userId, kind, `${entryName(entry)}, ${entryWhen(entry)}${entry.venue ? `, ${entry.venue}` : ''}`);
    await respondSchedule(res, space, userId, membership.role, 201, 'Added to the schedule');
  } catch (error) {
    next(error);
  }
};

const findEntry = (space: ISpace, entryId: string) =>
  Types.ObjectId.isValid(entryId) ? ScheduleEntry.findOne({ _id: entryId, space: space._id }) : null;

// PATCH /api/v1/spaces/:slug/schedule/:entryId (owner) — send the whole entry
export const updateEntry = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (membership.role !== 'owner') return sendError(res, 'Only the owner can change the schedule', 403);
    const entry = await findEntry(space, String(req.params.entryId));
    if (!entry || entry.kind === 'study') return sendError(res, 'That entry no longer exists', 404);

    const values = parseEntry(entry.kind, req.body ?? {}, space);
    if ('error' in values) return sendError(res, values.error, 400);
    entry.set({ ...values, day: values.day ?? undefined, date: values.date ?? undefined, course: values.course ?? undefined });
    await entry.save();
    await announce(space, userId, entry.kind, `${entryName(entry)} is now ${entryWhen(entry)}${entry.venue ? `, ${entry.venue}` : ''}`);
    await respondSchedule(res, space, userId, membership.role, 200, 'Schedule updated');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/spaces/:slug/schedule/:entryId (owner)
export const removeEntry = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    const entry = await findEntry(space, String(req.params.entryId));
    const ownStudy = entry?.kind === 'study' && String(entry.owner) === userId;
    if (!entry || (entry.kind === 'study' && !ownStudy)) return sendError(res, 'That entry no longer exists', 404);
    if (!ownStudy && membership.role !== 'owner') return sendError(res, 'Only the owner can change the schedule', 403);

    await entry.deleteOne();
    await announce(space, userId, entry.kind, `${entryName(entry)} on ${entryWhen(entry)} was removed`, true);
    await respondSchedule(res, space, userId, membership.role, 200, 'Removed from the schedule');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/spaces/:slug/home — stop showing this space's schedule on Home
export const hideFromHome = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    await SpaceMember.updateOne({ _id: membership._id }, { $set: { onHome: false } });
    await respondSchedule(res, space, userId, membership.role, 200, 'Removed from Home');
  } catch (error) {
    next(error);
  }
};

// PUT /api/v1/spaces/:slug/home — show this space's schedule on your Home
export const setHomeSpace = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    await SpaceMember.updateMany({ user: userId, onHome: true }, { $set: { onHome: false } });
    await SpaceMember.updateOne({ _id: membership._id }, { $set: { onHome: true } });
    await respondSchedule(res, space, userId, membership.role, 200, 'This schedule now shows on Home');
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/schedule/home — the schedule on your Home
export const getHomeSchedule = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const spaceId = await homeSpaceIdFor(req.user!.id);
    const space = spaceId ? await Space.findById(spaceId).select('name slug timezone imageUrl courses') : null;
    if (!space) return sendSuccess(res, { space: null, timezone: 'Africa/Lagos', entries: [] });
    const membership = await SpaceMember.findOne({ space: space._id, user: req.user!.id }).lean();
    const prefs = prefsOf(membership);
    // Only the kinds they chose to show on Home
    const entries = (await ScheduleEntry.find(visibleTo(space._id, req.user!.id))).filter(
      (entry) => prefs[entry.kind].home
    );
    sendSuccess(res, {
      space: { slug: space.slug, name: space.name, imageUrl: space.imageUrl ?? null },
      timezone: space.timezone,
      entries: sortEntries(entries).map(toPublicEntry(space)),
    });
  } catch (error) {
    next(error);
  }
};

const NOUN: Record<ScheduleEntryKind, [string, string]> = {
  class: ['class', 'classes'],
  exam: ['exam', 'exams'],
  test: ['test', 'tests'],
  study: ['session', 'sessions'],
};

// PUT /api/v1/spaces/:slug/schedule/{classes|exams|tests|study} { entries: [...] }
// Replaces every entry of one kind in one go: one change and one notification
// however many it holds. Classes, exams and tests are the owner's; study is
// each member's own. Classes and study take a weekday, exams and tests a date
export const saveAll =
  (kind: ScheduleEntryKind) =>
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const found = await loadSpace(req, res);
      if (!found) return;
      const { space, membership, userId } = found;
      if (kind !== 'study' && membership.role !== 'owner') {
        return sendError(res, 'Only the owner can change the schedule', 403);
      }

      const raw: unknown[] = Array.isArray(req.body?.entries) ? req.body.entries : [];
      if (raw.length > CLASSES_MAX) return sendError(res, `A schedule can hold up to ${CLASSES_MAX} entries`, 400);
      const parsed: EntryValues[] = [];
      for (const item of raw) {
        // Study slots are checked like classes: a weekday, times and a course
        const values = parseEntry(kind === 'study' ? 'class' : kind, (item ?? {}) as Record<string, unknown>, space);
        if ('error' in values) return sendError(res, values.error, 400);
        parsed.push(values);
      }

      const mine = kind === 'study' ? { owner: new Types.ObjectId(userId) } : {};
      const before = await ScheduleEntry.countDocuments({ space: space._id, kind, ...mine });
      await ScheduleEntry.deleteMany({ space: space._id, kind, ...mine });
      if (parsed.length) {
        await ScheduleEntry.insertMany(
          parsed.map((values) => ({ ...values, kind, space: space._id, createdBy: userId, ...mine }))
        );
      }
      const [one, many] = NOUN[kind];
      const detail = parsed.length
        ? kind === 'class'
          ? `${parsed.length} ${parsed.length === 1 ? one : many} across ${new Set(parsed.map((v) => v.day)).size} days`
          : `${parsed.length} ${parsed.length === 1 ? one : many} on the timetable`
        : before
          ? `The ${one} timetable was cleared`
          : `No ${many} yet`;
      await announce(space, userId, kind, detail);
      await respondSchedule(res, space, userId, membership.role, 200, 'Schedule saved');
    } catch (error) {
      next(error);
    }
  };

// PATCH /api/v1/spaces/:slug/schedule/prefs { kind, home?, remind? }
// Your own choice, per kind, of what shows on Home and what reminds you.
// Showing anything on Home makes this the space on Home
export const setPrefs = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    const kind = req.body?.kind as ScheduleEntryKind;
    if (!SCHEDULE_ENTRY_KINDS.includes(kind)) return sendError(res, 'Choose a schedule', 400);

    const prefs = prefsOf(membership);
    if (typeof req.body.home === 'boolean') prefs[kind].home = req.body.home;
    if (typeof req.body.remind === 'boolean') prefs[kind].remind = req.body.remind;
    const update: Record<string, unknown> = { schedulePrefs: prefs };

    if (req.body.home === true) {
      await SpaceMember.updateMany({ user: userId, onHome: true, _id: { $ne: membership._id } }, { $set: { onHome: false } });
      update.onHome = true;
    } else if (req.body.home === false && SCHEDULE_ENTRY_KINDS.every((k) => !prefs[k].home)) {
      // Nothing left to show: take the space off Home
      update.onHome = false;
    }
    await SpaceMember.updateOne({ _id: membership._id }, { $set: update });
    await respondSchedule(res, space, userId, membership.role, 200, 'Saved');
  } catch (error) {
    next(error);
  }
};
