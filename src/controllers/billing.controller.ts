import { NextFunction, Request, Response } from 'express';
import env from '../config/env';
import {
  BILLING_PERIODS,
  BillingPeriod,
  findCoupon,
  MONTHLY_ALLOWANCE,
  PaidPlan,
  PERIOD_MONTHS,
  quote,
  REGION_CURRENCY,
} from '../config/billing';
import { regionFor } from '../config/regions';
import Payment, { IPayment } from '../models/payment.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { bachsReady, createCheckout, getCheckout, toPaymentStatus, verifyWebhook } from '../utils/bachs';
import { notify } from '../utils/notify';
import { activePlan, planFor, storageUsed } from '../utils/plan';
import { energyFor, startOfToday } from '../utils/ai/energy';
import AiUsage from '../models/aiUsage.model';
import Library from '../models/library.model';
import LibraryFile from '../models/libraryFile.model';
import Quiz from '../models/quiz.model';
import Space from '../models/space.model';
import { AI_FEATURES } from '../types/ai';
import { Types } from 'mongoose';
import { sendError, sendSuccess } from '../utils/response';

const isPaidPlan = (value: unknown): value is PaidPlan => value === 'scholar' || value === 'elite';
const isPeriod = (value: unknown): value is BillingPeriod =>
  (BILLING_PERIODS as readonly string[]).includes(String(value));

const addMonths = (from: Date, months: number) => {
  const next = new Date(from);
  next.setMonth(next.getMonth() + months);
  return next;
};

const PLAN_NAMES: Record<PaidPlan, string> = { scholar: 'Scholar', elite: 'Elite' };
const money = (amount: number, currency: string) =>
  currency === 'USD' ? `$${amount.toFixed(2)}` : `₦${amount.toLocaleString('en-NG')}`;
const longDate = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const paymentFailed = (payment: IPayment) =>
  void notify(
    [payment.user],
    {
      category: 'account',
      kind: 'payment-failed',
      title: "Payment didn't go through",
      body: `Your ${money(payment.amount, payment.currency)} payment for ${PLAN_NAMES[payment.plan]} wasn't completed. You haven't been charged. Try again from Billing.`,
      link: '/settings?tab=billing',
    },
    { push: true, email: { action: 'Try again' } }
  );

const toPublicPayment = (payment: IPayment) => ({
  id: payment._id,
  plan: payment.plan,
  period: payment.period,
  price: payment.price,
  discount: payment.discount,
  amount: payment.amount,
  coupon: payment.coupon,
  currency: payment.currency,
  status: payment.status,
  paidAt: payment.paidAt,
  createdAt: payment.createdAt,
});

/**
 * Marks a payment paid and gives the student the plan. Safe to call twice
 * (webhook and the page checking in): only the first call changes anything.
 * Paying again for the plan you have adds the time on after your current end.
 */
const fulfil = async (paymentId: unknown) => {
  const payment = await Payment.findOneAndUpdate(
    { _id: paymentId, status: { $ne: 'paid' } },
    { status: 'paid', paidAt: new Date() },
    { new: true }
  );
  if (!payment) return Payment.findById(paymentId);

  const user = await User.findById(payment.user).select('plan planExpiresAt');
  if (user) {
    const now = new Date();
    const sameActivePlan =
      activePlan(user) === payment.plan && user.planExpiresAt && user.planExpiresAt.getTime() > now.getTime();
    const start = sameActivePlan ? (user.planExpiresAt as Date) : now;
    user.plan = payment.plan;
    user.planExpiresAt = addMonths(start, PERIOD_MONTHS[payment.period]);
    await user.save();
    // Bell, push and email; urgent, since a payment can land at night
    void notify(
      [payment.user],
      {
        category: 'account',
        kind: 'payment-success',
        title: 'Payment received ✅',
        body: `You're on ${PLAN_NAMES[payment.plan]} until ${longDate(user.planExpiresAt)}. ${money(payment.amount, payment.currency)} paid.`,
        link: '/settings?tab=billing',
      },
      { push: true, urgent: true, email: { action: 'See your plan' } }
    );
  }
  return payment;
};

/** The student's plan and their paid plan payments, newest first. */
export const getBilling = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const [user, payments] = await Promise.all([
      User.findById(userId).select('plan planExpiresAt country').lean(),
      Payment.find({ user: userId, status: 'paid' }).sort({ paidAt: -1 }).limit(50),
    ]);
    const region = regionFor(user?.country);
    sendSuccess(res, {
      region,
      currency: REGION_CURRENCY[region],
      plan: user ? activePlan(user) : 'free',
      planExpiresAt: user?.planExpiresAt ?? null,
      payments: payments.map(toPublicPayment),
      paymentsReady: bachsReady(),
    });
  } catch (error) {
    next(error);
  }
};

