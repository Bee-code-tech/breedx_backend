# Spaces API

Base URL: `https://api.breedx.org/api/v1`

Every route needs `Authorization: Bearer <accessToken>`.

A space is a shared room for a class, department or study group: courses with
materials, schedule updates and members. A space is identified by its **slug**
(e.g. `optometry-300l-k3p9`). The slug is also the invite code, so the invite
link is `breedx.org/j/<slug>` and the page is `/classes/<slug>`.

## Roles

| Role | Can |
|---|---|
| `owner` | Everything: settings, roles, delete the space. Can't leave (deletes instead). One per space. |
| `admin` | Change the photo, add/edit/delete courses, rename/remove any material, invite, remove plain members. |
| `member` | View. Add materials if `rules.membersCanUpload`, invite if `rules.membersCanInvite`. Rename/remove their own materials. Leave. |

A space you're not an active member of answers **404**, the same as one that
doesn't exist.

## Plan limits

The limit is on spaces you **own**. Joining other people's spaces is unlimited.

| Plan | Spaces you can own |
|---|---|
| Free | 1 |
| Scholar | 5 |
| Elite | Unlimited |

Over the limit, `POST /spaces` answers `403`:

```json
{
  "success": false,
  "message": "Your plan includes 1 space. Upgrade to create more.",
  "code": "PLAN_LIMIT",
  "limit": "spaces"
}
```

## The Space object

Every route that changes a space returns the whole space as the viewer sees it,
so the page can replace its copy with the response.

```json
{
  "id": "6af0…",
  "slug": "optometry-300l-k3p9",
  "name": "Optometry 300L",
  "school": "University of Ilorin",
  "memberCount": 5,
  "description": "Notes, past questions and updates…",
  "imageUrl": null,
  "privacy": "private",
  "viewerRole": "owner",
  "rules": { "membersCanUpload": true, "membersCanInvite": false, "approveNewMembers": true },
  "inviteLink": "breedx.org/j/optometry-300l-k3p9",
  "createdBy": "You",
  "createdAt": "2026-09-29T08:00:00.000Z",
  "activity": {
    "scheduleUpdates": [
      { "id": "…", "kind": "exam", "title": "OPT 301 test moved to Thursday", "detail": "10:00 AM, Optometry Lecture Theatre", "postedBy": "Chiamaka", "at": "…" }
    ],
    "recentlyShared": [
      { "id": "…", "title": "Ocular Anatomy lecture 1.pdf", "fileType": "pdf", "uploadedBy": "You", "uploadedAt": "…" }
    ],
    "upcomingTests": [{ "id": "…", "title": "OPT 301 test", "source": "Posted by the class rep", "date": "…" }],
    "quizActivity": [{ "id": "…", "title": "Chiamaka topped the OPT 301 leaderboard", "detail": "88% average across 9 quizzes", "at": "…" }]
  },
  "courses": [
    { "id": "…", "title": "Ocular Anatomy", "code": "OPT 301", "materials": [ /* same shape as recentlyShared */ ] }
  ],
  "members": [
    { "id": "…", "name": "Al-Ameen Babawale", "role": "owner", "isYou": true, "joinedAt": "…" },
    { "id": "…", "name": "new@example.com", "role": "member", "status": "invited", "joinedAt": "…" }
  ]
}
```

- `createdBy` and `uploadedBy` say `"You"` for the viewer.
- `memberCount` counts joined members only, not pending invites.
- `recentlyShared` is the 12 newest materials across all courses.
- `upcomingTests` only lists tests that haven't happened yet.
- `members` are sorted owner → admins → members, newest first. Invites have `status: "invited"` and the email as `name`.
- `fileType` is `pdf`, `doc` or `ppt`. Schedule `kind` is `timetable`, `exam`, `venue`, `deadline` or `cancelled`.

## Spaces

### List yours

`GET /spaces`: the spaces you've created or joined, oldest membership first. Used for the sidebar's "My Spaces"; hide that section when the list is empty.

```json
[{ "id": "…", "slug": "optometry-300l-k3p9", "name": "Optometry 300L", "imageUrl": null, "role": "owner", "memberCount": 5 }]
```

