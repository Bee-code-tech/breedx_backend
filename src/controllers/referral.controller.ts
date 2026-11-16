import { Types } from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import Payment from '../models/payment.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { sendError, sendSuccess } from '../utils/response';
import { ensureReferralCode, REFERRAL_MONTHS, REFERRAL_PLAN } from '../utils/referrals';

const CODE = /^[a-z0-9-]{4,40}$/;

/**
 * Who invited this student, if anyone, and whether they can still enter a
 * friend's code: only before their first payment, and only once.
 */
const claimState = async (userId: string) => {
  const me = await User.findById(userId).select('referredBy referralRewardedAt').lean();
  const inviter = me?.referredBy
    ? await User.findById(me.referredBy).select('firstName lastName avatar').lean()
    : null;
  const hasPaid = Boolean(await Payment.exists({ user: userId, status: 'paid' }));
  return {
    referredBy: inviter
      ? {
          name: `${inviter.firstName} ${inviter.lastName ?? ''}`.trim(),
          avatarUrl: inviter.avatar ?? null,
          rewarded: Boolean(me?.referralRewardedAt),
        }
      : null,
    canClaim: !me?.referredBy && !hasPaid,
    hasPaid,
  };
};

// GET /api/v1/referrals: your code, the friends who joined with it, and what you earned
export const getReferrals = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const code = await ensureReferralCode(userId);
    const friends = await User.find({ referredBy: userId })
      .select('firstName lastName avatar createdAt referralRewardedAt')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const referrals = friends.map((friend) => ({
      id: String(friend._id),
      name: `${friend.firstName} ${friend.lastName ?? ''}`.trim(),
      avatarUrl: friend.avatar ?? null,
      status: friend.referralRewardedAt ? 'subscribed' : 'joined',
      joinedAt: friend.createdAt,
      rewardedAt: friend.referralRewardedAt ?? null,
    }));
    const rewards = referrals.filter((item) => item.status === 'subscribed').length;
    sendSuccess(res, {
      ...(await claimState(userId)),
      code,
      reward: { months: REFERRAL_MONTHS, plan: REFERRAL_PLAN },
      referrals,
      stats: {
        joined: referrals.length,
        subscribed: rewards,
        monthsEarned: rewards * REFERRAL_MONTHS,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/referrals/code/:code: no sign-in. Whose link it is, for the invite page
export const publicReferral = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const code = String(req.params.code ?? '').trim().toLowerCase();
    if (!/^[a-z0-9-]{4,40}$/.test(code)) return sendError(res, 'This invite link is not valid', 404);
    const owner = await User.findOne({ referralCode: code }).select('firstName lastName avatar').lean();
    if (!owner) return sendError(res, 'This invite link is not valid', 404);
    res.set('Cache-Control', 'public, max-age=300');
    sendSuccess(res, {
      code,
      name: `${owner.firstName} ${owner.lastName ?? ''}`.trim(),
      firstName: owner.firstName,
      avatarUrl: owner.avatar ?? null,
      reward: { months: REFERRAL_MONTHS, plan: REFERRAL_PLAN },
    });
  } catch (error) {
    next(error);
  }
};


// POST /api/v1/referrals/claim { code }: an existing account adds the friend who
// invited them. Same reward as signing up with the link, on their first payment.
export const claimReferral = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toLowerCase().replace(/^.*\/r\//, '') : '';
    if (!CODE.test(code)) return sendError(res, "That code doesn't look right. It's like ameen-k3p9.", 400);

    const me = await User.findById(userId).select('referredBy referralCode');
    if (!me) return sendError(res, 'Account not found', 404);
    if (me.referredBy) return sendError(res, "You've already added a friend's code", 409);
    if (await Payment.exists({ user: userId, status: 'paid' })) {
      return sendError(res, 'Codes can only be added before your first payment', 409);
    }

    const owner = await User.findOne({ referralCode: code }).select('_id firstName referredBy').lean();
    if (!owner) return sendError(res, 'No one has that code. Check it with your friend.', 404);
    if (String(owner._id) === userId) return sendError(res, "That's your own code. Share it with friends instead.", 400);
    // No swapping codes with someone you invited
    if (owner.referredBy && String(owner.referredBy) === userId) {
      return sendError(res, `${owner.firstName} joined with your code, so you can't use theirs.`, 400);
    }

    me.referredBy = owner._id as unknown as Types.ObjectId;
    await me.save();
    sendSuccess(res, await claimState(userId), `Added ${owner.firstName}'s code`);
  } catch (error) {
    next(error);
  }
};
