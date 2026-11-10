# AI API

Base URL: `https://api.breedx.org/api/v1/ai`

Every route needs `Authorization: Bearer <accessToken>`.

## Models

Students pick a BreedX model by name. Never show the real model behind it.

| Model | Tagline | Free | Scholar | Elite | Energy rate |
|---|---|---|---|---|---|
| **Vega** | Fastest for quick answers | ✅ | ✅ | ✅ | 1× |
| **Lyra** | Best for everyday studying | 5 a day | ✅ | ✅ | 3× |
| **Orion** | For complex maths & reasoning | 🔒 | ✅ | ✅ | 10× |
| **Polaris** | Thinks deeply. For your toughest questions | 🔒 | 🔒 | ✅ | 20× |

`GET /ai/models`

```json
{
  "defaultModel": "vega",
  "models": [
    {
      "id": "lyra",
      "name": "Lyra",
      "tagline": "Best for everyday studying",
      "tier": 2,
      "energyRate": 3,
      "available": true,
      "requiresPlan": null,
      "dailyLimit": 5,
      "dailyLeft": 3,
      "default": false
    }
  ]
}
```

- `available: false`: show a lock and an upgrade badge for `requiresPlan` (`scholar` or `elite`).
- `dailyLeft`: show "3 left today" when it isn't `null`.

## Energy (the AI usage bar)

AI use comes from a **tank that refills a little every moment**. Students can save up for a heavy study night, and an empty tank means a few hours' wait, never a month.

| Plan | Tank | Refills per day | About per month |
|---|---|---|---|
| Free | 30k | 10k | 300k |
| Scholar | 150k | 50k | 1.5M |
| Elite | 400k | 135k | 4M |

Stronger models drain it faster (the energy rate above). Find, file reading, and quizzes or flashcards from the bank are free.

`GET /ai/usage`

```json
{
  "plan": "free",
  "balance": 21400,
  "tank": 30000,
  "percent": 71,
  "refillPerDay": 10000,
  "reserve": 0,
  "low": false,
  "empty": false,
  "fullAt": "2026-11-09T04:12:00.000Z"
}
```

- Show `percent` as a bar, and "Full in 6 hrs" from `fullAt`. Don't show token numbers to students.
- `low` is true at 10% or less: show "Low energy".
- `reserve` is bought top-ups. They're used only when the tank is empty.

When a student can't use AI right now, the request answers `403`:

```json
{ "success": false, "code": "AI_ENERGY_EMPTY", "message": "Your AI energy is recharging…", "readyAt": "…", "fullAt": "…" }
```

| `code` | Meaning | Show |
|---|---|---|
| `AI_ENERGY_EMPTY` | Tank empty | "Ready again at `readyAt`", plus a top-up button |
| `MODEL_DAILY_LIMIT` | Used up the daily Lyra uses | Switch to Vega; `resetsAt` |
| `MODEL_LOCKED` | Model not on this plan | Upgrade to `requiresPlan` |

## Streams: how the AI shows its thinking

AI routes answer with **Server-Sent Events**: one response that sends events as work happens. The browser's `EventSource` can't send our auth header, so read it with `fetch`:

```ts
const res = await fetch(`${API}/ai/find`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: "where is recursion explained?" }),
  signal: controller.signal, // controller.abort() stops the AI when the student leaves
})
if (!res.ok) return handleError(await res.json()) // 400, 403… arrive as normal JSON

const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
let buffer = ""
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += value
  const events = buffer.split("\n\n")
  buffer = events.pop()!
  for (const raw of events) {
    const event = raw.match(/^event: (.+)$/m)?.[1]
    const data = raw.match(/^data: (.+)$/m)?.[1]
    if (event && data) onEvent(event, JSON.parse(data))
  }
}
```

| Event | Data | What to do |
|---|---|---|
| `step` | `{ id, text, status }` | A thought line. **Same `id` = update that line** (e.g. progress %). `status` is `active`, `done` or `skipped` |
| `result` | Depends on the route | Show the answer |
| `error` | `{ message }` | Show the message. The stream ends after it |