### Create

`POST /spaces` → `201` with the Space

```json
{ "name": "CSC 301 Study Hub", "school": "University of Ilorin", "reason": "A study group", "privacy": "public" }
```

- `name` up to 80 characters, `school` up to 120, `reason` up to 60 (optional).
- `privacy` is `public` or `private`.
- The slug is made from the name plus 4 random characters. You become the owner.

### Get

`GET /spaces/:slug` → the Space, or `404` if you're not in it.

### Update

`PATCH /spaces/:slug` → the Space. Send only what changes.

```json
{
  "name": "Optometry 300L",
  "school": "University of Ilorin",
  "description": "Up to 300 characters",
  "privacy": "private",
  "rules": { "membersCanUpload": false },
  "imageUrl": "data:image/jpeg;base64,…"
}
```

- `name`, `school`, `description`, `privacy` and `rules` are **owner only**.
- `imageUrl` can be changed by the owner or an admin: a JPG, PNG or WebP data URL up to 120,000 characters, or `null` to remove it.
- `rules` merges: unsent keys keep their value.

### Delete

`DELETE /spaces/:slug` (owner) → removes the space and every membership.

### Leave

`POST /spaces/:slug/leave` → `400` for the owner, who deletes the space instead.

## Joining

### Preview an invite

`GET /spaces/invite/:code` → what someone sees before joining; `404` if no space matches.

```json
{
  "slug": "csc-301-study-hub-ijji",
  "name": "CSC 301 Study Hub",
  "school": "University of Ilorin",
  "memberCount": 12,
  "createdBy": "Bola",
  "createdAt": "…",
  "isMember": false,
  "members": [{ "id": "…", "name": "Bola Ade", "role": "owner", "joinedAt": "…" }]
}
```

`members` holds up to 3 faces. When `isMember` is true, open the space instead of joining.

### Join

