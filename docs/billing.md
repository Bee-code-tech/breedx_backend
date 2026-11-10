# Billing (Bachs)

Students pay for Scholar or Elite through [Bachs](https://docs.bachs.io) hosted checkout. The server works out the price from the plan, period and coupon. The page only says which plan it wants.

## Setup

Add to `.env`:

```
BACHS_API_URL=https://sandbox-api.bachs.io   # live: https://api.bachs.io
BACHS_API_KEY=sk_sandbox_...                  # Developer Portal → API keys (needs checkout-sessions write/read)
BACHS_WEBHOOK_SECRET=...                      # Developer Portal → Webhooks → your endpoint's signing secret
APP_URL=https://breedx.org                    # where Bachs sends students back; must be public, not localhost
```

Without `BACHS_API_KEY`, checkout answers `503 PAYMENTS_OFF` and everything else still works.

Webhook endpoint to register in Bachs: `POST {API_URL}/api/v1/billing/webhook`, with events `checkout.completed`, `collection.succeeded`, `collection.failed`, `checkout.expired`.

Testing webhooks locally: `bachs listen --forward-to localhost:5000/api/v1/billing/webhook`, then `bachs trigger collection.succeeded`. Sandbox payments succeed about a second after paying. Card `4000000000000002` is declined, and any other card number succeeds.

## Prices and coupons

`src/config/billing.ts`. Prices are in naira and must match the frontend's `lib/pricing.ts`.

| Plan | Monthly | Semester (4 months) | Session (12 months) |
|---|---|---|---|
| Scholar | 3,500 | 10,500 | 18,000 |
| Elite | 7,500 | 22,500 | 39,000 |

The coupons are simulated: a fixed list in `COUPONS`. Right now that's `BREEDX35` (35% off) and `STUDENT20` (20% off). Codes ignore case.

## Regions

Prices depend on the country on the student's account (`config/regions.ts`):

| Region | Who | Currency | Scholar (mo / semester / session) | Elite |
|---|---|---|---|---|
| `ng` | Nigeria | NGN | 3,500 / 10,500 / 18,000 | 7,500 / 22,500 / 39,000 |
| `emerging` | Most of Africa, South & Southeast Asia, Latin America, etc. (`EMERGING_COUNTRIES`) | USD | 2.99 / 7.99 / 14.99 | 4.99 / 12.99 / 24.99 |
| `developed` | Everyone else, and unknown countries | USD | 5.99 / 17.99 / 33.99 | 7.99 / 23.99 / 42.99 |

The page shows prices by the visitor's country (host header, then time zone), but checkout always charges by the account's country. A VPN doesn't change what's charged. Each `Payment` records its `currency` and `region`.

## Endpoints

All need a signed-in student, except the webhook.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/billing` | | `{ plan, planExpiresAt, payments[], paymentsReady }` |
| GET | `/billing/usage` | | `{ plan, month: { start, resetsAt, tokens: { used, limit }, daily[], byFeature, pages, scanned }, limits: { storage, libraries, spaces, quizzesToday }, energy }`. Tokens add up AiUsage input + output tokens this UTC month for requests made with a model the student chose (`aiModel` set). Work BreedX pays for (reading files, quiz generation) isn't counted. Pages and scanned pages come from the files the student added this month (`Material.pageCount` / `scannedPages`). Monthly allowances are in `MONTHLY_ALLOWANCE` (config/billing.ts) |
| POST | `/billing/coupon` | `{ code, plan, period }` | `{ coupon: { code, percent, label }, price, discount, total }`, or `404 COUPON_INVALID` |
| POST | `/billing/checkout` | `{ plan, period, coupon? }` | `{ payment, checkoutId, checkoutUrl }` |
| GET | `/billing/payments/:id` | | `{ payment, plan, planExpiresAt }` |
| POST | `/billing/webhook` | Bachs event (raw JSON) | `{ received: true }` |

A payment's `status` is `pending`, `paid`, `failed` or `expired`.

## Flow

1. The page calls `POST /billing/checkout`. We save a `Payment` (pending), create a Bachs checkout session with `reference` = payment id and `metadata.paymentId`, and return its `checkoutUrl`.
2. The page opens `checkoutUrl` in the Bachs overlay (`https://checkout.bachs.io/bachs.js`). If the script can't load, the page redirects to the URL instead.
3. Bachs calls the webhook. We check the signature: HMAC-SHA256 of `"{timestamp}.{raw body}"`, sent in `X-Bachs-Signature-V2` (`t=…,v1=…`) or `X-Bachs-Timestamp` + `X-Bachs-Signature`, and rejected if more than 5 minutes old. We skip event ids we've seen and mark the payment paid.
4. After the overlay closes, the page polls `GET /billing/payments/:id`. While the payment is still pending we ask Bachs directly, so a slow webhook doesn't hold the student up.

Marking a payment paid sets `user.plan` and extends `user.planExpiresAt` by the period: 1, 4 or 12 months, counted from the current end if the student already has that plan. `activePlan()` falls back to free once it passes, so energy, quiz limits and storage follow automatically. Fulfilment only happens once, however many times the webhook or poll sees the payment as paid.

## Notifications

Through `utils/notify` (bell, push and email; category `account`):

- `payment-success` when a payment is fulfilled: "You're on Scholar until …". Sent as urgent, since payments can land at night.
- `payment-failed` when Bachs reports a failed collection or the checkout comes back failed.
- `plan-ending`, 3 days before `planExpiresAt`, is sent by the reminder loop (see docs/notifications).
