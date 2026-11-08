# Partnerships

`POST /api/v1/partnerships` — public, rate limited (10 per 15 minutes per IP).

Body: `name`, `email`, `type` (`companies` | `agencies` | `organizations` | `individuals`) and `message` are required; `organization`, `phone`, `website` and `topic` are optional.

- **201**: saved. Two emails are sent in the background:
  - `partnership-received` to the sender (reply-to the inbox), promising a reply within 2 business days.
  - `partnership-request` to `PARTNERSHIPS_INBOX` (default `info@breedx.org`), reply-to the sender.
- **409** `code: "already_submitted"`: this email already sent a request. No email is sent.
- **400**: a missing or invalid field.

Requests live in the `partnershiprequests` collection. Email failures are logged and never fail the request.
