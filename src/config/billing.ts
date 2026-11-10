import { PlanId } from './plans';
import { PriceRegion } from './regions';

// What each paid plan costs, per pricing region. Keep in step with the
// frontend's lib/pricing.ts: the server always charges these, never what a
// page sends. Nigeria pays in naira; everywhere else in US dollars, with
// emerging markets cheaper and developed ones $2 under the main competitors.
export const BILLING_PERIODS = ['monthly', 'semester', 'session'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];
export type PaidPlan = Exclude<PlanId, 'free'>;

export const REGION_CURRENCY: Record<PriceRegion, 'NGN' | 'USD'> = {
  ng: 'NGN',
  emerging: 'USD',
  developed: 'USD',
};

export const PLAN_PRICES: Record<PriceRegion, Record<PaidPlan, Record<BillingPeriod, number>>> = {
  ng: {
    scholar: { monthly: 3_500, semester: 10_500, session: 18_000 },
    elite: { monthly: 7_500, semester: 22_500, session: 39_000 },
  },
  emerging: {
    scholar: { monthly: 2.99, semester: 7.99, session: 14.99 },
    elite: { monthly: 4.99, semester: 12.99, session: 24.99 },
  },
  developed: {
    scholar: { monthly: 5.99, semester: 17.99, session: 33.99 },
    elite: { monthly: 7.99, semester: 23.99, session: 42.99 },
  },
};

/**
 * Monthly allowances shown on Billing's usage card. Keep in step with the
 * frontend's TIER_LIMITS in lib/pricing.ts. Tokens count the AI requests a
 * student makes with a model they chose; background work BreedX pays for
 * (reading files, quiz generation) isn't counted.
 */
/** `pages: null` is unlimited. */
export const MONTHLY_ALLOWANCE: Record<PlanId, { tokens: number; pages: number | null; scanned: number }> = {
  free: { tokens: 300_000, pages: 1_500, scanned: 0 },
  scholar: { tokens: 1_500_000, pages: 10_000, scanned: 200 },
  elite: { tokens: 4_000_000, pages: null, scanned: 1_000 },
};

/** How long each period lasts. */
export const PERIOD_MONTHS: Record<BillingPeriod, number> = {
  monthly: 1,
  semester: 4,
  session: 12,
};

/**
 * Coupons. Simulated for now: a fixed list until there's an admin screen.
 * `percent` comes off the plan price.
 */
export const COUPONS: Record<string, { percent: number; label: string }> = {
  BREEDX35: { percent: 35, label: '35% off' },
  STUDENT20: { percent: 20, label: '20% off' },
};

export const findCoupon = (code: unknown) => {
  if (typeof code !== 'string') return null;
  const key = code.trim().toUpperCase();
  const coupon = COUPONS[key];
  return coupon ? { code: key, ...coupon } : null;
};

/** The price in the region's currency after a coupon: whole naira, or cents for dollars. */
export const quote = (plan: PaidPlan, period: BillingPeriod, couponCode: unknown, region: PriceRegion) => {
  const currency = REGION_CURRENCY[region];
  const price = PLAN_PRICES[region][plan][period];
  const coupon = couponCode ? findCoupon(couponCode) : null;
  const unit = currency === 'NGN' ? 1 : 100;
  const discount = coupon ? Math.round((price * coupon.percent * unit) / 100) / unit : 0;
  const total = Math.round((price - discount) * unit) / unit;
  return { price, discount, total, coupon, currency, region };
};
