# Quizzes API

Base URL: `https://api.breedx.org/api/v1/quizzes`

Every route needs `Authorization: Bearer <accessToken>`.

## Daily limits

Counted per day (UTC). `null` means unlimited.

| Plan | New quizzes | Attempts at your own quizzes | Attempts at shared quizzes |
|---|---|---|---|
| Free | 2 | 1 | 4 |
| Scholar | 10 | 10 | Unlimited |
| Elite | Unlimited | Unlimited | Unlimited |

"New quizzes" counts AI, written and imported quizzes alike.

`GET /quizzes/usage`

```json
{
  "plan": "free",
  "today": {
    "creates": { "used": 1, "limit": 2, "left": 1 },
    "privateTakes": { "used": 0, "limit": 1, "left": 1 },
    "publicTakes": { "used": 2, "limit": 4, "left": 2 }
  }
}
```

Over a limit → `403`:

```json
{ "success": false, "message": "Your plan allows 2 new quizzes a day. Upgrade to create more.", "code": "PLAN_LIMIT", "limit": "quizCreates" }
```

`limit` is `quizCreates`, `privateTakes` or `publicTakes`. Show the message and an upgrade button.

## The Quizzes page

`GET /quizzes`

```json
{
  "created": [
    {
      "id": "6af1…",
      "title": "CSC201 Notes Quiz",
      "method": "ai",
      "questionCount": 8,
      "difficulty": "medium",
      "types": ["mcqs", "true-false"],
      "sourceName": "CSC201 Notes.pdf",
      "createdAt": "…",
      "timeLimit": null,
      "retakes": 2,
      "randomize": true,
      "showResults": true,
      "hints": true,
      "visibility": "anyone",
      "participants": 14,
      "participantAttempts": 21,
      "bestScore": 100,
      "attempts": 1
    }
  ],
  "taken": [{ "…card fields": "…", "bestScore": 50, "attempts": 1, "lastTakenAt": "…" }],
  "today": { "…": "same as /quizzes/usage" }
}
```

- `created`: your quizzes. `participants` is how many other people took it.
- `taken`: quizzes others shared that you took.

## Create with AI (stream)

`POST /quizzes/generate`

```json
{
  "fileIds": ["6660…"],
  "libraryIds": ["665f…"],
  "count": 10,
  "types": ["mcqs", "true-false"],
  "difficulty": "medium",
  "title": "CSC 201 Mock",
  "settings": { "timeLimit": 20, "retakes": 2, "randomize": true, "showResults": true, "hints": true, "visibility": "anyone" }
}
```

- `fileIds` (library file ids) or `libraryIds`: at least one.
- `count`: 1 to 50. `types`: `mcqs` and/or `true-false`. **Short answer isn't supported yet**, so hide it or send `400`-safe types only.
- `title` and `settings` are optional (the defaults are shown in Settings below).

The stream sends `step` events whose ids match the generating screen, in this order (plus `prepare-…` when a file is read for the first time). Each has a `data` object with the real numbers, so the screen can word them in the student's language:

| Step | `data` |
|---|---|
| `reading` | `{ files, pages }` |
| `mapping` | `{ chapters, topics }` |
| `concepts` | `{ names: [up to 3 topic titles], concepts }` |
| `planning` | `{ count, difficulty, types, seen }` (`seen`: bank questions this student already had) |
| `creating` | `{ done, total, topic }` (sent as each topic finishes) |
| `reviewing` | `{ written, kept }` while writing, `{ checked }` when done |
| `balancing` | `{ topics, repeats }` (topics covered, questions the student has seen before) |
| `assembling` | `{ made, asked }` |

Then:

| Event | Data |
|---|---|
| `result` | `{ quiz }` (the full quiz, as from `GET /quizzes/:id` for the owner) |
| `error` | `{ message }`, e.g. the files had no readable text |

```
✓ Read 1 file
✓ Found 6 topics to cover
✓ Writing questions (6/6 topics)…
✓ Checked 24 new questions against your notes, kept 24
✓ Made 8 questions
```

**How it works:** questions come from a **shared bank** per file and topic. The first quiz from a file writes and checks questions (about 30 s); after that, quizzes from the same file are ready in about 2 s. Every question is checked against the notes before it's used, and a student gets questions they haven't had before first. Making quizzes costs **no AI energy**; it only counts toward the daily limit. If the files are short, the quiz can have fewer questions than asked (the last step says so).

