import { NextFunction, Response } from 'express';
import AiUsage from '../models/aiUsage.model';
import Partnership from '../models/partnership.model';
import Payment from '../models/payment.model';
import Session from '../models/session.model';
import Space from '../models/space.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { notify } from '../utils/notify';
import { activePlan } from '../utils/plan';
import { sendError, sendSuccess } from '../utils/response';
import { commissionTotals, dayKey, isId, lastDays, partnerCommissions } from '../utils/partners';

const PAGE = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

const startOfMonth = (offset = 0) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
};

/** Paid revenue between two dates, per currency. */
const revenue = async (from: Date, to: Date) => {
  const rows = await Payment.aggregate<{ _id: string; total: number; count: number }>([
    { $match: { status: 'paid', paidAt: { $gte: from, $lt: to } } },
    { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return rows.map((row) => ({ currency: row._id, total: row.total, count: row.count }));
};

// GET /admin/overview: the whole product at a glance
export const adminOverview = async (_req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);

    const [total, new7d, activeIds, paidUsers, spaces, energyToday, partners, partnerRequests, signups, payments] =
      await Promise.all([
        User.countDocuments(),
        User.countDocuments({ createdAt: { $gte: weekAgo } }),
        Session.distinct('user', { lastSeenAt: { $gte: weekAgo } }),
        User.find({ plan: { $ne: 'free' }, planExpiresAt: { $gt: now } }).select('plan').lean(),
        Space.countDocuments(),
        AiUsage.aggregate<{ energy: number; requests: number }>([
          { $match: { createdAt: { $gte: today } } },
          { $group: { _id: null, energy: { $sum: '$energy' }, requests: { $sum: 1 } } },
        ]),
        User.countDocuments({ isPartner: true }),
        Partnership.countDocuments(),
        User.find({ createdAt: { $gte: monthAgo } }).select('createdAt').lean(),
        Payment.find({ status: 'paid', paidAt: { $gte: monthAgo } }).select('paidAt amount currency').lean(),
      ]);

    const byPlan: Record<string, number> = {};
    for (const user of paidUsers) byPlan[user.plan] = (byPlan[user.plan] ?? 0) + 1;

    const daily = new Map(lastDays(30).map((date) => [date, { date, signups: 0, payments: 0 }]));
    for (const user of signups) {
      const row = daily.get(dayKey(user.createdAt));
      if (row) row.signups++;
    }
    for (const payment of payments) {
      const row = payment.paidAt && daily.get(dayKey(payment.paidAt));
      if (row) row.payments++;
    }

    // Where students are: countries and schools, the biggest first
    const [byCountry, bySchool, new30d, active30d, schoolKnown] = await Promise.all([
      User.aggregate<{ _id: string | null; count: number }>([
        { $group: { _id: '$country', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      User.aggregate<{ _id: string; count: number }>([
        { $match: { 'academicProfile.school': { $nin: [null, ''] } } },
        { $group: { _id: '$academicProfile.school', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      User.countDocuments({ createdAt: { $gte: monthAgo } }),
      Session.distinct('user', { lastSeenAt: { $gte: monthAgo } }),
      User.countDocuments({ 'academicProfile.school': { $nin: [null, ''] } }),
    ]);

    sendSuccess(res, {
      users: {
        total,
        new7d,
        new30d,
        active7d: activeIds.length,
        active30d: active30d.length,
        countries: byCountry.map((row) => ({ country: row._id || '', count: row.count })),
        schools: bySchool.map((row) => ({ school: row._id, count: row.count })),
        withSchool: schoolKnown,
      },
      paid: { count: paidUsers.length, byPlan },
      revenue: {
        month: await revenue(startOfMonth(), now),
        lastMonth: await revenue(startOfMonth(-1), startOfMonth()),
      },
      ai: { energyToday: energyToday[0]?.energy ?? 0, requestsToday: energyToday[0]?.requests ?? 0 },
      spaces: { total: spaces },
      partners: { total: partners, requests: partnerRequests },
      daily: [...daily.values()],
    });
  } catch (error) {
    next(error);
  }
};

// GET /admin/users?q&page&filter=partner|admin|paid
export const adminUsers = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const q = String(req.query.q ?? '').trim();
    const filter: Record<string, unknown> = {};
    if (q) {
      const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ firstName: pattern }, { lastName: pattern }, { email: pattern }];
    }
    if (req.query.filter === 'partner') filter.isPartner = true;
    if (req.query.filter === 'admin') filter.role = 'admin';
    if (req.query.filter === 'paid') Object.assign(filter, { plan: { $ne: 'free' }, planExpiresAt: { $gt: new Date() } });

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('firstName lastName email avatar role isPartner plan planExpiresAt createdAt country academicProfile.school academicProfile.level onboardingStatus')
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE)
        .limit(PAGE)
        .lean(),
      User.countDocuments(filter),
    ]);
    const seen = await Session.aggregate<{ _id: unknown; at: Date }>([
      { $match: { user: { $in: users.map((user) => user._id) } } },
      { $group: { _id: '$user', at: { $max: '$lastSeenAt' } } },
    ]);
    const lastSeen = new Map(seen.map((row) => [String(row._id), row.at]));

    sendSuccess(res, {
      items: users.map((user) => ({
        id: String(user._id),
        name: `${user.firstName} ${user.lastName ?? ''}`.trim(),
        email: user.email,
        avatarUrl: user.avatar ?? null,
        country: user.country,
        school: user.academicProfile?.school ?? null,
        level: user.academicProfile?.level ?? null,
        onboarded: user.onboardingStatus === 'complete',
        role: user.role,
        isPartner: Boolean(user.isPartner),
        plan: activePlan(user),
        createdAt: user.createdAt,
        lastSeenAt: lastSeen.get(String(user._id)) ?? null,
      })),
      total,
      page,
      pageSize: PAGE,
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /admin/users/:id { isPartner?, role? }
export const adminUpdateUser = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id;
    if (!isId(id)) return sendError(res, 'User not found', 404);
    const user = await User.findById(id);
    if (!user) return sendError(res, 'User not found', 404);

    const { isPartner, role } = req.body ?? {};
    if (role !== undefined) {
      if (role !== 'user' && role !== 'admin') return sendError(res, 'Unknown role', 400);
      if (id === req.user!.id && role !== 'admin') return sendError(res, "You can't remove your own admin access", 400);
      user.role = role;
    }
    if (isPartner !== undefined) {
      const partner = Boolean(isPartner);
      if (partner && !user.isPartner) {
        user.partnerSince = new Date();
        void notify([String(user._id)], {
          category: 'account',
          kind: 'partner',
          title: 'You’re now a BreedX partner',
          body: 'Your partner dashboard is ready. Open it from your profile menu.',
          link: '/partner',
        }, { push: true, email: true }).catch(() => {});
      }
      user.isPartner = partner;
    }
    await user.save();
    sendSuccess(res, { user: { id: String(user._id), role: user.role, isPartner: user.isPartner } });
  } catch (error) {
    next(error);
  }
};

// GET /admin/partners: every partner and what they've brought in
export const adminPartners = async (_req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const partners = await User.find({ isPartner: true })
      .select('firstName lastName email avatar referralCode partnerSince payoutDetails')
      .sort({ partnerSince: -1 })
      .lean();
    const items = await Promise.all(
      partners.map(async (partner) => {
        const id = String(partner._id);
        const commissions = await partnerCommissions(id);
        return {
          id,
          name: `${partner.firstName} ${partner.lastName ?? ''}`.trim(),
          email: partner.email,
          avatarUrl: partner.avatar ?? null,
          code: partner.referralCode ?? null,
          since: partner.partnerSince ?? null,
          signups: await User.countDocuments({ referredBy: id }),
          paid: new Set(commissions.map((item) => item.studentId)).size,
          money: commissionTotals(commissions),
          hasPayoutDetails: Boolean(partner.payoutDetails?.accountNumber),
        };
      }),
    );
    sendSuccess(res, { items });
  } catch (error) {
    next(error);
  }
};

type Count = { key: string; count: number };

/** Students grouped by one profile field, the biggest first. */
const groupBy = async (field: string, limit = 10, unwind = false): Promise<Count[]> => {
  const path = '$' + field;
  const rows = await User.aggregate<{ _id: string; count: number }>([
    ...(unwind ? [{ $unwind: path }] : []),
    { $match: { [field]: { $nin: [null, ''] } } },
    { $group: { _id: path, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);
  return rows.map((row) => ({ key: String(row._id), count: row.count }));
};

const WEEK_MS = 7 * DAY_MS;

// GET /admin/users/insights: who our students are and how they use BreedX
export const adminUserInsights = async (_req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const now = Date.now();
    const weekAgo = new Date(now - WEEK_MS);
    const monthAgo = new Date(now - 30 * DAY_MS);
    const twoMonthsAgo = new Date(now - 60 * DAY_MS);
    // Twelve whole weeks, starting on the Monday 11 weeks back
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7) - 11 * 7);

    const [
      total,
      verified,
      onboarded,
      google,
      new30d,
      newPrev30d,
      activeWeek,
      activeMonth,
      everSeen,
      recent,
      devices,
      levels,
      programmes,
      faculties,
      interests,
      approach,
      time,
      preference,
      planning,
      barriers,
      styled,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isVerified: true }),
      User.countDocuments({ onboardingStatus: 'complete' }),
      User.countDocuments({ authProvider: 'google' }),
      User.countDocuments({ createdAt: { $gte: monthAgo } }),
      User.countDocuments({ createdAt: { $gte: twoMonthsAgo, $lt: monthAgo } }),
      Session.distinct('user', { lastSeenAt: { $gte: weekAgo } }),
      Session.distinct('user', { lastSeenAt: { $gte: monthAgo } }),
      Session.distinct('user'),
      User.find({ createdAt: { $gte: start } }).select('createdAt').lean(),
      // The device each student used most recently in the last 30 days
      Session.aggregate<{ _id: string | null; count: number }>([
        { $match: { lastSeenAt: { $gte: monthAgo } } },
        { $sort: { lastSeenAt: -1 } },
        { $group: { _id: '$user', device: { $first: '$deviceName' } } },
        { $group: { _id: { $arrayElemAt: [{ $split: ['$device', ' on '] }, 1] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      groupBy('academicProfile.level', 8),
      groupBy('academicProfile.programme', 6),
      groupBy('academicProfile.faculty', 6),
      groupBy('academicProfile.interests', 8, true),
      groupBy('learningStyle.approach', 6),
      groupBy('learningStyle.time', 4),
      groupBy('learningStyle.preference', 5),
      groupBy('learningStyle.planning', 5),
      groupBy('learningStyle.barriers', 6, true),
      User.countDocuments({ 'learningStyle.approach': { $nin: [null, ''] } }),
    ]);

    const weekly = Array.from({ length: 12 }, (_, index) => ({
      week: new Date(start.getTime() + index * WEEK_MS).toISOString().slice(0, 10),
      signups: 0,
    }));
    for (const user of recent) {
      const index = Math.floor((user.createdAt.getTime() - start.getTime()) / WEEK_MS);
      if (weekly[index]) weekly[index].signups++;
    }

    sendSuccess(res, {
      total,
      verified,
      onboarded,
      google,
      new30d,
      newPrev30d,
      activity: {
        week: activeWeek.length,
        month: activeMonth.length,
        // Signed in before, but not in the last 30 days
        lapsed: Math.max(0, everSeen.length - activeMonth.length),
      },
      weekly,
      devices: devices.map((row) => ({ key: row._id || 'unknown', count: row.count })),
      academic: { levels, programmes, faculties, interests },
      style: { answered: styled, approach, time, preference, planning, barriers },
    });
  } catch (error) {
    next(error);
  }
};
