# Library API

Base URL: `https://api.breedx.org/api/v1`

Every route needs `Authorization: Bearer <accessToken>`.

## Plan limits

Limits are for the **whole account**, not per library. A student can put all
their storage in one library or split it however they like.

| Plan | Libraries | Storage (total) | Largest file |
|---|---|---|---|
| Free | 2 | 2 GB | 25 MB |
| Scholar | 10 | 10 GB | 100 MB |
| Elite | Unlimited | 50 GB | 250 MB |

- A file in several libraries counts **once**.
- Deleting a file or library frees its storage straight away.
- The user's plan is on `GET /auth/me` as `user.plan` (`free`, `scholar`, `elite`).

When a limit is hit, the API answers `403` (or `413` for a file that's too big):

```json
{
  "success": false,
  "message": "Your plan allows 2 libraries. Upgrade to create more.",
  "code": "PLAN_LIMIT",
  "limit": "libraries"
}
```

`limit` is one of `libraries`, `storage` or `fileSize`. Show the message and an upgrade button.

## Usage (for the storage bar)

`GET /libraries/usage`

```json
{
  "plan": "free",
  "storage": { "usedBytes": 431800320, "limitBytes": 2147483648, "maxFileBytes": 26214400 },
  "libraries": { "used": 2, "limit": 2 }
}
```

`libraries.limit` is `null` on Elite (unlimited). Disable "New library" when `used >= limit`.

## Libraries

### List

`GET /libraries`

```json
{
  "libraries": [
    {
      "id": "665f…",
      "name": "CSC 201",
      "description": "Data structures",
      "icon": "folder",
      "theme": "lime",
      "fileCount": 4,
      "sizeBytes": 18350080,
      "createdAt": "2026-11-07T10:00:00.000Z",
      "updatedAt": "2026-11-07T10:00:00.000Z"
    }
  ],
  "usage": { "…": "same as GET /libraries/usage" }
}
```

### Create

`POST /libraries`

```json
{ "name": "CSC 201", "description": "Data structures", "icon": "folder", "theme": "lime" }
```

- `name`: required, up to 80 characters.
- `description`: optional, up to 300.
- `icon`: an icon id from the frontend (`folder`, …).
- `theme`: `lime`, `blue`, `peach`, `mint`, `lavender`, `pink`, `lemon`, `coral`, `sky`, `lilac`, `aqua` or `honey`.

→ `201` with `{ library }`, or `403 PLAN_LIMIT` (`limit: "libraries"`).

### One library and its files

`GET /libraries/:id` → `{ library, files }`

```json
{
  "id": "6660…",
  "libraryId": "665f…",
  "name": "CSC201 Lecture 1.pdf",
  "category": "pdfs",
  "size": 3145728,
  "status": "ready",
  "saved": false,
  "savedAt": null,
  "createdAt": "2026-11-07T10:05:00.000Z"
}
```

### Edit

`PATCH /libraries/:id` with any of `name`, `description`, `icon`, `theme`.

### Delete

`DELETE /libraries/:id` deletes the library and its files, and returns the new `usage`.

## Uploading a file (3 steps)

The file goes **straight from the browser to Google Cloud**, not through our server.

**1. Start.** `POST /libraries/:id/uploads`

```json
{ "name": "CSC201 Lecture 1.pdf", "size": 3145728, "contentType": "application/pdf", "category": "pdfs" }
```

| Category | Accepts |
|---|---|
| `pdfs` | pdf |
| `notes` | txt |
| `texts` | pdf, epub, txt, md, doc, docx |
| `slides` | ppt, pptx, key |
| `past-questions` | pdf, doc, docx, txt |

The plan's file-size and storage limits are checked here. → `201`:

```json
{ "file": { "id": "6660…", "status": "uploading", "…": "…" }, "uploadUrl": "https://storage.googleapis.com/upload/…" }
```

**2. Upload.** `PUT` the file to `uploadUrl` (no auth header). Use `XMLHttpRequest` to show progress:

```ts
const xhr = new XMLHttpRequest()
xhr.open("PUT", uploadUrl)
xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream")
xhr.upload.onprogress = (e) => setProgress(e.loaded / e.total)
xhr.onload = () => complete()
xhr.send(file)
```

**3. Finish.** `POST /libraries/:id/files/:fileId/complete`

→ `200` with `{ file, usage }` and `status: "ready"`.

- `409` means the upload hasn't arrived yet. Call it after the PUT finishes.
- If the real file turns out bigger than the plan allows, it's deleted and you get `413 PLAN_LIMIT`.

**Cancel:** `DELETE /libraries/:id/files/:fileId` works during an upload too.
Unfinished uploads are cleared automatically after 24 hours.

No AI work happens on upload. The AI reads a file only when a student first prompts on it.

## Files

| Action | Request | Body |
|---|---|---|
| Rename or change category | `PATCH /libraries/:id/files/:fileId` | `{ "name": "Lecture 1.pdf", "category": "pdfs" }` (keep the extension) |
| Copy to other libraries | `POST /libraries/:id/files/:fileId/copy` | `{ "libraryIds": ["…", "…"] }` (no extra storage) |
| Move to another library | `POST /libraries/:id/files/:fileId/move` | `{ "libraryId": "…" }` |
| Remove | `DELETE /libraries/:id/files/:fileId` | Returns the new `usage` |
| Save | `PUT /libraries/:id/files/:fileId/save` | — |
| Unsave | `DELETE /libraries/:id/files/:fileId/save` | — |
| Open or download | `GET /libraries/:id/files/:fileId/content` | Streams the file. Fetch it with the auth header, then use `URL.createObjectURL(blob)` |

### Saved files

`GET /libraries/saved` → `{ files }`, each with `libraryId` and `libraryName`.

## How storage works (backend notes)

- **Same file, stored once.** After an upload, the file's fingerprint (from Google Cloud) is checked. If anyone already stored the same file, the new copy is dropped and both point to the one stored file.
- **Deleting** removes the stored file only when no library (from any student) uses it anymore.
- **Bucket layout:** `uploads/<userId>/<fileId>` while uploading, `materials/<materialId>` once stored.
