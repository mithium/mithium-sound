# Home Server sync

Mithium Sound stays a local soundboard. Discord playback, local-device playback, global hotkeys, and the clip grid always read the library on this PC (`%APPDATA%\mithium-sound\`).

Home Server is an optional LAN sync target for a home-lab service (and, later, a phone PWA hosted in the lab). It is not the in-app LAN Web Remote. The remote still serves a phone page from this PC while the PC is on. Home Server is a separate machine the Windows app talks to when it can.

If the Home Server is off, unreachable, or not configured, the app does not block, prompt, or skip playback. Status shows **Offline** (or **Disabled** when the toggle is off). Edits made on this PC stay in the local database and are pushed on the next successful sync.

## Settings

Settings → **Home Server** (separate from **LAN Web Remote Control**):

| Field | Purpose |
| --- | --- |
| Enable Home Server sync | Turns sync on or off. Off means no network calls. |
| Base URL | LAN origin, for example `http://homelab:8787` or `http://192.168.1.20:8787` |
| Auth token | Shared secret. Not the Discord bot token. |
| Connection | **Connected**, **Offline**, or **Error** |
| Sync now | Pulls the remote library, then pushes queued local edits |

The URL and token are stored in `%APPDATA%\mithium-sound\settings.json` next to the Discord bot token and the LAN remote PIN (`homeServerUrl`, `homeServerToken`, `homeServerEnabled`). The same file is the existing secret store. Sync state (last result, server revision) is in `homeserver-state.json` beside it so a normal settings save cannot wipe it.

The Discord bot token is never placed in a Home Server request. The client sends only clip and group records. If the Home Server token is the same string as the bot token, sync refuses before opening a connection. If a library payload would contain the bot token string, that request is refused.

The client authenticates with both headers, so a server may check either:

```
Authorization: Bearer <token>
X-Api-Key: <token>
```

Only `http:` and `https:` URLs are allowed. Put the secret in the token field, not in the URL.

## Sync rule

Identity is a stable `id` (UUID), not the local SQLite row id. The Windows UI keeps using local integer ids for playback.

1. The record with the newer `updatedAt` wins (last write wins).
2. If `updatedAt` ties, the lexicographically greater `contentHash` wins. A missing hash counts as an empty string.
3. If those also tie, keep the local row and do not transfer it. A row with unsent local edits is still pushed.
4. A clip or group that exists only on this PC is kept. It is uploaded when it has local edits or has never been acknowledged by the server. A clean row that the server simply omits is **not** deleted and is **not** re-uploaded.
5. A row that exists only on the server is inserted locally, and its audio is downloaded when the content hash differs from the local file.
6. Deletes are tombstones (`deletedAt`). A tombstone is a normal record in rules 1–2. **Absence is not a delete.** A local-only clip is never removed just because the server snapshot does not list it.

Local edits set `updatedAt` to the current time and mark the row dirty. That dirty flag is the outbound queue. It survives restarts. A failed sync leaves the flag set and leaves playback on the local files.

Deleting a clip in the app hides it immediately and removes the audio file from disk. The tombstone row remains until the server has acknowledged it, so a later sync can publish the delete. If the server has a newer copy, that copy is downloaded again.

`collapsed` on a group is device-local UI state and is not part of the sync comparison.

The Windows client always pulls `GET /api/library` (a full snapshot). Metadata for a soundboard is small, and a full snapshot makes rule 4 unambiguous. `GET /api/sync?since=` is still part of the contract for other clients.

## Clip and group fields

Clips align with the app's sound rows:

| API field | Local column | Notes |
| --- | --- | --- |
| `id` | `sync_id` | UUID |
| `groupId` | `groups.sync_id` for `group_id` | `null` if ungrouped |
| `name` | `name` | |
| `filename` | `filename` | Hint for the file extension. Playback uses the local file. |
| `contentHash` | `content_hash` | SHA-256 hex of the audio bytes |
| `sourceType` | `source_type` | `local` or `youtube` |
| `youtubeUrl` | `youtube_url` | |
| `trimStart`, `trimEnd` | `youtube_start`, `youtube_end` | Trim stored with the clip |
| `volume` | `clip_volume` | Optional per-clip value. `null` means the app volume slider. Playback is unchanged when this is null. |
| `hotkey` | `hotkey` | Optional. Stored and synced for the lab editor. Windows global hotkeys remain V / T / Delete. |
| `position` | `position` | |
| `updatedAt` | `updated_at` | ISO-8601 |
| `deletedAt` | `deleted_at` | ISO-8601 tombstone, or `null` |

Groups: `id`, `name`, `position`, `updatedAt`, `deletedAt`.

## HTTP API

JSON unless noted. Errors use `{ "error": "..." }`.

### `GET /api/health`

```json
{ "ok": true }
```

A connection failure is **Offline**. HTTP 401/403 is **Error** (bad token). HTTP 502/503/504 is **Offline**.

### `GET /api/library`

Full snapshot, including tombstones.

```json
{
  "revisedAt": "2026-10-02T18:00:00.000Z",
  "groups": [
    {
      "id": "2b1c...",
      "name": "Bits",
      "position": 0,
      "updatedAt": "2026-10-02T18:00:00.000Z",
      "deletedAt": null
    }
  ],
  "clips": [
    {
      "id": "9f0e...",
      "groupId": "2b1c...",
      "name": "Airhorn",
      "filename": "airhorn.mp3",
      "contentHash": "<sha256 hex>",
      "sourceType": "local",
      "youtubeUrl": null,
      "trimStart": null,
      "trimEnd": null,
      "volume": null,
      "hotkey": null,
      "position": 0,
      "updatedAt": "2026-10-02T18:00:00.000Z",
      "deletedAt": null
    }
  ]
}
```

### `GET /api/sync?since=<ISO-8601>`

Optional incremental read for other clients. Same body as `/api/library`, but only rows whose `updatedAt` is strictly newer than `since`. Tombstones are included. The Windows app does not require this route.

### `GET /api/clips/:id/audio`

Raw audio bytes. `Content-Type: application/octet-stream`. `X-Content-Hash` is the SHA-256 hex. Missing or tombstoned clips return 404.

### `PUT /api/clips/:id`

Upsert clip metadata (the JSON object above, without audio). The server must not treat this as permission to read anything except the library.

### `PUT /api/clips/:id/audio`

Raw bytes. Header `X-Content-Hash` must match the body when present. Response: `{ "contentHash": "<sha256 hex>" }`.

### `DELETE /api/clips/:id`

Writes a tombstone. Response includes the tombstoned clip (`deletedAt`, `updatedAt`). Does not mean "forget the id".

### `PUT /api/groups/:id` and `DELETE /api/groups/:id`

Same pattern as clips. Delete tombstones the group. The Windows app also ungroups that group's clips locally, matching the existing "delete group, sounds become ungrouped" behavior, and pushes those clip edits.

### `PUT /api/library`

Optional bulk upsert. Body: `{ "groups": [...], "clips": [...] }`. Each row is merged with the same last-write-wins rule. This is **not** a replace-all: omitted rows stay. Response: `{ "revisedAt": "..." }`. The Windows client pushes granular PUT/DELETE calls rather than this bulk route.

## Try it with the stub

The stub keeps the library in memory and speaks this contract. It is not the lab service.

```bash
node scripts/home-server-stub.js --port 8787 --token lab-secret
```

In the app: enable Home Server, set the base URL to `http://127.0.0.1:8787`, set the token to `lab-secret`, then **Sync now**.

Stop the stub and sync again. Status becomes **Offline**. Clips already on disk still play.

Checks that do not need the Electron UI:

```bash
npm run test:home-server
```

That covers the merge rule, a pull that writes audio into a local library, a push of an offline edit, a refused Discord token, and an unreachable server that leaves the local rows unchanged.

## What is not in this change

- No phone PWA and no deploy of the lab service. This is the Windows client plus a local stub.
- No release bump and no git tag.
- LAN Web Remote is unchanged.
