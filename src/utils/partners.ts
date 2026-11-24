import { Types } from 'mongoose';
import Payment from '../models/payment.model';
import User from '../models/user.model';

/** Partners earn this share of every payment by students they brought in. */
export const PARTNER_COMMISSION = 0.2;
/** Commission stays pending this long (refunds, failed charges), then it's approved. */
export const PARTNER_HOLD_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type Commission = {
  id: string;
  studentId: string;
  studentName: string;
  plan: string;
  paid: number;
  amount: number;
  currency: string;
  status: 'pending' | 'approved';
  createdAt: Date;
};

/** Every commission a partner has earned, newest first. */
export const partnerCommissions = async (partnerId: string): Promise<Commission[]> => {
  const students = await User.find({ referredBy: partnerId }).select('firstName lastName').lean();
  if (!students.length) return [];
  const names = new Map(students.map((s) => [String(s._id), `${s.firstName} ${s.lastName ?? ''}`.trim()]));
  const payments = await Payment.find({ user: { $in: students.map((s) => s._id) }, status: 'paid' })
    .select('user plan amount currency paidAt createdAt')
    .sort({ paidAt: -1 })
    .lean();
  const now = Date.now();
  return payments.map((payment) => {
    const at = payment.paidAt ?? payment.createdAt;
    return {
      id: String(payment._id),
      studentId: String(payment.user),
      studentName: names.get(String(payment.user)) ?? '',
      plan: payment.plan,
      paid: payment.amount,
      amount: Math.round(payment.amount * PARTNER_COMMISSION * 100) / 100,
      currency: payment.currency,
      status: now - at.getTime() > PARTNER_HOLD_DAYS * DAY_MS ? 'approved' : 'pending',
      createdAt: at,
    };
  });
};

/** Earned and pending per currency (NGN and USD never add up together). */
export const commissionTotals = (items: Commission[]) => {
  const byCurrency = new Map<string, { currency: string; earned: number; pending: number }>();
  for (const item of items) {
    const row = byCurrency.get(item.currency) ?? { currency: item.currency, earned: 0, pending: 0 };
    if (item.status === 'approved') row.earned += item.amount;
    else row.pending += item.amount;
    byCurrency.set(item.currency, row);
  }
  return [...byCurrency.values()].map((row) => ({
    ...row,
    earned: Math.round(row.earned * 100) / 100,
    pending: Math.round(row.pending * 100) / 100,
  }));
};

/** The last `days` days as YYYY-MM-DD keys, oldest first. */
export const lastDays = (days: number) => {
  const keys: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) keys.push(new Date(today.getTime() - i * DAY_MS).toISOString().slice(0, 10));
  return keys;
};

export const dayKey = (date: Date) => date.toISOString().slice(0, 10);

export const isId = (value: unknown): value is string =>
  typeof value === 'string' && Types.ObjectId.isValid(value);
