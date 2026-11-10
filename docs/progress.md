# Progress and warm-ups API

Base URL: `https://api.breedx.org/api/v1`

Every route needs `Authorization: Bearer <accessToken>`.

## How it works

Every file's topic map (chapters → topics) becomes a **path**. Students practise **one topic at a time**, and BreedX tracks how well they know each one.

| After a topic quiz | What happens |
|---|---|
| **80% or more** | ✅ Mastered. The next warm-up moves to the next topic. It comes back for review after 7 days, then 21, then 60 |
| **50–79%** | Learning. Moves on, but comes back for a recheck in 3 days |
| **Under 50%** | Learning. The next warm-up repeats it with fresh questions |

- **Quizzes** update mastery for every topic their AI questions came from. A topic needs 3 or more answers in one quiz to change its status; fewer only nudge the number.
- **Flashcard reviews** nudge it: again −6, hard −3, good +2, easy +4.
- Mastered topics show at least 80; topics to retry show under 50.
- Questions written by hand don't belong to a topic, so they don't count.

## Pre-class warm-ups

Warm-ups come **only from the class's course** in its space, never from libraries. An hour before each class, every member gets their own **10 medium questions** from that course's materials:
- **7 questions** on today's topic.
- **3 questions**, one each from related topics: weak or due ones first.

Thirty minutes before the class, the warm-up arrives in place of the plain reminder:

> **CSC 201 in 30 mins ⚡**
> Warm-up: Merge sort · 10 questions, ~7 min
> 4 of 18 topics covered · 10:00 AM in LT1

Tapping it opens `/quizzes?warmup=<id>`.

### The course topic map

A course's materials (slides, textbook, past questions…) are merged into **one list of course topics**. "Merge sort" from the lecture slides and the textbook becomes one topic with both as sources.
- It's built once per course and shared by the whole class.
- It's rebuilt when a material is added or removed, keeping existing topic titles (and so students' progress).

### Which topic, without a scheme of work

1. A weak topic that's due, weakest first ("Let's go over … again" / "Quick recheck: …").
2. A topic not practised yet, from the **newest materials first**, since that's likely what class is on ("Warm-up: …").
3. A mastered topic due for review ("Review: …").

Progress is **coverage**: "7 of 18 topics covered · 4 mastered".

### The questions

- **Written from the course's own materials** by the stronger model, then checked by a second AI pass.
- **They test understanding:** apply, why, predict, spot the error, compare and calculate, with at most about 2 definition questions in 10.
- **The style follows past exam papers** when the course has them.
- **The check rejects** wrong answers, ambiguous wording, questions common sense could answer, and copy-a-sentence questions.
- **Each question carries a quote:** the exact words in the notes that prove the answer. It's checked word for word in code, so a question with a made-up quote is dropped.
- **Built once per topic per material and shared by the class**, then personalised by mastery and by which questions each student has seen.

### Switches

- **Space owner:** the `warmups` space rule (`PATCH /spaces/:slug` with `rules.warmups: false`) turns them off for the whole space.
- **Student, everywhere:** `PATCH /progress/settings` with `{ "warmups": false }`.
- **Student, one course** (electives): `PUT /progress/courses/:spaceId/:courseId` with `{ "warmups": false }`.
- **Class reminders off** for the space means no warm-up either.

Warm-ups are **free**: they don't count toward the daily quiz limits, use no AI energy, and don't appear in "My quizzes".

### Courses

`GET /progress/courses` → `{ warmups, courses }`. Each course:

```json
{
  "spaceId": "…",
  "spaceName": "CSC 300L",
  "spaceSlug": "…",
  "courseId": "…",
  "code": "CSC 201",
  "title": "Data Structures",
  "materials": 2,
  "warmups": true,
  "spaceWarmups": true,
  "coverage": { "total": 18, "covered": 7, "mastered": 4 }
}
```

### Warm-ups

`GET /progress/warmups` returns the 20 most recent; `GET /progress/warmups/:id` returns one:

```json
{ "id": "…", "quizId": "…", "courseId": "…", "courseCode": "CSC 201", "topic": "Merge Sort", "covered": 4, "totalTopics": 18, "reason": "next", "status": "sent", "score": null, "date": "2026-11-11", "createdAt": "…" }
```

Open it with `GET /quizzes/:quizId`, and hand it in with `POST /quizzes/:quizId/attempts`. The hand-in's `topics` show the course topics it moved.

### "See it in your notes"

Every revealed question and hand-in result carries:

```json
{ "pageStart": 3, "pageEnd": 3, "quote": "Merge sort is stable: when two items are equal, the one from the left half is placed first.", "sourceTitle": "Lecture 3-4.pdf", "spaceSlug": "csc-300l-ab12", "spaceMaterialId": "…", "fileId": null }
```

- **Warm-ups:** open the course material with `GET /spaces/:spaceSlug/materials/:spaceMaterialId/content`.
- **Library quizzes:** use `fileId` instead.
- Go to `pageStart` and highlight `quote`.

## Topic mastery

`GET /progress` (or `?libraryId=…`) → `{ libraries: [{ id, name, files }], weakest }`.

Each file is `{ fileId, name, status, mastered, topics }`, and each topic is:

```json
{
  "key": "c0t0",
  "title": "Recursion Basics",
  "chapter": "Chapter 1: Recursion",
  "pageStart": 1,
  "pageEnd": 1,
  "mastery": 80,
  "status": "mastered",
  "lastScore": 100,
  "lastPracticedAt": "…",
  "due": false
}
```

- A file with `status` `stored` hasn't been read by the AI yet, so `topics` is empty.
- `mastery` is `null` for topics not practised yet.
- `weakest` lists up to 5 topics being learnt, weakest first, each `{ fileId, libraryId, fileName, key, title, chapter, mastery, lastScore }`.

Every quiz hand-in (`POST /quizzes/:id/attempts`) now also returns `topics`:

```json
"topics": [{ "topicKey": "c0t0", "topicTitle": "Recursion Basics", "material": "…", "score": 100, "mastery": 80, "status": "mastered" }]
```

## Quiz by topic

`POST /quizzes/generate` also takes `topics` (keys from `GET /progress`):

```json
{ "topics": [{ "fileId": "…", "topicKey": "c1t1" }], "count": 10, "difficulty": "medium" }
```

The questions are shared evenly between the chosen topics (up to 30), and `fileIds` and `libraryIds` aren't needed. This counts toward the daily quiz limit like any quiz.