`POST /spaces/invite/:code/join` → `201` with the Space (`200` if you're already in).

If the space has a pending email invite for your account's email, it becomes your membership and keeps the role it was given.

## Members

### Invite by email

`POST /spaces/:slug/invites` (owner, admin, or anyone when `membersCanInvite`) → the Space

```json
{ "emails": ["tolu@example.com", "ada@example.com"] }
```

1–20 emails. People already in the space are skipped; inviting the same email twice does nothing. Invites are saved as members with `status: "invited"`. **No email is sent yet**: share the invite link with them.

### Change a role

`PATCH /spaces/:slug/members/:memberId` (owner) → the Space

```json
{ "role": "admin" }
```

`role` is `admin` or `member`. The owner's role can't change.

### Remove someone or cancel an invite

`DELETE /spaces/:slug/members/:memberId` (owner or admin) → the Space

Admins can only remove plain members. Nobody can remove the owner.

## Courses

All course routes are for the owner and admins, and return the Space.

| Route | Body |
|---|---|
| `POST /spaces/:slug/courses` | `{ "title": "Visual Optics", "code": "OPT 303" }` |
| `PATCH /spaces/:slug/courses/:courseId` | `{ "title": "Visual Optics", "code": "OPT 303" }` |
| `DELETE /spaces/:slug/courses/:courseId` | |

`title` up to 100 characters. `code` up to 20, stored in capitals. New courses go first. Deleting a course deletes its materials.

## Materials

### Add

`POST /spaces/:slug/materials` (owner, admin, or anyone when `membersCanUpload`) → `201` with the Space

```json
{
  "courseIds": ["…", "…"],
  "files": [{ "title": "Linked lists.pdf", "fileType": "pdf" }]
}
```

- 1–20 files; each file is added to every course in `courseIds`.
- `fileType` is optional: without it the type comes from the extension (`.ppt/.pptx/.key` → `ppt`, `.doc/.docx/.txt/.rtf/.odt` → `doc`, anything else → `pdf`).
- **Only the name and type are stored for now**, not the file itself.

### Rename

`PATCH /spaces/:slug/materials/:materialId` → the Space

```json
{ "title": "Linked lists v2.pdf" }
```

### Remove

`DELETE /spaces/:slug/materials/:materialId` → the Space

Rename and remove are allowed for the owner, admins, and whoever added the material.

## Schedule

Each space has one schedule with four kinds of entry: classes, tests, exams and study. **Only the owner** adds,
edits or removes entries; every member can view and download it.

| Kind | Repeats | When | Name |
|---|---|---|---|
| `class` | Weekly | `day` 1 (Monday) … 7 (Sunday) | a space course (`courseId`) |
| `exam` | Once | `date` `YYYY-MM-DD` | a space course (`courseId`) |
| `test` | Once | `date` `YYYY-MM-DD` | a space course (`courseId`) |
| `study` | Weekly | `day` 1 … 7 | a space course (`courseId`) |

**Study** is each member's own reading timetable: any member saves theirs with `PUT /spaces/:slug/schedule/study` (same body as classes), only they see it (in the schedule and on Home), only they get its reminders (10 minutes before), and it never posts to the feed. It's deleted when they leave or are removed.

Every entry belongs to one of the space's **courses**: send `courseId` and
the entry shows that course's current code and name, so renaming a course
updates the timetable. (Typing `courseCode` + `title` instead still works for
older clients.) Deleting a course deletes its timetable entries. This link is
what lets reminders point at the course's materials.

Times are 24-hour `HH:mm` in the space's `timezone` (default `Africa/Lagos`).
`endTime` must be after `startTime`. Limits: code 20, title 100, venue 60,
note 200 characters, 300 entries per space.

### Get

`GET /spaces/:slug/schedule`

```json
{
  "timezone": "Africa/Lagos",
  "canEdit": true,
  "onHome": true,
  "entries": [
    { "id": "…", "kind": "class", "day": 1, "courseId": "…", "startTime": "08:00", "endTime": "10:00", "courseCode": "GET 316", "title": "Engine Math IV", "venue": "ELH II", "note": "" },
    { "id": "…", "kind": "exam", "date": "2026-11-21", "startTime": "09:00", "endTime": "12:00", "courseCode": "GET 316", "title": "Engine Math IV", "venue": "Main Auditorium", "note": "" }
  ]
}
```

`onHome` says whether this is the schedule on your Home.

### Save the whole week of classes (owner)

`PUT /spaces/:slug/schedule/classes` (owner) replaces every class with the list sent; `PUT /spaces/:slug/schedule/study` does the same for your own study timetable, in one change. This is what the timetable editor uses.

```json
{ "entries": [{ "day": 1, "startTime": "08:00", "endTime": "10:00", "courseId": "…", "venue": "ELH II" }] }
```

Up to 100 classes. An empty list clears the timetable.

### Add, edit, remove one entry (owner)

| Route | Body |
|---|---|
| `POST /spaces/:slug/schedule` | the whole entry, with `kind` |
| `PATCH /spaces/:slug/schedule/:entryId` | the whole entry (its `kind` can't change) |
| `DELETE /spaces/:slug/schedule/:entryId` | |

Each returns the schedule, as above.

Every change also:
- Adds an item to the space's `scheduleUpdates`, e.g. "Class timetable updated" with what changed. Edits within 30 minutes of each other update one item instead of piling up.
- Sends one push notification to the other members, two minutes after the owner stops editing, so building a whole timetable sends one notification, not twenty.

### Home

- `PUT /spaces/:slug/home`: show this space's schedule on your Home. Any member can do this; it replaces your previous choice.
- `DELETE /spaces/:slug/home`: stop showing it. Home then shows no schedule until you pick one again.
- `GET /schedule/home`: the schedule on your Home.

```json
{ "space": { "slug": "optometry-300l-k3p9", "name": "Optometry 300L" }, "timezone": "Africa/Lagos", "entries": [] }
```

If you've never picked, Home uses the first space you joined that has a schedule. `space` is `null` when none has one, or when you turned it off. `space.imageUrl` is the space's photo.

### Reminders

A push notification goes out:

| Kind | When |
|---|---|
| `class` | 30 minutes before, every week. When the course has materials, the newest is suggested: "Look over: …" |
| `test` | 6 PM the evening before, and 1 hour before |
| `exam` | 6 PM the evening before, and 1 hour before |

Reminders only go to members whose **Home** is that space, so someone in five spaces isn't flooded.

A loop checks once a minute. It runs in production only; set `REMINDERS=on` to run it locally. Each reminder is logged in `reminderlogs`, so two servers or a restart never send it twice.

## Push notifications

Browsers subscribe with the server's public key. Push is off until both keys are set.

| Route | Body |
|---|---|
| `GET /push/key` | → `{ "enabled": true, "publicKey": "B…" }` |
| `POST /push/subscriptions` | the browser's `PushSubscription.toJSON()`: `{ endpoint, keys: { p256dh, auth } }` |
| `DELETE /push/subscriptions` | `{ "endpoint": "https://…" }` |

Environment:

```
VAPID_PUBLIC_KEY=…
VAPID_PRIVATE_KEY=…
VAPID_SUBJECT=mailto:info@breedx.org
```

Generate the keys once with `npx web-push generate-vapid-keys`. **Every server must use the same pair**: a device subscribed with one key can't receive pushes signed with another. Devices that unsubscribe are removed the next time a push to them fails.

On iPhone, push only works in the installed app (Add to Home Screen), not in Safari.

## Not built yet

- Invite emails (invites are saved, not sent).
- File storage for space materials (only names and types are kept).
- `rules.approveNewMembers` is saved but not enforced: people join straight away.
- `upcomingTests` and `quizActivity` are only filled by the seed. (Schedule updates now come from the schedule.)
- Changing a space's `timezone` (it's always `Africa/Lagos` for now).

## Seeding

`npm run seed:spaces -- <userId>` creates 12 test users and four spaces around that account, with 5 members each:

- The users are `test1@breedx.org` to `test12@breedx.org`, all with password `Test@123`.
- The account owns one space, is an admin in one and a plain member of two.
- It changes nothing if `test1@breedx.org` already exists, so it can only run once.

Signing in as a test user on a new device sends a code to that address, so it only works if those inboxes receive mail.

## Data

- `spaces`: one document per space, with its courses (and their materials), schedule updates, upcoming tests and quiz activity embedded.
- `spacemembers`: one row per person per space (`user` once joined, `email` while invited), with their `role`, `status` (`active` or `invited`) and `onHome`.
- `scheduleentries`: one row per class, test or exam.
- `pushsubscriptions`: one row per device that allowed notifications.
- `reminderlogs`: reminders already sent; rows expire after a week.


## Course materials (files)

Course materials are real files. Every member can open them, the AI can read them, and they feed the class's warm-ups. Uploading takes 3 steps, like libraries:

1. `POST /spaces/:slug/courses/:courseId/uploads` with `{ "name": "Lecture 3.pdf", "size": 3145728, "contentType": "application/pdf" }` → `{ material, uploadUrl }`
2. `PUT` the file to `uploadUrl` (no auth header).
3. `POST /spaces/:slug/materials/:materialId/complete` → `{ material }`. Other members are notified.

Rules for uploading:
- Accepts PDF, Word (.doc/.docx), PowerPoint (.ppt/.pptx), Keynote, EPUB and text files.
- The owner and admins can always upload; members can when the space allows it (`rules.membersCanUpload`).
- Counts against the **uploader's** storage (the same file anywhere counts once).
- An upload that never finishes is removed after a day.

| Action | Request |
|---|---|
| Open or download (any member) | `GET /spaces/:slug/materials/:materialId/content` |
| Save to one of my libraries | `POST /spaces/:slug/materials/:materialId/save` with `{ "libraryId": "…" }` → `{ fileId, libraryId }`. Uses the same stored file, so nothing is uploaded again |
| Rename | `PATCH /spaces/:slug/materials/:materialId` with `{ "title": "…" }` |
| Remove | `DELETE /spaces/:slug/materials/:materialId`. The file itself is deleted only when no library or course uses it any more |

In the space, each material now has `size`, `status` (`uploading` shows only to the uploader, then `ready`; `legacy` means it was added by name before uploads existed) and `hasFile`.
