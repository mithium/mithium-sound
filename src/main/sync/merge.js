// Home Server sync rule (last-write-wins, merge, never drop local-only data):
//
// Identity is the stable sync id (UUID), not the local SQLite row id.
// 1. The record with the newer updatedAt wins.
// 2. If updatedAt ties, the lexicographically greater contentHash wins
//    (missing hash counts as '').
// 3. If those also tie, keep the local row and do not transfer it.
//    A dirty local row is still pushed so an offline edit is not stuck.
// 4. A clip or group that exists only locally is kept. It is pushed when it
//    has local edits (dirty) or has never been acknowledged (synced = false).
//    A clean, previously synced row that the server simply omits is kept
//    and is not deleted and not re-uploaded.
// 5. A row that exists only on the server is inserted locally.
// 6. Deletes are tombstones (deletedAt). Absence is not a delete. A tombstone
//    wins only when rule 1–2 says it is newer than the live row.

function parseTime(value) {
  const t = Date.parse(value || '');
  return Number.isNaN(t) ? 0 : t;
}

function normStr(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function clipPayload(clip) {
  return {
    id: String(clip.id),
    groupId: normStr(clip.groupId),
    name: clip.name == null ? '' : String(clip.name),
    contentHash: normStr(clip.contentHash),
    sourceType: normStr(clip.sourceType) || 'local',
    youtubeUrl: normStr(clip.youtubeUrl),
    trimStart: normStr(clip.trimStart),
    trimEnd: normStr(clip.trimEnd),
    volume: clip.volume == null || clip.volume === '' ? null : Number(clip.volume),
    hotkey: normStr(clip.hotkey),
    position: Number(clip.position) || 0,
    deletedAt: normStr(clip.deletedAt),
  };
}

function groupPayload(group) {
  return {
    id: String(group.id),
    name: group.name == null ? '' : String(group.name),
    position: Number(group.position) || 0,
    deletedAt: normStr(group.deletedAt),
  };
}

function samePayload(local, remote, kind) {
  const shape = kind === 'group' ? groupPayload : clipPayload;
  return JSON.stringify(shape(local)) === JSON.stringify(shape(remote));
}

/**
 * @returns {'local' | 'remote' | 'equal'}
 */
function pickWinner(local, remote) {
  const localTime = parseTime(local && local.updatedAt);
  const remoteTime = parseTime(remote && remote.updatedAt);
  if (localTime > remoteTime) return 'local';
  if (remoteTime > localTime) return 'remote';
  const localHash = (local && local.contentHash) || '';
  const remoteHash = (remote && remote.contentHash) || '';
  if (localHash > remoteHash) return 'local';
  if (remoteHash > localHash) return 'remote';
  return 'equal';
}

function normalizeIncoming(record) {
  return {
    ...record,
    id: String(record.id),
    updatedAt: record.updatedAt || '1970-01-01T00:00:00.000Z',
    deletedAt: record.deletedAt || null,
    contentHash: record.contentHash || null,
    dirty: false,
    synced: true,
  };
}

/**
 * Decide which rows to pull and which to push.
 * remoteRecords may be a full snapshot or an incremental delta.
 * Omission from remoteRecords is never treated as a delete.
 */
function planSync(localRecords, remoteRecords, kind) {
  const localById = new Map();
  for (const record of localRecords || []) {
    if (record && record.id) localById.set(String(record.id), record);
  }
  const remoteById = new Map();
  for (const record of remoteRecords || []) {
    if (record && record.id) remoteById.set(String(record.id), normalizeIncoming(record));
  }

  const pulls = [];
  const pushes = [];

  for (const [id, remote] of remoteById) {
    const local = localById.get(id);
    if (!local) {
      pulls.push(remote);
      continue;
    }
    const winner = pickWinner(local, remote);
    if (winner === 'remote') {
      pulls.push(remote);
      continue;
    }
    if (winner === 'local' && (!samePayload(local, remote, kind) || local.dirty)) {
      pushes.push(local);
      continue;
    }
    if (winner === 'equal' && local.dirty && !samePayload(local, remote, kind)) {
      pushes.push(local);
    }
  }

  for (const [id, local] of localById) {
    if (remoteById.has(id)) continue;
    if (local.dirty || !local.synced) pushes.push(local);
  }

  return { pulls, pushes };
}

function publicClip(clip) {
  return {
    id: clip.id,
    groupId: clip.groupId || null,
    name: clip.name,
    filename: clip.filename || null,
    contentHash: clip.contentHash || null,
    sourceType: clip.sourceType || 'local',
    youtubeUrl: clip.youtubeUrl || null,
    trimStart: clip.trimStart || null,
    trimEnd: clip.trimEnd || null,
    volume: clip.volume == null ? null : clip.volume,
    hotkey: clip.hotkey || null,
    position: clip.position || 0,
    updatedAt: clip.updatedAt,
    deletedAt: clip.deletedAt || null,
  };
}

function publicGroup(group) {
  return {
    id: group.id,
    name: group.name,
    position: group.position || 0,
    updatedAt: group.updatedAt,
    deletedAt: group.deletedAt || null,
  };
}

module.exports = {
  pickWinner,
  planSync,
  samePayload,
  clipPayload,
  groupPayload,
  publicClip,
  publicGroup,
  normalizeIncoming,
};
