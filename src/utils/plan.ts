import { Types } from 'mongoose';
import { PLAN_LIMITS, PlanId, PlanLimits } from '../config/plans';
import LibraryFile from '../models/libraryFile.model';
import Library from '../models/library.model';
import User from '../models/user.model';
import { IUser } from '../types/user';

/** The plan in force today: a paid plan past its end date counts as free. */
export const activePlan = (user: Pick<IUser, 'plan' | 'planExpiresAt'>): PlanId => {
  const plan = user.plan ?? 'free';
  if (plan !== 'free' && user.planExpiresAt && user.planExpiresAt.getTime() < Date.now()) return 'free';
  return plan;
};

export const planFor = async (userId: string): Promise<{ plan: PlanId; limits: PlanLimits }> => {
  const user = await User.findById(userId).select('plan planExpiresAt').lean();
  const plan = user ? activePlan(user) : 'free';
  return { plan, limits: PLAN_LIMITS[plan] };
};

/**
 * Bytes a student is using across all their libraries. A file in several
 * libraries counts once. Uploads in progress are counted too, so two uploads
 * at once can't both squeeze into the last bit of space.
 */
export const storageUsed = async (userId: string, excludeFileId?: string): Promise<number> => {
  const owner = new Types.ObjectId(userId);
  const exclude = excludeFileId ? { _id: { $ne: new Types.ObjectId(excludeFileId) } } : {};

  const [stored] = await LibraryFile.aggregate<{ total: number }>([
    { $match: { owner, status: 'ready', material: { $ne: null }, ...exclude } },
    { $group: { _id: '$material', size: { $first: '$size' } } },
    { $group: { _id: null, total: { $sum: '$size' } } },
  ]);

  const [pending] = await LibraryFile.aggregate<{ total: number }>([
    { $match: { owner, status: 'uploading', expiresAt: { $gt: new Date() }, ...exclude } },
    { $group: { _id: null, total: { $sum: '$size' } } },
  ]);

  return (stored?.total ?? 0) + (pending?.total ?? 0);
};

/** Everything the frontend needs for the storage bar and the library limit. */
export const usageFor = async (userId: string) => {
  const { plan, limits } = await planFor(userId);
  const [used, libraries] = await Promise.all([
    storageUsed(userId),
    Library.countDocuments({ owner: userId }),
  ]);

  return {
    plan,
    storage: { usedBytes: used, limitBytes: limits.storageBytes, maxFileBytes: limits.maxFileBytes },
    libraries: { used: libraries, limit: limits.libraries },
  };
};