Lines starting with `:` are keep-alive pings; the parser above skips them.

## Find

Searches the student's files **by meaning**, not exact words. Free.

`POST /ai/find`

```json
{ "query": "where is recursion explained?", "libraryIds": ["…"], "fileIds": ["…"], "limit": 8 }
```

- `query`: 2 to 500 characters. Required.
- `libraryIds`, `fileIds`: optional, to search only some libraries or files. Leave both out to search everything.
- `limit`: 1 to 20, default 8.

Steps the student sees:

```
✓ Looking through 4 files in 2 libraries…
⟳ Reading CSC201 Notes.pdf for the first time…   ← only for files never read before
⟳ Indexing CSC201 Notes.pdf (64%)…
✓ Read CSC201 Notes.pdf (142 pages)
✓ Found 6 matches
```

`result`:

```json
{
  "results": [
    {
      "fileId": "6660…",
      "fileName": "CSC201 Notes.pdf",
      "libraryId": "665f…",
      "libraryName": "CSC 201",
      "pageStart": 34,
      "pageEnd": 35,
      "unit": "page",
      "chapter": "Chapter 3: Functions",
      "topic": "Recursion",
      "text": "A recursive function is one that calls itself…",
      "score": 0.83
    }
  ]
}
```

- Show as "p. 34" (`unit` can also be `slide` or `section`), and open the file at that page.
- An empty `results` can come with a `message` (e.g. no files yet).

## Ask: chats with your notes

Chats are saved like ChatGPT's sidebar. Each chat covers **chosen files**, or **chosen libraries**, or **everything** when neither is set.

### Chats

| Action | Request | Body / query |
|---|---|---|
| List (newest first) | `GET /ai/sessions` | `?before=<lastMessageAt>` for the next page. Returns `{ sessions, hasMore }` |
| New chat | `POST /ai/sessions` | `{ "libraryIds": ["…"], "fileIds": ["…"], "model": "lyra" }`, all optional |
| Open | `GET /ai/sessions/:id` | Returns `{ session, messages, hasMore }`, the newest 50, oldest first. `?before=<messageId>` loads older ones |
| Rename, change files or model | `PATCH /ai/sessions/:id` | Any of `title`, `libraryIds`, `fileIds`, `model` |
| Delete | `DELETE /ai/sessions/:id` | Deletes its messages too |

Session:

```json
{
  "id": "6af0…",
  "mode": "ask",
  "title": "Understanding the Base Case in Recursion",
  "libraryIds": ["665f…"],
  "fileIds": [],
  "model": "lyra",
  "messageCount": 8,
  "lastMessageAt": "…",
  "createdAt": "…"
}
```

The title starts as "New chat"; the AI names it after the first answer (see the `title` event).

### Ask a question (stream)

`POST /ai/sessions/:id/ask`

```json
{ "question": "and how does merge sort use it?", "model": "lyra" }
```

- `question`: 1 to 4,000 characters.
- `model`: optional. Defaults to the chat's last model, then the plan's default. It's remembered for the chat.
- Before the stream starts, you can get `403` with `MODEL_LOCKED`, `MODEL_DAILY_LIMIT` or `AI_ENERGY_EMPTY` (see Energy), or `409` if the chat is still answering.

Events, in order:

| Event | Data | What to do |
|---|---|---|
| `message` | `{ userMessageId }` | The question was saved |
| `step` | `{ id, text, status }` | Thought lines (same `id` = update the line) |
| `sources` | `{ sources: [Citation] }` | The passages found. Keep them to turn `[n]` in the answer into chips |
| `token` | `{ text }` | The next piece of the answer. Append it and render as Markdown (with LaTeX `$…$`) |
| `done` | `{ messageId, status, cited, grounding, energy }` | Finished. Update the energy bar from `energy` (`percent`, `low`, `empty`, `fullAt`) |
| `title` | `{ title }` | First answer only: the chat's new name |
| `error` | `{ message }` | Something failed; the stream ends |

What the student sees:

```
✓ Read your question
✓ Found 4 sections (p. 31–38)
⟳ Writing with Lyra…
  "Merge sort uses its base case, a list of length 0 or 1, to stop the recursion [1]…"
✓ Done
```

Citation (in `sources`):

```json
{
  "n": 1,
  "fileId": "6660…",
  "fileName": "CSC201 Notes.pdf",
  "libraryId": "665f…",
  "pageStart": 5,
  "pageEnd": 5,
  "unit": "page",
  "chapter": "Chapter 2: Sorting",
  "topic": "Merge Sort",
  "text": "Merge sort splits the list in half…"
}
```

- **`[1]` in the answer** = the source with `n: 1`. Show a chip like "p. 5". Tapping it opens the file at that page; long-press can preview `text`.
- **`cited`**: the numbers the answer actually used. Show only those under the answer.
- **`grounding`**: `notes` (from their files), `mixed`, or `general`. For `mixed` and `general` the answer has a "**From general knowledge:**" part; you can badge it.

**Stop button:** abort the fetch (`controller.abort()`). The AI stops, the partial answer is saved with `status: "stopped"`, and the student pays only for what was written.

### Messages

```json
{
  "id": "6af0…",
  "role": "assistant",
  "content": "A **base case** is…[2]",
  "sources": [],
  "cited": [1, 2],
  "steps": [{ "id": "search", "text": "Found 6 sections (p. 1–6)", "status": "done" }],
  "grounding": "notes",
  "status": "complete",
  "model": "lyra",
  "feedback": { "rating": "up", "comment": "" },
  "createdAt": "…"
}
```

`status` is `complete`, `stopped` or `failed`. `steps` let you show the collapsed thought lines on old answers.

### Feedback

`POST /ai/messages/:id/feedback` with `{ "rating": "up" }`, `{ "rating": "down", "comment": "Wrong page" }`, or `{ "rating": null }` to clear it.

### How Ask works (backend notes)

- **Follow-ups** ("and how does merge sort use it?") are rewritten into a full question before searching, so the right pages are found.
- **Long chats stay cheap:** the last ~10 messages are sent in full, and older ones are folded into a short summary.
- **Charged:** the answer only (tokens × the model's rate). Searching, rewriting, titles and summaries are free for the student but logged in `aiusages`.
- **Low energy:** the first time the tank drops to 10%, a push notification is sent ("Your AI energy is low ⚡").
- **Answers** cite pages, say "Your notes don't cover this" before using general knowledge, and never name the real AI behind the model.

## Simplify, Explain, Summarize, Example

The Study screen's chips. Streamed like Ask, and **costs energy** (tokens × the model's rate).

`POST /ai/simplify`

```json
{ "action": "simplify", "level": "simple", "text": "The selected passage…", "model": "vega" }
```

or, for pages of a file:

```json
{ "action": "summarize", "fileId": "6660…", "pageStart": 12, "pageEnd": 14 }
```

| Field | Values |
|---|---|
| `action` | `simplify` (default), `explain`, `summarize`, `example` |
| `level` | `simplify` only: `simple` (default, with an everyday analogy), `standard`, `exam` (bullet notes an examiner wants) |
| `text` | Up to 8,000 characters, **or** `fileId` with `pageStart`/`pageEnd` (up to 10 pages) |
| `model` | Optional; defaults to the plan's default model |

Events: `step`, then `token` pieces (Markdown with LaTeX), then `done` with `{ status, energy }`. Errors before the stream are the same `403` codes as Ask. Abort the fetch to stop.

Quizzes and flashcards have their own docs: [quizzes.md](quizzes.md), [flashcards.md](flashcards.md).

## A file's AI status and topic map

`GET /ai/files/:fileId`

```json
{
  "status": "ready",
  "pageCount": 142,
  "unit": "page",
  "map": {
    "chapters": [
      {
        "title": "Chapter 3: Functions",
        "startPage": 30,
        "endPage": 48,
        "topics": [
          { "title": "Recursion", "startPage": 34, "endPage": 39, "concepts": ["base case", "call stack"] }
        ]
      }
    ]
  },
  "error": null
}
```

