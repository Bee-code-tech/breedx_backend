import env from '../config/env';
import ScheduleEntry from '../models/scheduleEntry.model';
import ReminderLog from '../models/reminderLog.model';
import Space from '../models/space.model';
import SpaceMember from '../models/spaceMember.model';
import { IScheduleEntry } from '../types/space';
import { Types } from 'mongoose';
import { pushEnabled } from './push';
import { notify } from './notify';
import { clearStaleMaterialUploads } from './materials';
import StudyDay from '../models/studyDay.model';
import User from '../models/user.model';
import { addDays, DEFAULT_TIMEZONE, isTimeZone, streakFor } from './activity';
import { clock, entryName, prefsOf, zonedParts } from './schedule';
import Warmup from '../models/warmup.model';
import { IWarmup } from '../types/progress';
import { Course, prepareWarmup, WARMUP_MINUTES, WARMUP_QUESTIONS } from './warmups';

const MINUTE = 60 * 1000;

// How far ahead each kind is announced
const LEAD = { class: 30, test: 60, exam: 60, study: 10 } as const;
// Tests and exams also get an evening-before reminder at this local time
const EXAM_EVE = '18:00';
// Warm-ups are made this long before a class, ready for its 30-minute reminder
const WARMUP_PREP = 60;
// Warm-ups being made right now, so a slow one isn't started twice
const preparing = new Set<string>();

const WARMUP_LINES: Record<IWarmup['reason'], (topic: string) => string> = {
  next: (topic) => `Warm-up: ${topic}`,
  retry: (topic) => `Let's go over ${topic} again`,
  recheck: (topic) => `Quick recheck: ${topic}`,
  review: (topic) => `Review: ${topic}`,
};

/** The class reminder, as a warm-up: what topic, how long, and where it sits on the course. */
const warmupMessage = (entry: IScheduleEntry, warmup: IWarmup, where: string) => ({
  title: `${entryName(entry)} in ${LEAD.class} mins ⚡`,
  body:
    `${WARMUP_LINES[warmup.reason](warmup.topicTitle)} · ${WARMUP_QUESTIONS} questions, ~${WARMUP_MINUTES} min` +
    `\n${warmup.covered} of ${warmup.totalTopics} topics covered · ${clock(entry.startTime)}${where}`,
  url: `/quizzes?warmup=${warmup._id}`,
});

/**
 * Makes each member's warm-up for a class an hour before it. Runs in the
 * background so a slow one never holds up the minute's reminders.
 */
const prepareClassWarmups = async (
  entry: IScheduleEntry,
  space: { _id: Types.ObjectId; rules?: { warmups?: boolean }; courses?: Course[] },
  date: string
) => {
  // Warm-ups come only from the class's own course, so a class without one gets none
  const course = space.courses?.find((item) => String(item._id) === String(entry.course));
  if (!course || space.rules?.warmups === false) return;
  const members = await SpaceMember.find({ space: entry.space, status: 'active' }).lean();
  for (const member of members) {
    if (!member.user || !prefsOf(member).class.remind) continue;
    const key = `${member.user}:${entry._id}:${date}`;
    if (preparing.has(key)) continue;
    preparing.add(key);
    try {
      await prepareWarmup(String(member.user), space, entry, course, date);
    } catch (error) {
      console.error('Preparing a warm-up failed:', error);
    } finally {
      preparing.delete(key);
    }
  }
};

