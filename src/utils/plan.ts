import { Types } from 'mongoose';
import { PLAN_LIMITS, PlanId, PlanLimits } from '../config/plans';
import LibraryFile from '../models/libraryFile.model';
import Library from '../models/library.model';
import Space from '../models/space.model';
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

const UPLOAD_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Bytes a student is using: every file in their libraries, plus files they
 * uploaded to space courses. A file in several places counts once. Uploads in
 * progress are counted too, so two at once can't both squeeze into the last
 * bit of space. `excludeId` leaves out one upload (a library file or a space
 * material) that's being checked.
 */
export const storageUsed = async (userId: string, excludeId?: string): Promise<number> => {
  const owner = new Types.ObjectId(userId);
  const exclude = excludeId ? new Types.ObjectId(excludeId) : null;

  const [libraryStored, libraryPending, spaceMaterials] = await Promise.all([
    LibraryFile.find({ owner, status: 'ready', material: { $ne: null }, ...(exclude && { _id: { $ne: exclude } }) })
      .select('material size')
      .lean(),
    LibraryFile.aggregate<{ total: number }>([
      { $match: { owner, status: 'uploading', expiresAt: { $gt: new Date() }, ...(exclude && { _id: { $ne: exclude } }) } },
      { $group: { _id: null, total: { $sum: '$size' } } },
    ]),
    Space.aggregate<{ _id: Types.ObjectId; material: Types.ObjectId | null; size: number; status: string; uploadedAt: Date }>([
      { $match: { 'courses.materials.uploadedBy': owner } },
      { $unwind: '$courses' },
      { $unwind: '$courses.materials' },
      { $match: { 'courses.materials.uploadedBy': owner, 'courses.materials.status': { $in: ['uploading', 'ready'] } } },
      {
        $project: {
          _id: '$courses.materials._id',
          material: '$courses.materials.material',
          size: '$courses.materials.size',
          status: '$courses.materials.status',
          uploadedAt: '$courses.materials.uploadedAt',
        },
      },
    ]),
  ]);

  // Each stored file once, wherever it is
  const sizes = new Map<string, number>();
  for (const file of libraryStored) sizes.set(String(file.material), file.size);
  let pending = libraryPending[0]?.total ?? 0;
  for (const material of spaceMaterials) {
    if (exclude && material._id.equals(exclude)) continue;
    if (material.status === 'ready' && material.material) sizes.set(String(material.material), material.size);
    // An upload never finished is cleared after a day; until then it holds its space
    else if (material.status === 'uploading' && Date.now() - material.uploadedAt.getTime() < UPLOAD_HOLD_MS) pending += material.size;
  }
  return [...sizes.values()].reduce((sum, size) => sum + size, 0) + pending;
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
