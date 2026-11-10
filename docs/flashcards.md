# Flashcards API

Base URL: `https://api.breedx.org/api/v1/flashcards`

Every route needs `Authorization: Bearer <accessToken>`.

## Card

Matches the frontend's `StudyFlashcard`, plus a few fields:

```json
{
  "id": "…",
  "front": "What happens if a recursive function lacks a base case?",
  "a1": "It runs instantly with no memory use",
  "a2": "It overflows the stack from endless self-calls",
  "correct": 2,
  "answer": "Without a base case the function keeps calling itself until the program runs out of stack memory…",
  "difficulty": "medium",
  "tag": "lime",
  "fileId": "6660…",
  "pageStart": 1,
  "pageEnd": 1,
  "dueAt": "2026-11-09T20:54:10.657Z",
  "reviews": 1
}
```

- `a1` and `a2` are two possible answers; `correct` (1 or 2) says which is right.
- `answer` is the full explanation for the back of the card.
- `fileId` and `pageStart` let "See in notes" open the file at that page (AI cards only).

## Make cards with AI (stream)

`POST /flashcards/generate`

```json
{ "fileIds": ["6660…"], "count": 15, "difficulty": "medium", "tag": "navy", "focus": "time complexity", "title": "CSC 201 cards" }
```

- `fileIds` or `libraryIds`: at least one.
- `count`: 1 to 99. `difficulty`: `easy`, `medium` or `hard`. `tag`: `navy`, `lime`, `blue` or `white`.
- `focus` (optional, up to 300 characters): what to focus on, from the editor's prompt box.

Streams `step` events (`reading`, `creating`, `reviewing`), then `result` with `{ deck }` (cards included).

Cards come from a **shared bank** per file and topic, spread across the whole file, and checked against the notes. Costs **no AI energy** and has no daily limit.

## Decks

| Action | Request | Notes |
|---|---|---|
| List | `GET /flashcards` | `{ decks }` with `cardCount` and `dueCount` |
| Open | `GET /flashcards/:id` | `{ deck }` with `cards`. `?due=true` returns only cards due now |
| Create by hand | `POST /flashcards` | `{ "title": "…", "cards": [{ "front": "…", "a1": "…", "a2": "…", "correct": 1, "answer": "…" }] }` |
| Rename | `PATCH /flashcards/:id` | `{ "title": "…" }` |
| Delete | `DELETE /flashcards/:id` | |
| Add a card | `POST /flashcards/:id/cards` | Card fields |
| Edit a card | `PATCH /flashcards/:id/cards/:cardId` | Any of `front`, `a1`, `a2`, `correct`, `answer`, `difficulty`, `tag` |
| Remove a card | `DELETE /flashcards/:id/cards/:cardId` | |

## Spaced repetition

After each card, send how it went:

`POST /flashcards/:id/cards/:cardId/review` with `{ "rating": "good" }`

| Rating | Next time |
|---|---|
| `again` | In 10 minutes |
| `hard` | A little later than last time |
| `good` | 1 day, then 3, then growing |
| `easy` | Much later |

→ `{ card, dueCount }`. Show "5 cards due" from `dueCount` on the deck, and study with `?due=true`.