`status`: `stored` (not read yet), `processing`, `ready` or `failed`. When `failed`, `error` is:

| `error` | Meaning |
|---|---|
| `UNSUPPORTED` | File type not supported yet (old .doc/.ppt, Keynote, EPUB) |
| `EMPTY` | No text found |
| `FAILED` | Something went wrong; it's retried next time |

## Read a file ahead of time

`POST /ai/files/:fileId/prepare` streams the same reading steps as Find, then `result` with the same shape as `GET /ai/files/:fileId`.

Call it when a student opens a file, so their first question is instant. It's free, and a file already read finishes at once.

## How it works (backend notes)

- **Nothing happens on upload.** A file is read the first time a student uses it with the AI.
- **Read once, shared.** The same file uploaded by 300 students is read once.
- **Reading:** text PDFs, Word (.docx), PowerPoint (.pptx) and text files are read for free. Scanned PDF pages are read by the AI (up to 400 pages per file).
- **Topic map:** the AI builds chapters → topics → key concepts from the pages and the PDF's bookmarks.
- **Chunks:** about a page each, tagged with their chapter, topic and pages, then embedded for searching by meaning. Stored in `materialchunks`, searched with the Atlas index `chunk_vector` (create it with `npm run ai:indexes`).
- **Deleting** the last copy of a file also deletes its chunks.
- **Usage ledger:** every AI call is saved in `aiusages` with its real tokens, so we can see costs by feature and student.


## Space course materials

Ask, Find and Simplify also work on a space's course materials, for members of that space. Each request costs energy in the usual way.

| Route | What to send |
|---|---|
| `POST /ai/find` | `spaceId`, plus optional `courseIds` or `spaceMaterialIds` to narrow it. Send `libraryIds` or `fileIds` too to search both |
| `POST /ai/sessions` and `PATCH /ai/sessions/:id` | `spaceId`, plus optional `courseIds` or `spaceMaterialIds`. `spaceId: null` takes the space off a chat |
| `POST /ai/simplify` | `spaceId` and `spaceMaterialId` (with `pageStart` and `pageEnd`) instead of `fileId` |

Find results and Ask citations from course materials carry `spaceSlug` and `spaceMaterialId`; `libraryId` and `libraryName` hold the space's id and name. To open one at its page:

`/ai/study?file=<spaceMaterialId>&from=/classes/<spaceSlug>&page=<pageStart>&quote=<a short piece of the text>`

Sessions return `spaceId`, `courseIds` and `spaceMaterialIds`. A space you're not a member of is ignored.


## Read aloud (human voice)

`POST /ai/speech` with `{ "text": "…", "voice": "warm" }` (`warm` or `calm`; British English).

| Answer | Meaning | What the app does |
|---|---|---|
| `200`, `Content-Type: audio/mpeg` | A human-voice clip. Headers: `X-Voice-Tier` (`hd` is the most human, else `wavenet`), `X-Voice-Cached` | Play it |
| `200` JSON `{ "useDeviceVoice": true, "reason": "daily" \| "monthly" }` | Today's or this month's free allowance is used | Read it with the phone's own voice (the browser's speech) |

How it works:
- **Free for us:** human voices stop just short of Google's free monthly allowance (Chirp 3 HD first, then WaveNet), then everyone falls back to the phone's voice until the 1st. The limits are the `SPEECH_HD_MONTHLY` and `SPEECH_WAVENET_MONTHLY` env values.
- **Free for students:** no AI energy is used. Each plan has a daily allowance of human-voice characters: Free about 3 answers, Scholar about 30, Elite about 75.
- **Cached:** a clip made once (by anyone) replays free and doesn't count toward the allowances.
- **Cleaned for speaking:** Markdown, `[1]` citations and LaTeX are removed, and O(n) is read as "O of n". Send the text as shown.
- **Fast start:** send long answers in pieces (the first sentence on its own, then the rest, up to 3,000 characters each) and play them back to back.

Admins: `GET /ai/speech/usage` → this month's used and cap per tier.
