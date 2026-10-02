const crypto = require('crypto');
const {
  normalizeClip,
  normalizeGroup,
  remoteWins,
  incrementalEvents,
  tombstonesTruncated,
  reconcileDeletes,
  groupWriteBody,
  clipPatchBody,
  fallbackGroupId,
  canonicalId,
} = require('./merge');

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isOffline(err) {
  return err && err.status === 'offline';
}

function failure(err) {
  const status = err && err.status === 'offline' ? 'offline' : 'error';
  return {
    status,
    message: (err && err.message) || 'Home Server sync failed',
    pulled: 0,
    pushed: 0,
    libraryChanged: false,
    serverRevision: null,
  };
}

function findLocal(list, id) {
  return (list || []).find((record) => canonicalId(record.id) === canonicalId(id)) || null;
}

async function downloadIfNeeded(client, store, clip, problems) {
  if (!clip || clip.deletedAt || !clip.hash) return false;
  if (store.audioHash(clip.id) === clip.hash) return false;
  try {
    const bytes = await client.getAudio(clip.id);
    const actual = hashBuffer(bytes);
    if (actual !== clip.hash) {
      problems.push(`Audio hash mismatch for ${clip.name || clip.id}`);
      return false;
    }
    store.writeAudio(clip.id, bytes);
    return true;
  } catch (err) {
    problems.push(`${clip.name || clip.id}: ${err.message}`);
    if (isOffline(err)) throw err;
    return false;
  }
}

function applyRemoteClip(store, local, clip) {
  if (!remoteWins(local, clip.revision)) return false;
  store.applyClip({ ...clip, deletedAt: null });
  return true;
}

function applyRemoteGroup(store, local, group) {
  if (!remoteWins(local, group.revision)) return false;
  store.applyGroup({ ...group, deletedAt: null });
  return true;
}

function applyDelete(store, kind, local, tombstone) {
  if (local && !remoteWins(local, tombstone.revision)) return false;
  const record = {
    id: tombstone.id,
    revision: tombstone.revision,
    deletedAt: tombstone.deletedAt || new Date().toISOString(),
    name: local ? local.name : '',
    sortOrder: local ? local.sortOrder : 0,
    groupId: local ? local.groupId : null,
  };
  if (kind === 'group') store.applyGroup(record);
  else store.applyClip(record);
  if (kind === 'clip' && store.discardAudio) store.discardAudio(tombstone.id);
  return true;
}

/**
 * Pull the lab library, then push dirty local edits.
 * Playback never calls this. Network failures return a status and do not throw.
 */