const remind = async (
  entry: IScheduleEntry,
  key: string,
  title: string,
  body: string,
  slug: string,
  /** For classes: the date, to send each member's warm-up if one is ready. */
  warmupDate?: string
) => {
  try {
    await ReminderLog.create({ key });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return; // already sent
    throw error;
  }
  // Under the bell and as a push. "Soon" reminders are time-sensitive, so they
  // skip quiet hours; the evening before a test or exam also goes by email
  const eve = key.endsWith(':eve');
  const send = (users: (string | Types.ObjectId)[]) =>
    notify(
      users,
      {
        category: 'schedule',
        kind: eve ? `${entry.kind}-tomorrow` : `${entry.kind}-reminder`,
        title,
        body,
        link: `/classes/${slug}?tab=schedule`,
      },
      { push: true, urgent: !eve, email: eve ? { action: 'See your schedule' } : false }
    );

  // Study is personal: only its owner hears about it, if they want to
  if (entry.kind === 'study') {
    const own = entry.owner && (await SpaceMember.findOne({ space: entry.space, user: entry.owner }).lean());
    if (own && entry.owner && prefsOf(own).study.remind) await send([entry.owner]);
    return;
  }
  // Everyone in the space who left this kind's reminders on
  const members = await SpaceMember.find({ space: entry.space, status: 'active' }).lean();
  let recipients = members
    .filter((member) => member.user && prefsOf(member)[entry.kind].remind)
    .map((member) => member.user!);

  // A class: anyone with a warm-up ready gets it instead of the plain reminder
  if (warmupDate) {
    const warmups = await Warmup.find({ entry: entry._id, date: warmupDate, status: 'ready', user: { $in: recipients } });
    const where = entry.venue ? ` in ${entry.venue}` : '';
    for (const warmup of warmups) {
      const message = warmupMessage(entry, warmup, where);
      await notify(
        [warmup.user],
        { category: 'schedule', kind: 'warmup', title: message.title, body: message.body, link: message.url },
        { push: true, urgent: true }
      );
      await Warmup.updateOne({ _id: warmup._id }, { $set: { status: 'sent' } });
    }
    const warmed = new Set(warmups.map((warmup) => String(warmup.user)));
    recipients = recipients.filter((user) => !warmed.has(String(user)));
  }
  await send(recipients);
};

export const checkReminders = async (now = new Date()) => {
  const zones: string[] = await Space.distinct('timezone');

  for (const timeZone of zones) {
    const spaces = await Space.find({ timezone: timeZone }).select('_id slug name courses rules').lean();
    const byId = new Map(spaces.map((space) => [String(space._id), space]));
    const ids = spaces.map((space) => space._id);

    for (const kind of ['class', 'test', 'exam', 'study'] as const) {
      const at = zonedParts(new Date(now.getTime() + LEAD[kind] * MINUTE), timeZone);
      const entries = await ScheduleEntry.find({
        space: { $in: ids },
        kind,
        startTime: at.time,
        ...(kind === 'class' || kind === 'study' ? { day: at.day } : { date: at.date }),
      });
      for (const entry of entries) {
        const space = byId.get(String(entry.space));
        if (!space) continue;
        const where = entry.venue ? ` in ${entry.venue}` : '';
        // A class linked to a course suggests its newest material to look over
        const material =
          (kind === 'class' || kind === 'study') && entry.course
            ? space.courses
                ?.find((course) => String(course._id) === String(entry.course))
                ?.materials.slice()
                .sort((a: { uploadedAt: Date }, b: { uploadedAt: Date }) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())[0]
            : undefined;
        const title =
          kind === 'class'
            ? `Class in ${LEAD.class} minutes`
            : kind === 'study'
              ? `Study time in ${LEAD.study} minutes`
              : kind === 'exam'
                ? 'Exam in 1 hour'
                : 'Test in 1 hour';
        await remind(
          entry,
          `${entry._id}:${at.date}:soon`,
          title,
          `${entryName(entry)} at ${clock(entry.startTime)}${where} · ${space.name}${material ? `\nLook over: ${material.title}` : ''}`,
          space.slug,
          kind === 'class' ? at.date : undefined
        );
      }
    }

    // Warm-ups for classes starting in an hour
    const prepAt = zonedParts(new Date(now.getTime() + WARMUP_PREP * MINUTE), timeZone);
    const upcoming = await ScheduleEntry.find({ space: { $in: ids }, kind: 'class', day: prepAt.day, startTime: prepAt.time });
    for (const entry of upcoming) {
      const space = byId.get(String(entry.space));
      if (space) void prepareClassWarmups(entry, space as unknown as Parameters<typeof prepareClassWarmups>[1], prepAt.date);
    }

    // Evening before a test or exam
    const local = zonedParts(now, timeZone);
    if (local.time === EXAM_EVE) {
      const tomorrow = zonedParts(new Date(now.getTime() + 24 * 60 * MINUTE), timeZone).date;
      const exams = await ScheduleEntry.find({ space: { $in: ids }, kind: { $in: ['test', 'exam'] }, date: tomorrow });
      for (const exam of exams) {
        const space = byId.get(String(exam.space));
        if (!space) continue;
        await remind(
          exam,
          `${exam._id}:${tomorrow}:eve`,
          exam.kind === 'exam' ? 'Exam tomorrow' : 'Test tomorrow',
          `${entryName(exam)} at ${clock(exam.startTime)}${exam.venue ? ` in ${exam.venue}` : ''} · ${space.name}`,
          space.slug
        );
      }
    }
  }
};

