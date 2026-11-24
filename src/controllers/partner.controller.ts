import { NextFunction, Response } from 'express';
import env from '../config/env';
import Payment from '../models/payment.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { activePlan } from '../utils/plan';
import { sendError, sendSuccess } from '../utils/response';
import { ensureReferralCode } from '../utils/referrals';
import {
  commissionTotals,
  dayKey,
  lastDays,
  PARTNER_COMMISSION,
  PARTNER_HOLD_DAYS,
  partnerCommissions,
} from '../utils/partners';

const PAGE = 20;


// GET /partner/overview: the headline numbers and the last 30 days
export const partnerOverview = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const partnerId = req.user!.id;
    const code = await ensureReferralCode(partnerId);
    const students = await User.find({ referredBy: partnerId }).select('createdAt').lean();
    const commissions = await partnerCommissions(partnerId);
    const payers = new Set(commissions.map((item) => item.studentId));

    const days = lastDays(30);
    const daily = new Map(days.map((date) => [date, { date, signups: 0, paid: 0 }]));
    for (const student of students) {
      const row = daily.get(dayKey(student.createdAt));
      if (row) row.signups++;
    }
    for (const item of commissions) {
      const row = daily.get(dayKey(item.createdAt));
      if (row) row.paid++;
    }

    sendSuccess(res, {
      code,
      link: `${env.APP_URL}/r/${code}`,
      commission: { rate: PARTNER_COMMISSION, holdDays: PARTNER_HOLD_DAYS },
      totals: {
        signups: students.length,
        paid: payers.size,
        conversion: students.length ? payers.size / students.length : 0,
        payments: commissions.length,
      },
      money: commissionTotals(commissions),
      daily: [...daily.values()],
      recent: commissions.slice(0, 5),
    });
  } catch (error) {
    next(error);
  }
};

// GET /partner/referrals?page&q: everyone who joined with their link
export const partnerReferrals = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const partnerId = req.user!.id;
    const page = Math.max(1, Number(req.query.page) || 1);
    const q = String(req.query.q ?? '').trim();
    const filter: Record<string, unknown> = { referredBy: partnerId };
    if (q) {
      const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ firstName: pattern }, { lastName: pattern }];
    }
    const [students, total] = await Promise.all([
      User.find(filter)
        .select('firstName lastName avatar createdAt plan planExpiresAt')
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE)
        .limit(PAGE)
        .lean(),
      User.countDocuments(filter),
    ]);
    const commissions = await partnerCommissions(partnerId);
    const items = await Promise.all(
      students.map(async (student) => {
        const mine = commissions.filter((item) => item.studentId === String(student._id));
        const hasPaid = mine.length > 0 || Boolean(await Payment.exists({ user: student._id, status: 'paid' }));
        return {
          id: String(student._id),
          name: `${student.firstName} ${student.lastName ?? ''}`.trim(),
          avatarUrl: student.avatar ?? null,
          joinedAt: student.createdAt,
          status: hasPaid ? 'paid' : 'signed_up',
          plan: activePlan(student),
          earned: commissionTotals(mine),
        };
      }),
    );
    sendSuccess(res, { items, total, page, pageSize: PAGE });
  } catch (error) {
    next(error);
  }
};

// GET /partner/earnings: each commission
export const partnerEarnings = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const items = await partnerCommissions(req.user!.id);
    sendSuccess(res, {
      items,
      money: commissionTotals(items),
      commission: { rate: PARTNER_COMMISSION, holdDays: PARTNER_HOLD_DAYS },
    });
  } catch (error) {
    next(error);
  }
};

// GET /partner/payout-details
export const getPayoutDetails = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id).select('payoutDetails').lean();
    sendSuccess(res, { details: user?.payoutDetails ?? null });
  } catch (error) {
    next(error);
  }
};

// PUT /partner/payout-details { bank, accountName, accountNumber }
export const setPayoutDetails = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const clean = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);
    const details = {
      bank: clean(req.body?.bank, 80),
      accountName: clean(req.body?.accountName, 120),
      accountNumber: clean(req.body?.accountNumber, 34).replace(/\s+/g, ''),
    };
    if (!details.bank || !details.accountName || !/^[A-Za-z0-9]{6,34}$/.test(details.accountNumber)) {
      return sendError(res, 'Enter the bank, account name and a valid account number', 400);
    }
    await User.updateOne({ _id: req.user!.id }, { payoutDetails: details });
    sendSuccess(res, { details });
  } catch (error) {
    next(error);
  }
};
