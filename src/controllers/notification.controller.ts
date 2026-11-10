import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import Notification from '../models/notification.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { INotification, NOTIFICATION_CATEGORIES, NotificationCategory } from '../types/notification';
import { IUser } from '../types/user';
import { notify, prefsOf } from '../utils/notify';
import { sendError, sendSuccess } from '../utils/response';

const PAGE = 30;
const ANNOUNCE_BATCH = 500;

const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);

const toPublicNotification = (notification: INotification) => ({
  id: notification._id,
  category: notification.category,
  kind: notification.kind,
  title: notification.title,
  body: notification.body,
  link: notification.link,
  image: notification.image,
  count: notification.count,
  read: Boolean(notification.readAt),
  createdAt: notification.createdAt,
  updatedAt: notification.updatedAt,
});

const unreadCount = (userId: string) => Notification.countDocuments({ user: userId, readAt: null });

/** The bell: newest first. `?before=<updatedAt>` loads older ones, `?unread=true` only unread. */
export const listNotifications = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
    const notifications = await Notification.find({
      user: userId,
      ...(req.query.unread === 'true' && { readAt: null }),
      ...(before && !Number.isNaN(before.getTime()) && { updatedAt: { $lt: before } }),
    })
      .sort({ updatedAt: -1 })
      .limit(PAGE + 1)
      .lean<INotification[]>();
    sendSuccess(res, {
      notifications: notifications.slice(0, PAGE).map(toPublicNotification),
      hasMore: notifications.length > PAGE,
      unreadCount: await unreadCount(userId),
    });
  } catch (error) {
    next(error);
  }
};

/** Just the number for the bell's dot; cheap enough to poll every minute. */
export const getUnreadCount = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, { unreadCount: await unreadCount(req.user!.id) });
  } catch (error) {
    next(error);
  }
};

/** `{ "ids": ["…"] }` marks those as read; `{ "all": true }` marks everything. */
export const markRead = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isId) : [];
    if (!ids.length && req.body?.all !== true) {
      sendError(res, 'Send ids, or all: true', 400);
      return;
    }
    await Notification.updateMany(
      { user: userId, readAt: null, ...(req.body?.all === true ? {} : { _id: { $in: ids } }) },
      { $set: { readAt: new Date() } }
    );
    sendSuccess(res, { unreadCount: await unreadCount(userId) });
  } catch (error) {
    next(error);
  }
};

export const deleteNotification = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const deleted = isId(req.params.id) ? await Notification.deleteOne({ _id: req.params.id, user: userId }) : null;
    if (!deleted?.deletedCount) {
      sendError(res, 'Notification not found', 404);
      return;
    }
    sendSuccess(res, { unreadCount: await unreadCount(userId) });
  } catch (error) {
    next(error);
  }
};

/** Push and email switches for each category. */
export const getPreferences = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id).select('notificationPrefs').lean<IUser>();
    sendSuccess(res, { preferences: prefsOf(user) });
  } catch (error) {
    next(error);
  }
};

/** `{ "quizzes": { "push": false }, "announcements": { "email": false } }`. Only what's sent changes. */
export const updatePreferences = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body ?? {};
    const set: Record<string, boolean> = {};
    for (const [category, channels] of Object.entries(body)) {
      if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(category) || !channels || typeof channels !== 'object') {
        sendError(res, `Unknown category: ${category}`, 400);
        return;
      }
      for (const [channel, on] of Object.entries(channels as Record<string, unknown>)) {
        if ((channel !== 'push' && channel !== 'email') || typeof on !== 'boolean') {
          sendError(res, `${category}.${channel} must be push or email, true or false`, 400);
          return;
        }
        set[`notificationPrefs.${category}.${channel}`] = on;
      }
    }
    const user = await User.findByIdAndUpdate(req.user!.id, { $set: set }, { new: true }).select('notificationPrefs').lean<IUser>();
    sendSuccess(res, { preferences: prefsOf(user) }, 'Preferences saved');
  } catch (error) {
    next(error);
  }
};

/**
 * Admins only: a BreedX announcement to every student (or `userIds`). Goes
 * under the bell; `push` and `email` send it out too, for big news.
 */
export const announce = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.user?.role !== 'admin') {
      sendError(res, 'Only admins can send announcements', 403);
      return;
    }
    const { title, body, link, push, email } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim() || title.length > 120) {
      sendError(res, 'Title must be 1 to 120 characters', 400);
      return;
    }
    if (body !== undefined && (typeof body !== 'string' || body.length > 500)) {
      sendError(res, 'Body must be up to 500 characters', 400);
      return;
    }
    if (link !== undefined && (typeof link !== 'string' || !link.startsWith('/'))) {
      sendError(res, 'Link must be an app path like /home', 400);
      return;
    }
    const only = Array.isArray(req.body?.userIds) ? req.body.userIds.filter(isId) : null;
    const ids = only?.length ? only : (await User.find({ isVerified: true }).select('_id').lean()).map((user) => String(user._id));

    // Sent in the background in batches; the response doesn't wait
    void (async () => {
      for (let i = 0; i < ids.length; i += ANNOUNCE_BATCH) {
        await notify(
          ids.slice(i, i + ANNOUNCE_BATCH),
          { category: 'announcements' as NotificationCategory, kind: 'announcement', title: title.trim(), body: body?.trim() ?? '', link: link ?? '/home' },
          { push: push === true, email: email === true }
        );
      }
    })();
    sendSuccess(res, { recipients: ids.length }, 'Announcement on its way', 202);
  } catch (error) {
    next(error);
  }
};
