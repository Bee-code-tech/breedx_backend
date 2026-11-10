import { Document, Types } from 'mongoose';

// What a notification is about. Each has its own switches for push and email
export const NOTIFICATION_CATEGORIES = ['schedule', 'study', 'quizzes', 'spaces', 'ai', 'account', 'announcements'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface ChannelPrefs {
  push: boolean;
  email: boolean;
}

export type NotificationPrefs = Record<NotificationCategory, ChannelPrefs>;

/** Out of the box: push for what's time-sensitive, email only for what matters a lot. */
export const DEFAULT_PREFS: NotificationPrefs = {
  schedule: { push: true, email: true },
  study: { push: true, email: false },
  quizzes: { push: true, email: false },
  spaces: { push: true, email: true },
  ai: { push: true, email: false },
  account: { push: true, email: true },
  announcements: { push: false, email: true },
};

/** One item under the bell. */
export interface INotification extends Document {
  user: Types.ObjectId;
  category: NotificationCategory;
  /** What exactly happened, e.g. class-reminder, quiz-taken. For icons and analytics. */
  kind: string;
  title: string;
  body: string;
  /** Where tapping it goes, e.g. /quizzes?warmup=… */
  link: string;
  /** A picture for it, e.g. a space's image. */
  image: string | null;
  /** Similar notifications share one, so "5 people took your quiz" stays a single item. */
  groupKey: string | null;
  count: number;
  readAt: Date | null;
  /** When it went out as a push, for the daily cap. */
  pushedAt: Date | null;
  emailedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
