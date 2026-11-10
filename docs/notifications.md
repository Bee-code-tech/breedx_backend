# Notifications API

Base URL: `https://api.breedx.org/api/v1`

Every route needs `Authorization: Bearer <accessToken>`.

## How it works

Everything that happens goes **under the bell**. Important things also go out as a **push** (lock screen, like a native app) and/or an **email**, depending on the student's settings.

| Category | Examples | Push by default | Email by default |
|---|---|---|---|
| `schedule` | Class in 30 mins, ⚡ warm-up, test or exam tomorrow, timetable changed | ✅ | ✅ (test or exam tomorrow) |
| `study` | 🔥 "Your 6-day streak ends tonight" (8 pm) | ✅ | — |
| `quizzes` | "3 people took your quiz" | ✅ (first taker) | — |
| `spaces` | Invited to a space, someone joined, new materials | ✅ (invites) | ✅ (invites) |
| `ai` | Low AI energy | ✅ | — |
| `account` | Payment received or failed, plan ends in 3 days | ✅ | ✅ |
| `announcements` | BreedX news (admins send these) | Only if the admin asks | Only if the admin asks |

**Rules:**
- **Quiet hours:** no pushes from 10 pm to 7 am in the student's timezone, except class reminders, warm-ups and payments. They still go under the bell.
- **At most 6 pushes in 24 hours**, except urgent ones.
- **Grouped:** similar notifications in a day join one item ("3 people took your quiz"), and only the first one pushes or emails.
- **Kept for 90 days.**
- **Push needs this device to be subscribed** (Settings → Notifications → Turn on). On iPhone, BreedX must be added to the Home Screen first.
- **Inviting someone without an account** emails them a sign-up invite.

## The bell

`GET /notifications` → newest first, 30 at a time. `?before=<updatedAt>` loads older ones; `?unread=true` returns only unread.

```json
{
  "notifications": [
    {
      "id": "…",
      "category": "schedule",
      "kind": "warmup",
      "title": "CSC 201 in 30 mins ⚡",
      "body": "Warm-up: Merge sort · 5 questions, ~3 min\nTopic 3 of 12 · 10:00 AM in LT1",
      "link": "/quizzes?warmup=…",
      "image": null,
      "count": 1,
      "read": false,
      "createdAt": "…",
      "updatedAt": "…"
    }
  ],
  "hasMore": false,
  "unreadCount": 3
}
```

- `kind` says exactly what happened: `class-reminder`, `test-tomorrow`, `warmup`, `schedule-change`, `streak`, `quiz-taken`, `space-invite`, `space-joined`, `space-materials`, `energy-low`, `payment-success`, `payment-failed`, `plan-ending` or `announcement`.
- `count` is more than 1 for grouped items.
- Sort and page by `updatedAt`, because a group moves to the top when someone new joins it.

| Action | Request | Returns |
|---|---|---|
| Unread count (poll every minute) | `GET /notifications/unread-count` | `{ unreadCount }` |
| Mark read | `POST /notifications/read` with `{ "ids": ["…"] }` or `{ "all": true }` | `{ unreadCount }` |
| Delete | `DELETE /notifications/:id` | `{ unreadCount }` |

**Push taps:** the push payload carries `notificationId` and `unread`. The service worker opens the link with `?notification=<id>` added, and the app marks that notification read. It also updates the app icon's badge and tells open tabs to refresh the bell.

## Settings

`GET /notifications/preferences`

```json
{
  "preferences": {
    "schedule": { "push": true, "email": true },
    "study": { "push": true, "email": false },
    "quizzes": { "push": true, "email": false },
    "spaces": { "push": true, "email": true },
    "ai": { "push": true, "email": false },
    "account": { "push": true, "email": true },
    "announcements": { "push": false, "email": true }
  }
}
```

`PUT /notifications/preferences` with only what changes: `{ "quizzes": { "push": false } }` → the full `preferences`.

Pre-class warm-ups have their own switch: `PATCH /progress/settings` with `{ "warmups": false }` (see [progress.md](progress.md)).

## Announcements (admins)

`POST /notifications/announce`

```json
{ "title": "BreedX launches Monday 🚀", "body": "Doors open at 9 am.", "link": "/home", "push": true, "email": false, "userIds": ["…"] }
```

- Without `userIds`, it goes to every verified student.
- It's sent in the background → `202 { recipients }`.

## Sending one from the backend

```ts
import { notify } from '../utils/notify';

void notify([userId], {
  category: 'account',
  kind: 'payment-success',
  title: 'Payment received ✅',
  body: "You're on Scholar until 10 March.",
  link: '/settings?tab=billing',
}, { push: true, email: { action: 'See your plan' }, urgent: true });
```

- `group: { key, title: (count) => …, body?: (count) => … }` joins similar ones.
- It never throws.
- Emails use `templates/notification.html` (the BreedX header and footer, a heading, a message and a button).
