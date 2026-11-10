import crypto from 'crypto';
import env from '../config/env';

// Bachs (https://docs.bachs.io): hosted checkout for card, bank transfer and
// more. Money is a decimal string in naira, e.g. "3500.00". A sandbox key
// (sk_sandbox_…) only works on the sandbox API, a live key on the live one.

export const bachsReady = () => Boolean(env.BACHS_API_KEY);

const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> => {
  const response = await fetch(`${env.BACHS_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.BACHS_API_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    // Bachs errors use `detail` / `error_code`; older shapes used `message`.
    const message =
      data?.detail ??
      data?.message ??
      data?.error?.message ??
      data?.error_code ??
      `Bachs returned ${response.status}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return data as T;
};

export interface BachsCheckout {
  checkout_id: string;
  checkout_url: string;
  status: string;
  expires_at?: string;
}

export const createCheckout = (input: {
  reference: string;
  amount: number;
  currency: 'NGN' | 'USD';
  email: string;
  name: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}) =>
  call<BachsCheckout>(
    'POST',
    '/v1/checkout-sessions',
    {
      pricing: { currency: input.currency, amount: input.amount.toFixed(2) },
      customer: { email: input.email, name: input.name },
      reference: input.reference,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
      expires_in_minutes: 60,
    },
    `checkout-${input.reference}`
  );

export const getCheckout = (checkoutId: string) =>
  call<BachsCheckout & Record<string, unknown>>('GET', `/v1/checkout-sessions/${encodeURIComponent(checkoutId)}`);

/** A checkout status from Bachs, in our words. */
export const toPaymentStatus = (status: unknown): 'paid' | 'failed' | 'expired' | 'pending' => {
  const value = String(status ?? '').toLowerCase();
  if (['completed', 'complete', 'paid', 'succeeded', 'success'].includes(value)) return 'paid';
  if (['failed', 'declined'].includes(value)) return 'failed';
  if (['expired', 'cancelled', 'canceled'].includes(value)) return 'expired';
  return 'pending';
};

const TOLERANCE_SECONDS = 300;

/**
 * Checks a webhook really came from Bachs: HMAC-SHA256 of "{timestamp}.{raw body}"
 * with the endpoint's signing secret. Prefers the V2 header
 * (t=…,v1=…[,v1=…] while a secret is being rotated).
 */
export const verifyWebhook = (rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean => {
  if (!env.BACHS_WEBHOOK_SECRET) return false;
  const header = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  let timestamp = header('x-bachs-timestamp');
  let signatures: string[] = [];
  const v2 = header('x-bachs-signature-v2');
  if (v2) {
    for (const part of v2.split(',')) {
      const [key, value] = part.split('=');
      if (key?.trim() === 't') timestamp = value?.trim();
      if (key?.trim() === 'v1' && value) signatures.push(value.trim());
    }
  } else {
    const v1 = header('x-bachs-signature');
    if (v1) signatures = [v1];
  }
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', env.BACHS_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const want = Buffer.from(expected, 'hex');
  return signatures.some((signature) => {
    const got = Buffer.from(signature, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
};
