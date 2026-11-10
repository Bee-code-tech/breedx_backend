# Home API

Base URL: `https://api.breedx.org/api/v1`

Every route needs `Authorization: Bearer <accessToken>`.

## Home

`GET /home?tz=Africa/Lagos`

Everything on Home except the schedule (that's `GET /schedule/home`). Send the browser's timezone as `tz`; it's saved, so streak days and "this week" follow the student's own time (Africa/Lagos until one is sent).

```json
{
  "timezone": "Africa/Lagos",
  "streak": {
    "current": 4,
    "best": 9,
    "activeToday": true,
    "week": [
      { "day": "2026-11-09", "active": true, "future": false },
      { "day": "2026-11-10", "active": false, "future": true }
    ]
  },
  "cgpa": { "value": 4.67, "scale": "5.0", "change": 0.17, "semesters": 2 },
  "quizzes": { "count": 2, "lastWeek": 5, "averageScore": 70 },
  "continueStudying": [
    {
      "fileId": "6af1…",
      "libraryId": "6af0…",
      "name": "CSC201 Notes.pdf",
      "libraryName": "CSC 201",
      "page": 12,
      "pageCount": 142,
      "percent": 28,
      "minutesLeft": 204,
      "lastOpenedAt": "2026-11-09T02:55:01.816Z"
    }
  ]
}
```

| Card | Field | Notes |
|---|---|---|
| Current streak | `streak` | Days in a row with any studying. Not studying yet today doesn't break it; missing a whole day does. `week` is Monday to Sunday, for dots |
| Your CGPA | `cgpa` | From the CGPA calculator. `value` is `null` until a semester has grades. `change` is how much the latest semester moved it (`null` with fewer than two) |
| Quiz this week | `quizzes` | Attempts from Monday to now. `averageScore` is `null` with none |
| Continue studying | `continueStudying` | Up to 6 files, most recent first. Finished files drop off. `pageCount` and `minutesLeft` are `null` until the length is known. Progress uses the furthest page reached |

**What counts as a study day:** reading a library file, asking the AI (Ask, Simplify and the other study chips), handing in a quiz, or reviewing a flashcard.

## Saving where a student is in a file

`PUT /libraries/:id/files/:fileId/progress`

```json
{ "page": 12, "pageCount": 142 }
```

- Call it when the page changes; waiting until the student settles on a page (about 2 seconds) is plenty.
- `pageCount` is optional. Send it from the viewer; it's needed for files the AI hasn't read yet.
- Counts as a study day.

→ `{ page, pageCount, furthestPage }`

To reopen a file where they stopped, use `page` from `continueStudying` (the app links to `/ai/study?file=…&from=/library/…&page=12`).
