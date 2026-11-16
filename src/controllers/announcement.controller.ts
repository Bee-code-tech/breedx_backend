import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import Announcement, { IAnnouncement } from '../models/announcement.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { sendError, sendSuccess } from '../utils/response';
import { notifySpace } from '../utils/spaceNotify';
import { loadSpace } from './space.controller';

const TITLE_MAX = 120;
const BODY_MAX = 2000;
const PAGE = 50;

const canPost = (role: string) => role === 'owner' || role === 'admin';
const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);

const toPublic = (
  item: IAnnouncement,
  viewerId: string,
  avatars: Map<string, string | null>
) => ({
  id: String(item._id),
  title: item.title,
  body: item.body,
  important: item.important,
  pinned: item.pinned,
  authorName: String(item.author) === viewerId ? 'You' : item.authorName,
  authorAvatar: avatars.get(String(item.author)) ?? null,
  isMine: String(item.author) === viewerId,
  createdAt: item.createdAt.toISOString(),
});

const listFor = async (spaceId: Types.ObjectId, viewerId: string) => {
  const items = await Announcement.find({ space: spaceId }).sort({ pinned: -1, createdAt: -1 }).limit(PAGE).lean<IAnnouncement[]>();
  const authors = await User.find({ _id: { $in: [...new Set(items.map((item) => String(item.author)))] } })
    .select('avatar')
    .lean();
  const avatars = new Map(authors.map((author) => [String(author._id), (author as { avatar?: string }).avatar ?? null]));
  return items.map((item) => toPublic(item, viewerId, avatars));
};

// GET /api/v1/spaces/:slug/announcements: newest first, pinned on top
export const listAnnouncements = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    sendSuccess(res, {
      announcements: await listFor(found.space._id as Types.ObjectId, found.userId),
      canPost: canPost(found.membership.role),
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/spaces/:slug/announcements { title?, body, important? }
export const createAnnouncement = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (!canPost(membership.role)) return sendError(res, 'Only the owner and admins can post announcements', 403);

    const title = typeof req.body?.title === 'string' ? req.body.title.trim().replace(/\s+/g, ' ') : '';
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const important = req.body?.important === true;
    if (!body) return sendError(res, 'Write the announcement', 400);
    if (title.length > TITLE_MAX) return sendError(res, `Keep the title under ${TITLE_MAX} characters`, 400);
    if (body.length > BODY_MAX) return sendError(res, `Keep it under ${BODY_MAX} characters`, 400);

    const author = await User.findById(userId).select('firstName lastName').lean();
    const authorName = author ? `${author.firstName} ${author.lastName ?? ''}`.trim() : 'A student';
    await Announcement.create({ space: space._id, author: userId, authorName, title, body, important });

    sendSuccess(
      res,
      { announcements: await listFor(space._id as Types.ObjectId, userId), canPost: true },
      'Announcement sent',
      201
    );

    // Everyone else hears it straight away; important ones even in quiet hours
    const preview = body.replace(/\s+/g, ' ');
    void notifySpace(space, userId, {
      kind: 'space-announcement',
      title: (who) => `${important ? '📢 ' : ''}${title || `${who} posted in ${space.name}`}`,
      body: (title ? `${author?.firstName ?? 'Someone'}: ${preview}` : preview).slice(0, 180),
      tab: 'announcements',
      urgent: important,
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/v1/spaces/:slug/announcements/:id { pinned }
export const updateAnnouncement = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (!canPost(membership.role)) return sendError(res, 'Only the owner and admins can manage announcements', 403);
    const item = isId(req.params.id) ? await Announcement.findOne({ _id: req.params.id, space: space._id }) : null;
    if (!item) return sendError(res, 'Announcement not found', 404);
    if (typeof req.body?.pinned === 'boolean') item.pinned = req.body.pinned;
    await item.save();
    sendSuccess(res, { announcements: await listFor(space._id as Types.ObjectId, userId), canPost: true });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/spaces/:slug/announcements/:id: the author, owner or admins
export const deleteAnnouncement = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    const item = isId(req.params.id) ? await Announcement.findOne({ _id: req.params.id, space: space._id }) : null;
    if (!item) return sendError(res, 'Announcement not found', 404);
    if (!canPost(membership.role) && String(item.author) !== userId) {
      return sendError(res, 'Only the owner and admins can remove announcements', 403);
    }
    await item.deleteOne();
    sendSuccess(res, { announcements: await listFor(space._id as Types.ObjectId, userId), canPost: canPost(membership.role) });
  } catch (error) {
    next(error);
  }
};