async function syncLibraries({ client, store }) {
  let serverRevision = null;
  let fullLibrary = null;
  let syncBody = null;
  let reconcile = false;

  try {
    const health = await client.health();
    if (!health || health.ok !== true) {
      return {
        status: 'error',
        message: 'Home Server health check did not return ok',
        pulled: 0,
        pushed: 0,
        libraryChanged: false,
        serverRevision: null,
      };
    }
    const since = store.getServerRevision ? store.getServerRevision() : null;
    if (since == null) {
      fullLibrary = await client.getLibrary();
      serverRevision = Number.isInteger(fullLibrary.revision) ? fullLibrary.revision : Number(fullLibrary.revision);
    } else {
      syncBody = await client.getSync(since);
      const reported = Number(syncBody.serverRevision);
      if (syncBody.mode === 'snapshot' || tombstonesTruncated(syncBody) || (Number.isFinite(reported) && reported < since)) {
        fullLibrary = await client.getLibrary();
        reconcile = true;
        syncBody = null;
        serverRevision = Number(fullLibrary.revision);
      } else {
        serverRevision = Number.isFinite(reported) ? reported : since;
      }
    }
  } catch (err) {
    return failure(err);
  }

  const local = store.getSnapshot();
  let pulled = 0;
  let pushed = 0;
  let libraryChanged = false;
  const problems = [];
  let cursorReady = true;

  try {
    if (fullLibrary) {
      for (const group of fullLibrary.groups || []) {
        const record = normalizeGroup(group);
        const previous = findLocal(local.groups, record.id);
        if (applyRemoteGroup(store, previous, record)) {
          pulled += 1;
          libraryChanged = true;
        }
      }
      for (const clip of fullLibrary.clips || []) {
        const record = normalizeClip(clip);
        const previous = findLocal(local.clips, record.id);
        if (applyRemoteClip(store, previous, record)) {
          pulled += 1;
          libraryChanged = true;
        }
        const wrote = await downloadIfNeeded(client, store, record, problems);
        if (wrote) libraryChanged = true;
      }
      if (reconcile) {
        const fresh = store.getSnapshot();
        for (const group of reconcileDeletes(fresh.groups, (fullLibrary.groups || []).map(normalizeGroup))) {
          if (applyDelete(store, 'group', group, { id: group.id, revision: (group.revision || 0) + 1, deletedAt: new Date().toISOString() })) {
            pulled += 1;
            libraryChanged = true;
          }
        }
        for (const clip of reconcileDeletes(fresh.clips, (fullLibrary.clips || []).map(normalizeClip))) {
          if (applyDelete(store, 'clip', clip, { id: clip.id, revision: (clip.revision || 0) + 1, deletedAt: new Date().toISOString() })) {
            pulled += 1;
            libraryChanged = true;
          }
        }
      }
    } else {
      for (const event of incrementalEvents(syncBody)) {
        const list = event.kind === 'group' ? local.groups : local.clips;
        const previous = findLocal(list, event.record.id);
        if (event.op === 'delete') {
          if (applyDelete(store, event.kind, previous, event.record)) {
            pulled += 1;
            libraryChanged = true;
          }
          continue;
        }
        const applied = event.kind === 'group'
          ? applyRemoteGroup(store, previous, event.record)
          : applyRemoteClip(store, previous, event.record);
        if (applied) {
          pulled += 1;
          libraryChanged = true;
        }
        if (event.kind === 'clip') {
          const wrote = await downloadIfNeeded(client, store, event.record, problems);
          if (wrote) libraryChanged = true;
        }
      }
    }
  } catch (err) {
    if (isOffline(err)) {
      return {
        status: 'offline',
        message: 'Home Server went offline during sync. Local playback still uses the saved library.',
        pulled,
        pushed,
        libraryChanged,
        serverRevision: null,
      };
    }
    cursorReady = false;
    problems.push(err.message);
  }

  try {
    for (const clip of store.getSnapshot().clips || []) {
      if (clip.deletedAt || !clip.remoteHash) continue;
      if (store.audioHash(clip.id) === clip.remoteHash) continue;
      const wrote = await downloadIfNeeded(client, store, { ...clip, hash: clip.remoteHash, name: clip.name }, problems);
      if (wrote) libraryChanged = true;
    }
  } catch (err) {
    if (isOffline(err)) {
      return {
        status: 'offline',
        message: 'Home Server went offline during sync. Local playback still uses the saved library.',
        pulled,
        pushed,
        libraryChanged,
        serverRevision: null,
      };
    }
    cursorReady = false;
    problems.push(err.message);
  }

  const afterPull = store.getSnapshot();
  let groups = afterPull.groups || [];
  let groupId = fallbackGroupId(groups);

  async function refreshGroups() {
    groups = store.getSnapshot().groups || [];
    groupId = fallbackGroupId(groups);
  }

  async function pushGroupCreates() {
    for (const group of groups) {
      if (group.deletedAt) continue;
      if (group.synced && group.revision != null) continue;
      try {
        const created = await client.createGroup(groupWriteBody(group));
        store.applyGroup(normalizeGroup(created), group.updatedAt);
        pushed += 1;
      } catch (err) {
        problems.push(`Group ${group.name || group.id}: ${err.message}`);
        if (isOffline(err)) throw err;
      }
    }
  }

  try {
    await pushGroupCreates();
    await refreshGroups();
    const clipsNeedingGroup = (store.getSnapshot().clips || []).filter((clip) => !clip.deletedAt && (clip.dirty || !clip.synced || clip.revision == null));
    if (!groupId && clipsNeedingGroup.length) {
      const created = await client.createGroup(groupWriteBody({
        id: crypto.randomUUID(),
        name: 'Ungrouped',
        sortOrder: 0,
      }));
      store.applyGroup(normalizeGroup(created));
      await refreshGroups();
    }

    for (const group of store.getSnapshot().groups || []) {
      if (group.deletedAt || !group.dirty || group.revision == null) continue;
      try {
        const patched = await client.patchGroup(group.id, {
          name: groupWriteBody(group).name,
          sortOrder: groupWriteBody(group).sortOrder,
        });
        store.applyGroup(normalizeGroup(patched), group.updatedAt);
        pushed += 1;
      } catch (err) {
        problems.push(`Group ${group.name || group.id}: ${err.message}`);
        if (isOffline(err)) throw err;
      }
    }

    for (const clip of store.getSnapshot().clips || []) {
      if (clip.deletedAt) continue;
      const neverSynced = !clip.synced || clip.revision == null;
      if (!neverSynced && !clip.dirty) continue;
      let targetGroup = clip.groupId;
      const group = findLocal(store.getSnapshot().groups, targetGroup);
      if (!targetGroup || !group || group.deletedAt) targetGroup = fallbackGroupId(store.getSnapshot().groups);
      const payload = { ...clip, groupId: targetGroup };
      try {
        if (neverSynced) {
          const bytes = store.readAudio(clip.id);
          const created = await client.createClip({
            id: clip.id,
            name: payload.name,
            groupId: targetGroup,
            trimStartMs: clip.trimStartMs,
            trimEndMs: clip.trimEndMs,
            filename: clip.filename,
            bytes,
          });
          store.applyClip(normalizeClip(created), clip.updatedAt);
          pushed += 1;
          continue;
        }
        if (clip.hash && clip.remoteHash && clip.hash !== clip.remoteHash) {
          const bytes = store.readAudio(clip.id);
          const replaced = await client.putAudio(clip.id, bytes, clip.filename);
          store.applyClip(normalizeClip(replaced), clip.updatedAt);
          pushed += 1;
        } else if (clip.hash && !clip.remoteHash) {
          const bytes = store.readAudio(clip.id);
          const replaced = await client.putAudio(clip.id, bytes, clip.filename);
          store.applyClip(normalizeClip(replaced), clip.updatedAt);
          pushed += 1;
        }
        const patched = await client.patchClip(clip.id, clipPatchBody({ ...payload, trimStartMs: clip.trimStartMs, trimEndMs: clip.trimEndMs }));
        store.applyClip(normalizeClip(patched), clip.updatedAt);
        pushed += 1;
      } catch (err) {
        problems.push(`${clip.name || clip.id}: ${err.message}`);
        if (isOffline(err)) throw err;
      }
    }

    for (const clip of store.getSnapshot().clips || []) {
      if (!clip.deletedAt || !clip.dirty) continue;
      if (!clip.synced && clip.revision == null) continue;
      try {
        await client.deleteClip(clip.id);
        if (store.markSynced) store.markSynced('clip', clip.id, clip.updatedAt);
        if (store.discardAudio) store.discardAudio(clip.id);
        pushed += 1;
      } catch (err) {
        if (err.httpStatus === 404) {
          if (store.markSynced) store.markSynced('clip', clip.id, clip.updatedAt);
          continue;
        }
        problems.push(`${clip.name || clip.id}: ${err.message}`);
        if (isOffline(err)) throw err;
      }
    }

    for (const group of store.getSnapshot().groups || []) {
      if (!group.deletedAt || !group.dirty) continue;
      if (!group.synced && group.revision == null) continue;
      try {
        await client.deleteGroup(group.id);
        if (store.markSynced) store.markSynced('group', group.id, group.updatedAt);
        pushed += 1;
      } catch (err) {
        if (err.httpStatus === 404) {
          if (store.markSynced) store.markSynced('group', group.id, group.updatedAt);
          continue;
        }
        problems.push(`Group ${group.name || group.id}: ${err.message}`);
        if (isOffline(err)) throw err;
      }
    }
  } catch (err) {
    if (isOffline(err)) {
      return {
        status: 'offline',
        message: 'Home Server went offline. Local changes stay queued.',
        pulled,
        pushed,
        libraryChanged,
        serverRevision: null,
      };
    }
    problems.push(err.message);
  }

  if (problems.length) {
    return {
      status: 'error',
      message: problems[0],
      pulled,
      pushed,
      libraryChanged,
      serverRevision: cursorReady && Number.isFinite(serverRevision) ? serverRevision : null,
      problems,
    };
  }

  if (cursorReady && Number.isFinite(serverRevision) && store.setServerRevision) {
    store.setServerRevision(serverRevision);
  }

  return {
    status: 'connected',
    message: 'Sync complete',
    pulled,
    pushed,
    libraryChanged,
    serverRevision: cursorReady && Number.isFinite(serverRevision) ? serverRevision : null,
  };
}

module.exports = { syncLibraries, hashBuffer };
