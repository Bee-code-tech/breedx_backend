import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import User from '../models/user.model';
import { IUser } from '../types/user';
import { notify } from './notify';
import { activePlan } from './plan';

/** What a referral earns each side: a month of Scholar, or a month more of their plan. */
export const REFERRAL_MONTHS = 1;
export const REFERRAL_PLAN = 'scholar' as const;

const CODE_PATTERN = /^[a-z0-9-]{4,40}$/;

const addMonths = (from: Date, months: number) => {
  const next = new Date(from);
  next.setMonth(next.getMonth() + months);
  return next;
};

/** "ameen-k3p9": their first name and four random characters. */
const makeCode = (firstName: string) => {
  const name =
    firstName
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z]/g, '')
      .slice(0, 12) || 'friend';
  return `${name}-${randomBytes(3).toString('hex').slice(0, 4)}`;
};

/** The student's share code, made (and kept) the first time it's needed. */
export const ensureReferralCode = async (userId: string | Types.ObjectId): Promise<string> => {
  const user = await User.findById(userId).select('firstName referralCode');
  if (!user) throw new Error('User not found');
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode(user.firstName);
    const taken = await User.exists({ referralCode: code });
    if (taken) continue;
    user.referralCode = code;
    await user.save();
    return code;
  }
  throw new Error('Could not make a referral code');
};

/** Who owns a code, for signing someone up under it. Null for a bad or unknown code. */
export const referrerFor = async (code: unknown, newEmail?: string) => {
  if (typeof code !== 'string') return null;
  const clean = code.trim().toLowerCase();
  if (!CODE_PATTERN.test(clean)) return null;
  const owner = await User.findOne({ referralCode: clean }).select('_id email').lean();
  // Nobody refers themselves
  if (!owner || (newEmail && owner.email === newEmail.toLowerCase())) return null;
  return owner._id as Types.ObjectId;
};

/** A month more of the plan they have, or a month of Scholar if they're on Free. */
const giveMonth = async (user: IUser) => {
  const now = new Date();
  const current = activePlan(user);
  if (current !== 'free' && user.planExpiresAt && user.planExpiresAt.getTime() > now.getTime()) {
    user.planExpiresAt = addMonths(user.planExpiresAt, REFERRAL_MONTHS);
  } else {
    user.plan = REFERRAL_PLAN;
    user.planExpiresAt = addMonths(now, REFERRAL_MONTHS);
  }
  await user.save();
  return user.plan;
};

/**
 * After someone's payment goes through: if a friend invited them and nobody
 * has been rewarded for them yet, both get a free month. Runs once per
 * invited student, however many times they pay. Never throws.
 */
export const rewardReferral = async (userId: string | Types.ObjectId) => {
  try {
    // Claims the reward first, so two payments at once can't both trigger it
    const friend = await User.findOneAndUpdate(
      { _id: userId, referredBy: { $ne: null }, referralRewardedAt: null },
      { referralRewardedAt: new Date() },
      { new: true }
    );
    if (!friend?.referredBy) return;
    const referrer = await User.findById(friend.referredBy);
    await giveMonth(friend);
    if (referrer) await giveMonth(referrer);

    void notify(
      [friend._id],
      {
        category: 'account',
        kind: 'referral-reward',
        title: 'You got a free month 🎁',
        body: referrer
          ? `Thanks for joining with ${referrer.firstName}'s link. A month was added to your plan.`
          : 'A month was added to your plan.',
        link: '/settings?tab=billing',
      },
      { push: true }
    );
    if (referrer) {
      void notify(
        [referrer._id],
        {
          category: 'account',
          kind: 'referral-reward',
          title: `${friend.firstName} subscribed. You got a free month 🎁`,
          body: 'Thanks for sharing BreedX. A month was added to your plan.',
          link: '/settings?tab=referrals',
        },
        { push: true, email: { action: 'See your referrals' } }
      );
    }
  } catch (error) {
    console.error('Referral reward failed:', error);
  }
};
