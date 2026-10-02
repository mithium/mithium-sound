// Home Server sync against mithium-sound-library.
//
// The server owns createdAt, updatedAt, and the library revision. Those
// timestamps are never sent. The cursor is the integer serverRevision.
//
// 1. First contact (no stored revision) pulls GET /api/library. That snapshot
//    has no tombstones. Rows that exist only on this PC are kept and uploaded.
// 2. Later polls use GET /api/sync?sinceRevision=. Apply upserts and deletes
//    in revision order. The higher revision wins, including over a dirty local
//    edit. A delete is only a tombstone from that feed.
// 3. A missing row in the full library is not a delete. If the tombstone list
//    is truncated (5000) or the server revision moved backwards, reconcile
//    from GET /api/library: drop clean rows that were previously synced and
//    are gone. Dirty local edits and never-synced clips stay.
// 4. Push with POST, PATCH, PUT audio, and DELETE. DELETE is 204.

const TOMBSTONE_CAP = 5000;

const WIRE_FORBIDDEN = [
  'createdAt',
  'updatedAt',
  'botToken',
  'bot_token',
  'discordToken',
  'discord_token',
  'contentHash',
  'youtubeUrl',
  'sourceType',
  'hotkey',
  'volume',
  'position',
  'deletedAt',
];

function canonicalId(value) {
  if (value == null || value === '') return '';
  return String(value).toLowerCase();
}

function asInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeClip(wire) {
  return {
    id: canonicalId(wire.id),
    groupId: wire.groupId ? canonicalId(wire.groupId) : null,
    name: wire.name == null ? '' : String(wire.name),
    hash: wire.hash || null,
    trimStartMs: wire.trimStartMs == null ? null : asInt(wire.trimStartMs, null),
    trimEndMs: wire.trimEndMs == null ? null : asInt(wire.trimEndMs, null),
    durationMs: wire.durationMs == null ? null : asInt(wire.durationMs, null),
    mimeType: wire.mimeType || null,
    sizeBytes: wire.sizeBytes == null ? null : asInt(wire.sizeBytes, null),
    audioPath: wire.audioPath || null,
    revision: asInt(wire.revision, 0),
    updatedAt: wire.updatedAt || null,
    deletedAt: wire.deletedAt || null,
    dirty: false,
    synced: true,
  };
}

function normalizeGroup(wire) {
  return {
    id: canonicalId(wire.id),
    name: wire.name == null ? '' : String(wire.name),
    sortOrder: asInt(wire.sortOrder, 0),
    revision: asInt(wire.revision, 0),
    updatedAt: wire.updatedAt || null,
    deletedAt: wire.deletedAt || null,
    dirty: false,
    synced: true,
  };
}

function remoteWins(local, remoteRevision) {
  if (!local) return true;
  const localRevision = asInt(local.revision, 0);
  const remote = asInt(remoteRevision, 0);
  if (local.dirty && localRevision >= remote) return false;
  if (!local.dirty && localRevision >= remote) return false;
  return true;
}

function incrementalEvents(body) {
  const events = [];
  const groups = (body && body.groups) || {};
  const clips = (body && body.clips) || {};
  for (const group of groups.upserted || []) {
    const record = normalizeGroup(group);
    events.push({ kind: 'group', op: 'upsert', revision: record.revision, record });
  }
  for (const group of groups.deleted || []) {
    events.push({
      kind: 'group',
      op: 'delete',
      revision: asInt(group.revision, 0),
      record: {
        id: canonicalId(group.id),
        revision: asInt(group.revision, 0),
        deletedAt: group.deletedAt || null,
      },
    });
  }
  for (const clip of clips.upserted || []) {
    const record = normalizeClip(clip);
    events.push({ kind: 'clip', op: 'upsert', revision: record.revision, record });
  }
  for (const clip of clips.deleted || []) {
    events.push({
      kind: 'clip',
      op: 'delete',
      revision: asInt(clip.revision, 0),
      record: {
        id: canonicalId(clip.id),
        revision: asInt(clip.revision, 0),
        deletedAt: clip.deletedAt || null,
      },
    });
  }
  events.sort((a, b) => a.revision - b.revision || (a.op === 'delete' ? 1 : 0) - (b.op === 'delete' ? 1 : 0));
  return events;
}

function tombstonesTruncated(body) {
  const groups = (body && body.groups && body.groups.deleted) || [];
  const clips = (body && body.clips && body.clips.deleted) || [];
  return groups.length + clips.length >= TOMBSTONE_CAP;
}

function reconcileDeletes(localRecords, remoteRecords) {
  const remoteIds = new Set((remoteRecords || []).map((record) => canonicalId(record.id)));
  const remove = [];
  for (const local of localRecords || []) {
    if (!local || local.deletedAt) continue;
    if (!local.synced || local.revision == null) continue;
    if (local.dirty) continue;
    if (!remoteIds.has(canonicalId(local.id))) remove.push(local);
  }
  return remove;
}

function assertWireBody(body) {
  for (const key of Object.keys(body || {})) {
    if (WIRE_FORBIDDEN.includes(key)) {
      const error = new Error(`Refusing to send ${key} to the Home Server`);
      error.status = 'error';
      throw error;
    }
  }
}

function groupWriteBody(group) {
  const body = {
    id: canonicalId(group.id),
    name: String(group.name || '').trim(),
    sortOrder: asInt(group.sortOrder, 0),
  };
  assertWireBody(body);
  return body;
}

function clipPatchBody(clip) {
  const body = {};
  const name = String(clip.name || '').trim();
  if (name) body.name = name;
  if (clip.groupId) body.groupId = canonicalId(clip.groupId);
  if (clip.trimStartMs != null) body.trimStartMs = asInt(clip.trimStartMs, 0);
  if (clip.trimEndMs != null) body.trimEndMs = asInt(clip.trimEndMs, 0);
  assertWireBody(body);
  return body;
}

function fallbackGroupId(groups) {
  const live = (groups || []).filter((group) => group && !group.deletedAt);
  const ungrouped = live.find((group) => group.name === 'Ungrouped');
  if (ungrouped) return ungrouped.id;
  live.sort((a, b) => asInt(a.sortOrder, 0) - asInt(b.sortOrder, 0));
  return live.length ? live[0].id : null;
}

module.exports = {
  TOMBSTONE_CAP,
  WIRE_FORBIDDEN,
  canonicalId,
  normalizeClip,
  normalizeGroup,
  remoteWins,
  incrementalEvents,
  tombstonesTruncated,
  reconcileDeletes,
  assertWireBody,
  groupWriteBody,
  clipPatchBody,
  fallbackGroupId,
};
