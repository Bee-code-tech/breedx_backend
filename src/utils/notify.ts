import { Types } from 'mongoose';
import env from '../config/env';
import Notification from '../models/notification.model';
import User from '../models/user.model';
import { DEFAULT_PREFS, NotificationCategory, NotificationPrefs, NOTIFICATION_CATEGORIES } from '../types/notification';
import { IUser } from '../types/user';
import { DEFAULT_TIMEZONE, isTimeZone } from './activity';
import { sendNotificationEmail } from './mail';
import { pushToUsers } from './push';
import { zonedParts } from './schedule';

// Pushes that aren't urgent stop for the day after this many
const DAILY_PUSH_CAP = 6;
// No pushes between these hours in the student's timezone, unless urgent
const QUIET_FROM = '22:00';
const QUIET_UNTIL = '07:00';
// A grouped notification joins the last one with its key if that's this recent and unread
const GROUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// For the email footer: "You received this because <name> emails are on"
const CATEGORY_NAMES: Record<NotificationCategory, string> = {
  schedule: 'schedule',
  study: 'study',
  quizzes: 'quiz',
  spaces: 'space',
  ai: 'AI',
  account: 'account',
  announcements: 'BreedX news',
};

/** The student's switches, with defaults for any they haven't set. */
export const prefsOf = (user: Pick<IUser, 'notificationPrefs'> | null): NotificationPrefs =>
  Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [
      category,
      { ...DEFAULT_PREFS[category], ...(user?.notificationPrefs?.[category] ?? {}) },
    ])
  ) as NotificationPrefs;

const inQuietHours = (timeZone: string, now = new Date()) => {
  const { time } = zonedParts(now, timeZone);
  return time >= QUIET_FROM || time < QUIET_UNTIL;
};

export interface NotificationInput {
  category: NotificationCategory;
  kind: string;
  title: string;
  body?: string;
  /** App path, e.g. /quizzes?warmup=… */
  link?: string;
  image?: string | null;
  /**
   * Joins an unread notification with the same key from the last day instead
   * of adding a new one. `title` and `body` get the new count, e.g. "5 people took your quiz".
   */
  group?: { key: string; title: (count: number) => string; body?: (count: number) => string };
}

export interface NotifyOptions {
  /** Worth a push (the student's switch for the category still decides). */
  push?: boolean;
  /** Worth an email; `action` is the button text. */
  email?: boolean | { action?: string };
  /** Ignores quiet hours and the daily cap: class reminders, security. */
  urgent?: boolean;
}

/**
 * Tells students about something. It always goes under the bell; it also
 * goes out as a push and an email when the call asks for them, the student's
 * switches allow it, and (for pushes) it's not quiet hours or past the
 * day's cap. Never throws.
 */
export const notify = async (
  userIds: (string | Types.ObjectId)[],
  input: NotificationInput,
  options: NotifyOptions = {}
): Promise<void> => {
  const ids = [...new Set(userIds.map(String))];
  if (!ids.length) return;
  try {
    const users = await User.find({ _id: { $in: ids } })
      .select('firstName email timezone notificationPrefs')
      .lean<IUser[]>();
    const now = new Date();

    await Promise.all(
      users.map(async (user) => {
        const userId = String(user._id);
        const prefs = prefsOf(user)[input.category];

        // Save it, or add to the group it belongs to
        let isNew = true;
        let notification = null;
        if (input.group) {
          const existing = await Notification.findOne({
            user: userId,
            groupKey: input.group.key,
            readAt: null,
            updatedAt: { $gte: new Date(now.getTime() - GROUP_WINDOW_MS) },
          });
          if (existing) {
            isNew = false;
            existing.count += 1;
            existing.title = input.group.title(existing.count);
            existing.body = input.group.body?.(existing.count) ?? input.body ?? existing.body;
            notification = await existing.save();
          }
        }
        notification ??= await Notification.create({
          user: userId,
          category: input.category,
          kind: input.kind,
          title: input.group ? input.group.title(1) : input.title,
          body: input.group?.body?.(1) ?? input.body ?? '',
          link: input.link ?? '/home',
          image: input.image ?? null,
          groupKey: input.group?.key ?? null,
        });

        // Push: only the first of a group, so it doesn't buzz for every one
        if (options.push && prefs.push && isNew) {
          const timeZone = user.timezone && isTimeZone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE;
          const allowed =
            options.urgent ||
            (!inQuietHours(timeZone, now) &&
              (await Notification.countDocuments({
                user: userId,
                pushedAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
              })) < DAILY_PUSH_CAP);
          if (allowed) {
            const unread = await Notification.countDocuments({ user: userId, readAt: null });
            await pushToUsers([userId], {
              title: notification.title,
              body: notification.body,
              url: notification.link,
              tag: input.group?.key ?? String(notification._id),
              notificationId: String(notification._id),
              unread,
              kind: input.kind,
              urgent: Boolean(options.urgent),
            });
            await Notification.updateOne({ _id: notification._id }, { $set: { pushedAt: now } });
          }
        }

        // Email: also only the first of a group
        if (options.email && prefs.email && isNew && user.email) {
          await sendNotificationEmail(user.email, {
            firstName: user.firstName,
            heading: notification.title,
            body: notification.body,
            action: typeof options.email === 'object' && options.email.action ? options.email.action : 'Open BreedX',
            url: `${env.APP_URL}${notification.link}`,
            reason: CATEGORY_NAMES[input.category],
          })
            .then(() => Notification.updateOne({ _id: notification!._id }, { $set: { emailedAt: new Date() } }))
            .catch((error) => console.error('Notification email failed:', error));
        }
      })
    );
  } catch (error) {
    console.error('Notify failed:', error);
  }
};
