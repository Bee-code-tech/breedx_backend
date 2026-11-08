import env from '../config/env';
import ScheduleEntry from '../models/scheduleEntry.model';
import ReminderLog from '../models/reminderLog.model';
import Space from '../models/space.model';
import SpaceMember from '../models/spaceMember.model';
import { IScheduleEntry } from '../types/space';
import { pushEnabled, pushToUsers } from './push';
import { clock, entryName, prefsOf, zonedParts } from './schedule';

const MINUTE = 60 * 1000;

// How far ahead each kind is announced
const LEAD = { class: 30, test: 60, exam: 60, study: 10 } as const;
// Tests and exams also get an evening-before reminder at this local time
const EXAM_EVE = '18:00';

const remind = async (entry: IScheduleEntry, key: string, title: string, body: string, slug: string) => {
  try {
    await ReminderLog.create({ key });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return; // already sent
    throw error;
  }
  // Study is personal: only its owner hears about it, if they want to
  if (entry.kind === 'study') {
    const own = entry.owner && (await SpaceMember.findOne({ space: entry.space, user: entry.owner }).lean());
    if (own && entry.owner && prefsOf(own).study.remind) await pushToUsers([entry.owner], { title, body, url: `/classes/${slug}?tab=schedule`, tag: key });
    return;
  }
  // Everyone in the space who left this kind's reminders on
  const members = await SpaceMember.find({ space: entry.space, status: 'active' }).lean();
  const recipients = members
    .filter((member) => member.user && prefsOf(member)[entry.kind].remind)
    .map((member) => member.user!);
  await pushToUsers(recipients, { title, body, url: `/classes/${slug}?tab=schedule`, tag: key });
};

export const checkReminders = async (now = new Date()) => {
  const zones: string[] = await Space.distinct('timezone');

  for (const timeZone of zones) {
    const spaces = await Space.find({ timezone: timeZone }).select('_id slug name courses').lean();
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
          space.slug
        );
      }
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

// Checks once a minute, just after the minute turns. Runs in production only,
// so a laptop pointed at the same database doesn't race it; set REMINDERS=on
// to run it locally. Each reminder is logged once, so two runners never double-send
export const startReminders = (): void => {
  if (env.NODE_ENV !== 'production' && process.env.REMINDERS !== 'on') return;
  if (!pushEnabled) {
    console.log('Schedule reminders are off: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to turn them on');
    return;
  }
  const run = () =>
    checkReminders().catch((error) => {
      console.error('Reminder check failed:', error);
    });
  setTimeout(() => {
    void run();
    setInterval(run, MINUTE);
  }, MINUTE - (Date.now() % MINUTE) + 2000);
};