// The evening nudge for students whose streak ends tonight
const STREAK_CHECK = '20:00';
const STREAK_MIN = 2;

/**
 * At 8 pm in each student's timezone: anyone who studied yesterday, hasn't
 * today, and has a streak of 2+ days gets a nudge to keep it.
 */
export const checkStreaks = async (now = new Date()) => {
  const zones = new Set<string>([DEFAULT_TIMEZONE, ...((await User.distinct('timezone')) as string[]).filter(isTimeZone)]);
  for (const timeZone of zones) {
    const local = zonedParts(now, timeZone);
    if (local.time !== STREAK_CHECK) continue;
    const yesterday = addDays(local.date, -1);
    const studiedYesterday = (await StudyDay.find({ day: yesterday }).select('user').lean()).map((entry) => entry.user);
    const studiedToday = new Set(
      (await StudyDay.find({ day: local.date, user: { $in: studiedYesterday } }).select('user').lean()).map((entry) => String(entry.user))
    );
    // Only students whose own timezone is this one
    const users = await User.find({
      _id: { $in: studiedYesterday.filter((user) => !studiedToday.has(String(user))) },
      ...(timeZone === DEFAULT_TIMEZONE ? { $or: [{ timezone: timeZone }, { timezone: null }] } : { timezone: timeZone }),
    })
      .select('_id')
      .lean();

    for (const user of users) {
      const userId = String(user._id);
      const streak = await streakFor(userId, timeZone);
      if (streak.current < STREAK_MIN) continue;
      try {
        await ReminderLog.create({ key: `streak:${userId}:${local.date}` });
      } catch {
        continue; // already sent today
      }
      await notify(
        [userId],
        {
          category: 'study',
          kind: 'streak',
          title: `🔥 Your ${streak.current}-day streak ends tonight`,
          body: 'Take a quick quiz, review a few flashcards or read a page to keep it going.',
          link: '/home',
        },
        { push: true }
      );
    }
  }
};

const PLAN_NAMES: Record<string, string> = { scholar: 'Scholar', elite: 'Elite' };
// How long before a paid plan ends its reminder goes out
const PLAN_WARNING_DAYS = 3;

/**
 * Once an hour: paid plans ending within 3 days get one reminder per end
 * date, so a renewal that moves the date gets its own.
 */
export const checkPlanEndings = async (now = new Date()) => {
  if (now.getUTCMinutes() !== 0) return;
  const users = await User.find({
    plan: { $ne: 'free' },
    planExpiresAt: { $gt: now, $lte: new Date(now.getTime() + PLAN_WARNING_DAYS * 24 * 60 * MINUTE) },
  })
    .select('plan planExpiresAt timezone')
    .lean();

  for (const user of users) {
    const ends = user.planExpiresAt as Date;
    try {
      await ReminderLog.create({ key: `plan-ending:${user._id}:${ends.toISOString()}` });
    } catch {
      continue; // already reminded about this end date
    }
    const timeZone = user.timezone && isTimeZone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE;
    const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone }).format(ends);
    await notify(
      [user._id],
      {
        category: 'account',
        kind: 'plan-ending',
        title: `Your ${PLAN_NAMES[user.plan] ?? 'paid'} plan ends on ${date}`,
        body: 'Renew to keep your AI energy and limits.',
        link: '/settings?tab=billing',
      },
      { push: true, email: { action: 'Renew plan' } }
    );
  }
};

// Checks once a minute, just after the minute turns. Runs in production only,
// so a laptop pointed at the same database doesn't race it; set REMINDERS=on
// to run it locally. Each reminder is logged once, so two runners never double-send
export const startReminders = (): void => {
  if (env.NODE_ENV !== 'production' && process.env.REMINDERS !== 'on') return;
  // Reminders still reach the bell without push keys; they just don't buzz phones
  if (!pushEnabled) console.log('Push is off: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to send reminders to phones');
  const run = () =>
    Promise.all([
      checkReminders().catch((error) => console.error('Reminder check failed:', error)),
      checkStreaks().catch((error) => console.error('Streak check failed:', error)),
      checkPlanEndings().catch((error) => console.error('Plan ending check failed:', error)),
      clearStaleMaterialUploads().catch((error) => console.error('Clearing old uploads failed:', error)),
    ]);
  setTimeout(() => {
    void run();
    setInterval(run, MINUTE);
  }, MINUTE - (Date.now() % MINUTE) + 2000);
};
