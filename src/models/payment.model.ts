import mongoose, { Document, Schema, Types } from 'mongoose';
import { BILLING_PERIODS, BillingPeriod, PaidPlan } from '../config/billing';

export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'expired'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** One checkout for a plan, from opening Bachs to paid (or not). */
export interface IPayment extends Document {
  user: Types.ObjectId;
  plan: PaidPlan;
  period: BillingPeriod;
  /** In `currency`: the plan price, what the coupon took off, and what was charged. */
  price: number;
  discount: number;
  amount: number;
  coupon: string | null;
  currency: 'NGN' | 'USD';
  /** Where the price came from: the student's country at checkout. */
  region: string;
  /** Bachs' id for the checkout session. */
  checkoutId: string | null;
  status: PaymentStatus;
  paidAt: Date | null;
  /** Webhook event ids already handled, since Bachs may send one twice. */
  events: string[];
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    plan: { type: String, enum: ['scholar', 'elite'], required: true },
    period: { type: String, enum: BILLING_PERIODS, required: true },
    price: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    amount: { type: Number, required: true },
    coupon: { type: String, default: null },
    currency: { type: String, enum: ['NGN', 'USD'], default: 'NGN' },
    region: { type: String, default: 'ng' },
    checkoutId: { type: String, default: null, index: true },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'pending' },
    paidAt: { type: Date, default: null },
    events: { type: [String], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model<IPayment>('Payment', paymentSchema);