## Create by hand or import

`POST /quizzes`

```json
{
  "title": "Optics Quick Check",
  "method": "import",
  "sourceName": "CSV File",
  "difficulty": "easy",
  "settings": { "timeLimit": 10 },
  "questions": [
    {
      "type": "mcqs",
      "prompt": "Power of a lens with a focal length of 0.5 m?",
      "choices": ["0.5 D", "2 D", "5 D", "20 D"],
      "correct": 1,
      "explanation": "P = 1/f = 1/0.5 = 2 D",
      "image": null,
      "choiceImages": []
    },
    { "type": "true-false", "prompt": "Myopia is corrected with a concave lens.", "correct": 0 }
  ]
}
```

- `method`: `manual` (default) or `import`.
- Up to 100 questions. Multiple choice has 2 to 6 options; true/false always uses `["True", "False"]` (`correct` 0 = True, 1 = False).
- `image` and `choiceImages`: PNG, JPEG, WebP or GIF **data URLs**, each under 500 KB.
- `id` on a question is optional; send it back when editing so earlier answers still match.

→ `201` with `{ quiz }`.

## One quiz

`GET /quizzes/:id`

- **Owner:** the full quiz with answers (`correct`, `explanation`, `fileId`, `pageStart`).
- **Anyone else** (when `visibility` is `anyone`): ready to take, **without answers or explanations**, shuffled when `randomize` is on, with `hint` when hints are on, plus `ownerName`.
- The owner can add `?play=true` to get the take-it version.

```json
{
  "quiz": { "…": "…" },
  "isOwner": false,
  "attempts": { "used": 0, "allowed": 3, "left": 3 }
}
```

`allowed` is `null` for unlimited retakes. A `private` quiz is `404` for everyone but its owner.

| Action | Request |
|---|---|
| Edit | `PATCH /quizzes/:id` with any of `title`, `difficulty`, `settings` (partial), `questions` (the full list) |
| Delete | `DELETE /quizzes/:id` (deletes its attempts too) |

## Taking a quiz

`POST /quizzes/:id/attempts`

```json
{ "answers": [{ "questionId": "…", "choice": 1 }, { "questionId": "…", "choice": null }], "seconds": 184 }
```

→ `201`:

```json
{
  "attempt": { "id": "…", "correct": 6, "total": 8, "score": 75, "seconds": 184, "createdAt": "…" },
  "showResults": true,
  "results": [
    { "questionId": "…", "choice": 1, "correct": 1, "isCorrect": true, "explanation": "…", "fileId": "…", "pageStart": 5, "pageEnd": 5 }
  ],
  "attemptsLeft": 2
}
```

- `results` is `null` when the owner turned off `showResults` (the owner always sees their own).
- `fileId` and `pageStart` (owner only) let "Review p. 5" open the file at that page.
- `403 NO_ATTEMPTS_LEFT` when retakes are used up, or `403 PLAN_LIMIT` for the daily limit.

`GET /quizzes/:id/attempts` → your attempts at this quiz, newest first.

## Who took your quiz (analytics)

`GET /quizzes/:id/participants` (owner only)

```json
{
  "prompts": ["What happens if…", "…"],
  "participants": [
    {
      "id": "…",
      "name": "Tunde Adeyemi",
      "email": "tunde@gmail.com",
      "correct": 4,
      "total": 8,
      "seconds": 200,
      "attempts": 1,
      "submittedAt": "…",
      "answers": [true, false, true, false, true, false, true, false],
      "latestScore": 50
    }
  ]
}
```

Same shape as the frontend's `Participant`. `correct`, `seconds` and `answers` come from each person's best attempt. Taking a quiz needs an account for now; taking from the link without signing in is coming later.

## Settings

| Field | Default | Values |
|---|---|---|
| `timeLimit` | `null` | 1 to 300 minutes, or `null` for none |
| `retakes` | `null` | 0 to 20 extra attempts, or `null` for unlimited |
| `randomize` | `true` | Shuffle question order each time |
| `showResults` | `true` | Show score and answers after handing in |
| `hints` | `false` | AI quizzes: show a hint on each question |
| `visibility` | `anyone` | `anyone` with the link, or `private` |

## Server note

Quizzes with pictures can be up to 12 MB. If nginx in front of the API has the default `client_max_body_size` (1 MB), raise it for `/api/v1/quizzes`.
