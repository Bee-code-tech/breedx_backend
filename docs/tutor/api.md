# Tutor API

Base URL: `https://api.breedx.org/api/v1/tutor`. Every route needs `Authorization: Bearer <accessToken>`.

A live, one-on-one tutor that teaches one topic of a file (or of a space course) with voice, a board and notes, and checks real understanding before moving on. Prompts live in `docs/tutor/` and are loaded by the server, so editing them changes the tutor.

## Flow

1. `GET /topics?fileId=…` (library file) or `?spaceId=…&courseId=…` (space course) → `{ topics: [{ key, title, … }] }`
2. `POST /sessions` with `{ fileId, topicKey }` or `{ spaceId, courseId, topicKey }`, optional `voice: "warm" | "calm"` → `201 { session, allowance }`, or `403 PLAN_LIMIT`
3. `POST /sessions/:id/events` with `{ "type": "start" }` → a **stream** of the first beat. The first time a topic is taught, `step` events ("Preparing your tutor…") come first, for about 30–60 s.
4. Play the beat. Then send **one** event:
   - `{ "type": "beat_done" }` when the beat finished playing and it didn't ask anything (`beat_end.waiting === "beat_done"`)
   - `{ "type": "answer", "text": "…" }` (or `"choice": 1` for multiple choice) when it asked (`waiting === "answer"`)
   - `{ "type": "speak", "text": "…" }` when the student says something on their own
   - `{ "type": "interrupt", "text": "…", "beat": 7, "clip": 1 }` to cut the tutor off: stop the audio and send which sentence was playing (`clip`, the index in the last `say` op's `clips`, 0 = first). A beat still being written is cancelled. The tutor answers, then picks up from the cut-off sentence without repeating what was heard
5. Repeat until an `ended` event. `POST /sessions/:id/end` ends it early.

Every event can also carry **`boardFill`** (0 to 1): how full the board really is on screen, measured by the layout engine. The server then uses it instead of its own estimate, so the tutor's `space_left` matches what the student sees. Send it with every event.

**No gaps between explanation beats:** when `beat_end.waiting` is `beat_done`, send `beat_done` as soon as that beat's stream ends, without waiting for its audio, and queue the returned ops to play after the current clips. The next beat is usually already prepared on the server, so it arrives while the current one is still playing. Every `say` op and `beat_end` carries the beat's id (`beat`). When the student interrupts, send `beat` (the beat whose audio was playing) with `clip`, so the tutor knows they never heard the queued beat.

Send one event at a time. Anything but `interrupt` while a beat is running gets `error { code: "BUSY" }`.

## Stream events

| Event | Data |
|---|---|
| `step` | `{ id, text, status }` while preparing |
| `grade` | `{ grade: pass\|partial\|fail\|not_an_answer, level }` for the last answer |
| `op` | One board or voice action, in the order to play them (below) |
| `beat_end` | `{ waiting: "answer"\|"beat_done", stage, goal: { index, total, title }, board: { page, space_left }, minutes_left }` |
| `ended` | `{ reason: complete\|time\|student, notes, summary }` |
| `error` | `{ message, code? }`. `code: "BUSY"` means try again shortly |

### Ops

| `op` | Fields | What the app does |
|---|---|---|
| `say` | `beat`, `text`, `audio`, `clips: [{ text, audio }]` | Play each clip in order with `GET /audio/:audio` (MP3), one per sentence. A clip with `audio: null` (the month's free voice is used up) is spoken with the device voice. Show `text` as subtitles straight away |
| `draw` | `elements[]`: `{ id, kind, role, text?, target?, from?, to?, latex?, smiles?, mermaid?, graph?, circuit?, chart?, asset_id?, zone?, on_word? }` | Draw them, starting each when the voice reaches `on_word` |
| `highlight` | `ids`, `on_word?` | Pulse those elements |
| `fade` | `ids` | Fade to 30% |
| `remove` | `ids` | Clear faded elements to make room |
| `new_board` | `page`, `title`, `keep` | Wipe with the eraser animation, save the old board as a thumbnail, carry `keep` ids into a recap corner. `title` is the tutor's, or the current goal's when the app flipped the board because it was full |
| `board_title` | `page`, `title` | Name the current board (sent instead of `new_board` when the board is already empty) |
| `note` | `text`, `kind: note\|student_term\|caution` | Add to the notes panel |
| `ask` | `level`, `question`, `options?` | Show the question (with buttons for `options`) and listen |
| `stage` | `stage`, `goal` | Moved to the next goal, or to `wrap_up` |

**Kinds** are `asset`, `label`, `arrow`, `focus_ring`, `student_tag`, `careful`, `key_point`, `equation` (LaTeX), `molecule` (SMILES), `flowchart` (Mermaid), `graph` (`{ functions, x, y, x_label, y_label }`), `circuit` (netlist text) and `chart` (Vega-Lite).

**Roles → colours:** `structure` chalk, `term` sky, `flow` amber, `student` lime, `caution` coral.

## The tutor's voice

The voice is Gemini's own speech (NotebookLM-style): male (Charon, the default) or female (Kore), speaking English **with the student's own country's accent** by default (their profile country: Nigerian for NG, Ghanaian for GH, and so on).

| Route | What it does |
|---|---|
| `GET /voices` | `{ default: { voice, accent }, voices: [{ id, label }], accents: [{ code, label }] }`. The student's country comes first; `NEUTRAL` is a neutral accent |
| `POST /voices/preview` with `{ voice?, accent? }` | `{ audio, text, voice, accent }`. Play `audio` like any clip, so they can hear it before choosing |
| `POST /sessions` with `voice: "male"\|"female"`, `accent: "GH"\|"NEUTRAL"` | Both optional: leave them out for the defaults. Sessions return `voice` and `accent` |

Clips: `GET /audio/:id` returns the whole file (WAV for this voice), waiting while it's made. **`GET /audio/:id?stream=pcm`** passes raw audio on as it's generated (16-bit signed little-endian, mono, 24 kHz), so playback can start about a second in. Play it with the Web Audio API. A 415 means the clip has no raw audio: fetch it whole instead.

Right after the student speaks, an `op: "react"` (`{ text, audio }`) brings a short instant reaction in the same voice ("Hmm, interesting…"). Play it at once; the reply's first clip cuts it off.

## Other routes

| Route | Returns |
|---|---|
| `GET /allowance` | `{ plan, sessions: null, used, left: null\|0, period: "energy", minutes, resetsAt, energy: { balance, percent, low, empty, fullAt } }`. `left` is 0 only when energy is empty, and `resetsAt` is then when it's full again. The 403 `AI_ENERGY_EMPTY` error carries the same `allowance` |
| `GET /sessions` | History (started sessions, newest first) |
| `GET /sessions/:id` | `{ session, guideStatus, goals }`. `guideStatus` is `ready` (Start begins teaching at once) or `building` (the tutor is preparing; it starts as soon as the session is created). Also the board now, finished `boards` (page, title, elements, `endedAt` in ms) for the thumbnail strip, notes, progress, the pending question |
| `GET /sessions/:id/replay` | `{ session, duration, events: [{ seq, at, type, data }] }`. `at` is ms from the start. `beat` events hold the ops in order, `student` and `grade` events the answers. Play them back on the same board to show the session like a video |
| `GET /audio/:clipId` | MP3 of one spoken line |
| `GET /profile` · `DELETE /profile` | What the tutor remembers (the student's own terms, misconceptions, interests), and forgetting it |

## Rules the server enforces

- **Moving on:** the next goal only after passes at **recall**, **explain back**, and **apply** or **spot the error**, graded by the listener (Claude Haiku), not by the tutor.
- **Reteach:** 2 misses at the same level switch the tutor to `reteach` with a different explanation style.
- **Beat limits:** at most 5 drawings a beat, `say` up to 400 characters, notes up to 120, and `ask` is always last.
- **The board:**
  - It has a fixed space budget, reported to the tutor as `space_left`.
  - A drawing that doesn't fit first clears faded marks, then flips to a new board.
  - Boards only flip between beats.
- **Time:**
  - Wrap-up starts 2 minutes before the plan's limit (15 minutes, or 30 on Elite).
  - There are 2 extra minutes of grace, then the session ends.
  - There's a hard token ceiling per session.
- **AI energy, not session counts:** students can start as many sessions as their AI energy allows. Each beat is charged (about 1,800 energy, roughly 70,000 for a 15-minute session; tune with `TUTOR_ENERGY_SCALE`, default 0.3). Out of energy: `POST /sessions` and `start` answer 403 `AI_ENERGY_EMPTY`, and a running session wraps up gracefully. A session lasts up to the plan's minutes (15, or 30 on Elite).
- **The teacher guide** is built once per topic and its sources, shared by everyone, with every fact's quote checked word for word against the notes.
- **Grading runs alongside the tutor's reply.** The tutor gets the grader's verdict on its next turn, and moving to the next goal always waits for it.

## Switching the AI (env only, no code changes)

| Setting | Values |
|---|---|
| `TUTOR_PROVIDER` | `gemini` (default: Gemini on Vertex, paid by Google Cloud credits) or `claude` |
| `ANTHROPIC_API_KEY` | With `claude`: set it to use Anthropic directly; leave it out to use Claude on Vertex AI (needs Model Garden quota) |
| `TUTOR_BEAT_MODEL` | Live beats. Defaults: `gemini-3.5-flash` / `claude-sonnet-5-5` |
| `TUTOR_RETEACH_MODEL` | Beats after 2 misses. Defaults: `gemini-3.5-flash` (with more thinking) / `claude-sonnet-5-5` |
| `TUTOR_GUIDE_MODEL` | Teacher guides. Defaults: `gemini-3.1-pro-preview` / `claude-opus-5-5` |
| `TUTOR_LISTENER_MODEL` | Grading. Defaults: `gemini-3.5-flash-lite` / `claude-haiku-5-5` |
| `TUTOR_VOICE` | `hd` (default: Chirp 3 HD, most human, ~2 s a sentence) or `fast` (WaveNet first, ~1 s) |
| `TUTOR_DEBUG` | `1` logs how long each step of a beat takes |

A session keeps the AI it started with, so changing these never breaks a session in progress. Busy errors from either AI are retried automatically, 3 times.
- **Voice:** Google Chirp 3 HD, then WaveNet, within the free monthly allowance, then the device voice. Kokoro will be added for more volume.
