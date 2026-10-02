# Home Server sync

Mithium Sound stays a local soundboard. Discord playback, local-device playback, global hotkeys, and the clip grid always read the library on this PC (`%APPDATA%\mithium-sound\`).

Home Server syncs that library with the lab service [mithium-sound-library](https://github.com/mithium/mithium-sound-library). It is not the in-app LAN Web Remote. The remote still serves a phone page from this PC while the PC is on.

If the server is off, unreachable, or not configured, the app does not block playback. Status shows **Offline** (or **Disabled** when the toggle is off). Edits made on this PC stay queued in the local database until the next successful sync.

## Where to point the Windows app

| Client | Base URL |
| --- | --- |
| This Windows app, on the LAN | `http://192.168.0.211:4092` |
| Phone PWA, over Tailscale | `http://100.73.61.67:4092` |

Settings → **Home Server** (separate from **LAN Web Remote Control**):

| Field | Purpose |
| --- | --- |
| Enable Home Server sync | Off means no network calls. |
| Base URL | `http://192.168.0.211:4092` for this PC. |
| Auth token | The library API key. Not the Discord bot token. |
| Connection | **Connected**, **Offline**, or **Error** |
| Sync now | Pulls, then pushes queued local edits |

The URL and token are stored in `%APPDATA%\mithium-sound\settings.json` with the other secrets (`homeServerUrl`, `homeServerToken`, `homeServerEnabled`). The sync cursor is `serverRevision` in `homeserver-state.json`.

Auth headers (the lab uses the bearer token when both are present):

```
Authorization: Bearer <API_KEY>
X-Api-Key: <API_KEY>
```

The Discord bot token is never placed on this wire. The client also refuses to send `createdAt` or `updatedAt`. The server assigns those. If the Home Server token is the same string as the bot token, sync refuses before opening a connection.

YouTube URL, source type, per-clip volume, hotkey, and the on-screen clip order stay on this PC. They are not library fields.

## Sync rule

Identity is the clip or group UUID, not the local SQLite row id.

1. The first sync calls `GET /api/library` and stores `revision`. That snapshot has no tombstones. Clips that exist only on this PC are kept and uploaded.
2. Later syncs call `GET /api/sync?sinceRevision=<stored revision>`. Upserts and deletes are applied in `revision` order. The higher revision wins, including over an edit made offline on this PC.
3. A row missing from the full library is not a delete. Deletes arrive as tombstones on `GET /api/sync`. The server keeps the latest 5000 tombstones. If that list is full, or the server revision moves backwards, the client reconciles from `GET /api/library` and drops clean rows it had already synced that the server no longer has. Dirty local edits and never-uploaded clips stay.
4. Audio is downloaded from `GET /api/clips/:id/audio` when the local SHA-256 does not match `hash`.
5. Local edits push with `POST /api/groups`, `PATCH /api/groups/:id`, `POST /api/clips` (multipart file), `PATCH /api/clips/:id`, `PUT /api/clips/:id/audio` (multipart file), and `DELETE` (`204`). A group delete is sent only after its clips have moved, because the server returns `409` while a group still has clips.

`hash` in the lab API is stored locally as the clip content hash. `trimStartMs` / `trimEndMs` are milliseconds (`trimEndMs` exclusive). Group `sortOrder` is the local group position.

## HTTP contract

Authoritative detail is `API.md` in `mithium/mithium-sound-library`. This client implements that shape.

### `GET /api/health`

```json
{ "ok": true, "version": "0.1.0" }
```

Connection failure is **Offline**. HTTP 401 is **Error**.

### `GET /api/library`

Full snapshot of live groups and clips. No tombstones. `revision` is the next sync cursor.

```json
{
  "version": "0.1.0",
  "schemaVersion": 1,
  "revision": 9,
  "updatedAt": "2026-10-02T19:45:01.456Z",
  "hashAlgorithm": "sha256",
  "groups": [],
  "clips": []
}
```

Group: `id`, `name`, `sortOrder`, `createdAt`, `updatedAt`, `revision`.

Clip: `id`, `name`, `groupId`, `durationMs`, `trimStartMs`, `trimEndMs`, `createdAt`, `updatedAt`, `audioPath`, `hash`, `mimeType`, `sizeBytes`, `revision`.

### `GET /api/sync?sinceRevision=<integer>`

Changes with `revision` greater than the cursor. `since=` (ISO time) exists on the server and is not used by this app.

```json
{
  "mode": "incremental",
  "sinceRevision": 8,
  "serverRevision": 9,
  "hashAlgorithm": "sha256",
  "groups": { "upserted": [], "deleted": [] },
  "clips": {
    "upserted": [],
    "deleted": [{ "id": "...", "revision": 9, "deletedAt": "2026-10-02T19:45:01.456Z" }]
  }
}
```

### Writes

| Call | Body | Success |
| --- | --- | --- |
| `POST /api/groups` | `{ "id", "name", "sortOrder" }` | `201` group |
| `PATCH /api/groups/:id` | `{ "name", "sortOrder" }` | `200` group |
| `DELETE /api/groups/:id` | empty | `204`, or `409` if the group still has clips |
| `POST /api/clips` | `multipart/form-data` with `file`, plus `id`, `name`, `groupId`, optional trim | `201` clip |
| `PATCH /api/clips/:id` | `{ "name", "groupId", "trimStartMs", "trimEndMs" }` | `200` clip |
| `PUT /api/clips/:id/audio` | `multipart/form-data` with `file` | `200` clip. Replacing audio resets trim on the server; a trim patch follows when this PC still has trim. |
| `DELETE /api/clips/:id` | empty | `204` |

`GET /api/clips/:id/audio` returns the stored bytes. `ETag` is the quoted SHA-256. The client checks the body hash against `hash`.

Allowed audio is detected from magic bytes (MP3, WAV, Ogg, WebM, M4A, FLAC, AAC), up to 32 MiB.

## Try the stub

The stub speaks this contract in memory. It is not the process on port 4092.

```bash
node scripts/home-server-stub.js --port 8787 --token lab-secret
npm run test:home-server
```

Point the app at `http://127.0.0.1:8787` with token `lab-secret` to exercise sync without the lab. Stop the stub and sync again: status becomes **Offline**, and clips already on disk still play.

Against the live service, use `http://192.168.0.211:4092` and the lab API key.

## What is not in this change

- No phone PWA deploy. The PWA uses the Tailscale URL above.
- No release bump and no git tag.
- LAN Web Remote is unchanged.