/** Checks a coupon against a plan and shows the new price. Nothing is reserved. */
export const checkCoupon = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { code, plan, period } = req.body ?? {};
    if (!isPaidPlan(plan) || !isPeriod(period)) {
      sendError(res, 'Choose a plan and billing period', 400);
      return;
    }
    if (!findCoupon(code)) {
      sendError(res, "That code isn't valid", 404, { code: 'COUPON_INVALID' });
      return;
    }
    const owner = await User.findById(req.user!.id).select('country').lean();
    const result = quote(plan, period, code, regionFor(owner?.country));
    sendSuccess(res, {
      coupon: { code: result.coupon!.code, percent: result.coupon!.percent, label: result.coupon!.label },
      currency: result.currency,
      price: result.price,
      discount: result.discount,
      total: result.total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Opens a Bachs checkout for a plan. The price is worked out here from the
 * plan, period and coupon; the page only says which it wants. Returns the
 * checkout link for the Bachs overlay (or a redirect).
 */
export const startCheckout = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { plan, period, coupon } = req.body ?? {};
    if (!isPaidPlan(plan) || !isPeriod(period)) {
      sendError(res, 'Choose a plan and billing period', 400);
      return;
    }
    if (coupon && !findCoupon(coupon)) {
      sendError(res, "That code isn't valid", 400, { code: 'COUPON_INVALID' });
      return;
    }
    if (!bachsReady()) {
      sendError(res, "Payments aren't set up yet. Please try again later.", 503, { code: 'PAYMENTS_OFF' });
      return;
    }
    const user = await User.findById(userId).select('email firstName lastName country');
    if (!user) {
      sendError(res, 'Account not found', 404);
      return;
    }

    // Priced by the country on their account, never by what the page shows
    const price = quote(plan, period, coupon, regionFor(user.country));
    const payment = await Payment.create({
      user: userId,
      plan,
      period,
      price: price.price,
      discount: price.discount,
      amount: price.total,
      coupon: price.coupon?.code ?? null,
      currency: price.currency,
      region: price.region,
    });

    try {
      const checkout = await createCheckout({
        reference: String(payment._id),
        amount: price.total,
        currency: price.currency,
        email: user.email,
        name: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email,
        successUrl: `${env.APP_URL}/settings?tab=billing&payment=${payment._id}`,
        cancelUrl: `${env.APP_URL}/settings?tab=billing`,
        metadata: { paymentId: String(payment._id), userId, plan, period },
      });
      payment.checkoutId = checkout.checkout_id;
      await payment.save();
      sendSuccess(res, {
        payment: toPublicPayment(payment),
        checkoutId: checkout.checkout_id,
        checkoutUrl: checkout.checkout_url,
      });
    } catch (error) {
      payment.status = 'failed';
      await payment.save();
      console.error('Bachs checkout failed:', (error as Error).message);
      sendError(res, "We couldn't open checkout. Please try again.", 502, { code: 'CHECKOUT_FAILED' });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Where a payment stands. The page polls this after the Bachs overlay closes;
 * while it's still pending we ask Bachs directly, so a slow webhook doesn't
 * keep the student waiting.
 */
export const getPayment = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    let payment = await Payment.findOne({ _id: req.params.id, user: userId }).catch(() => null);
    if (!payment) {
      sendError(res, 'Payment not found', 404);
      return;
    }
    if (payment.status === 'pending' && payment.checkoutId && bachsReady()) {
      try {
        const checkout = await getCheckout(payment.checkoutId);
        const status = toPaymentStatus(checkout.status);
        if (status === 'paid') payment = (await fulfil(payment._id)) ?? payment;
        else if (status !== 'pending') {
          payment.status = status;
          await payment.save();
          if (status === 'failed') paymentFailed(payment);
        }
      } catch (error) {
        console.error('Bachs lookup failed:', (error as Error).message);
      }
    }
    const user = await User.findById(userId).select('plan planExpiresAt').lean();
    sendSuccess(res, {
      payment: toPublicPayment(payment),
      plan: user ? activePlan(user) : 'free',
      planExpiresAt: user?.planExpiresAt ?? null,
    });
  } catch (error) {
    next(error);
  }
};

interface BachsEvent {
  id?: string;
  type?: string;
  data?: { checkout_id?: string; reference?: string; metadata?: Record<string, string>; status?: string };
}

/**
 * Bachs tells us about payments here. Signed with the webhook secret; the raw
 * body is checked before anything is trusted. Always answers fast: Bachs
 * retries anything that isn't a 2xx.
 */
export const bachsWebhook = async (req: Request, res: Response): Promise<void> => {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifyWebhook(raw, req.headers)) {
    res.status(400).json({ success: false, message: 'Invalid signature' });
    return;
  }
  try {
    const event = JSON.parse(raw.toString('utf8')) as BachsEvent;
    const data = event.data ?? {};
    const paymentId = data.metadata?.paymentId ?? data.reference;
    const payment = paymentId
      ? await Payment.findById(paymentId).catch(() => null)
      : data.checkout_id
        ? await Payment.findOne({ checkoutId: data.checkout_id })
        : null;

    if (payment && !(event.id && payment.events.includes(event.id))) {
      if (event.id) await Payment.updateOne({ _id: payment._id }, { $addToSet: { events: event.id } });
      if (event.type === 'checkout.completed' || event.type === 'collection.succeeded') {
        await fulfil(payment._id);
      } else if (event.type === 'collection.failed' && payment.status === 'pending') {
        await Payment.updateOne({ _id: payment._id }, { status: 'failed' });
        paymentFailed(payment);
      } else if (event.type === 'checkout.expired' && payment.status === 'pending') {
        await Payment.updateOne({ _id: payment._id }, { status: 'expired' });
      }
    }
    res.json({ received: true });
  } catch (error) {
    // Ours to fix; a 500 makes Bachs try again later
    console.error('Bachs webhook failed:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * What the student has used this month, for Billing's usage card. All real:
 * AI tokens per day and per feature (requests made with a model the student
 * picked; background work BreedX pays for, like reading files or making
 * quizzes, isn't counted), pages read from files they added this month, live
 * counts against the plan's limits, and today's energy tank.
 */
export const getUsage = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const owner = new Types.ObjectId(userId);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const daysSoFar = now.getUTCDate();

    const [energy, { plan, limits }, rows, pageRows, storage, libraries, spaces, quizzesToday] = await Promise.all([
      energyFor(userId),
      planFor(userId),
      AiUsage.aggregate<{ _id: { day: number; feature: string }; tokens: number }>([
        { $match: { user: owner, aiModel: { $ne: null }, createdAt: { $gte: monthStart } } },
        {
          $group: {
            _id: { day: { $dayOfMonth: { date: '$createdAt', timezone: 'UTC' } }, feature: '$feature' },
            tokens: { $sum: { $add: ['$inputTokens', '$outputTokens'] } },
          },
        },
      ]),
      // Pages in the files the student added this month (each file once)
      LibraryFile.aggregate<{ pages: number; scanned: number }>([
        { $match: { owner, createdAt: { $gte: monthStart }, material: { $ne: null } } },
        { $group: { _id: '$material' } },
        { $lookup: { from: 'materials', localField: '_id', foreignField: '_id', as: 'material' } },
        { $unwind: '$material' },
        {
          $group: {
            _id: null,
            pages: { $sum: { $ifNull: ['$material.pageCount', 0] } },
            scanned: { $sum: { $ifNull: ['$material.scannedPages', 0] } },
          },
        },
      ]),
      storageUsed(userId),
      Library.countDocuments({ owner: userId }),
      Space.countDocuments({ owner: userId }),
      Quiz.countDocuments({ owner: userId, method: { $ne: 'warmup' }, createdAt: { $gte: startOfToday() } }),
    ]);

    const daily = Array.from({ length: daysSoFar }, () => 0);
    const byFeature = Object.fromEntries(AI_FEATURES.map((feature) => [feature, 0])) as Record<string, number>;
    for (const row of rows) {
      daily[row._id.day - 1] = (daily[row._id.day - 1] ?? 0) + row.tokens;
      byFeature[row._id.feature] = (byFeature[row._id.feature] ?? 0) + row.tokens;
    }
    const allowance = MONTHLY_ALLOWANCE[plan];

    sendSuccess(res, {
      plan,
      month: {
        start: monthStart,
        resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
        tokens: { used: daily.reduce((sum, value) => sum + value, 0), limit: allowance.tokens },
        daily,
        byFeature,
        pages: { used: pageRows[0]?.pages ?? 0, limit: allowance.pages },
        scanned: { used: pageRows[0]?.scanned ?? 0, limit: allowance.scanned },
      },
      limits: {
        storage: { used: storage, limit: limits.storageBytes },
        libraries: { used: libraries, limit: limits.libraries },
        spaces: { used: spaces, limit: limits.spaces },
        quizzesToday: { used: quizzesToday, limit: limits.quizzes.createsPerDay },
      },
      energy,
    });
  } catch (error) {
    next(error);
  }
};
