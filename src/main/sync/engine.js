const crypto = require('crypto');
const { planSync, publicClip, publicGroup, samePayload } = require('./merge');

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
    revisedAt: null,
  };
}

function remoteHash(clips, id) {
  const found = (clips || []).find((clip) => String(clip.id) === String(id));
  return found ? (found.contentHash || null) : null;
}

/**
 * Pull remote library changes into the local store, then push dirty / never-synced
 * local changes. Playback is not involved; the store is the local library.
 * Network failures return a status object and do not throw.
 */
async function syncLibraries({ client, store }) {
  let remote;
  try {
    const health = await client.health();
    if (!health || health.ok !== true) {
      return {
        status: 'error',
        message: 'Home Server health check did not return ok',
        pulled: 0,
        pushed: 0,
        libraryChanged: false,
        revisedAt: null,
      };
    }
    // Full snapshot every time. Clip libraries are small, and a full pull
    // keeps the merge rule simple: a missing row is not a delete.
    remote = await client.getLibrary();
  } catch (err) {
    return failure(err);
  }

  const local = store.getSnapshot();
  const groups = planSync(local.groups, remote.groups || [], 'group');
  const clips = planSync(local.clips, remote.clips || [], 'clip');
  const localGroups = new Map((local.groups || []).map((group) => [String(group.id), group]));
  const localClips = new Map((local.clips || []).map((clip) => [String(clip.id), clip]));

  let pulled = 0;
  let pushed = 0;
  let libraryChanged = false;
  const problems = [];

  try {
    for (const group of groups.pulls) {
      const previous = localGroups.get(String(group.id));
      store.applyGroup(group);
      pulled += 1;
      if (!previous || !samePayload(previous, group, 'group')) libraryChanged = true;
    }
    for (const clip of clips.pulls) {
      const previous = localClips.get(String(clip.id));
      store.applyClip(clip);
      pulled += 1;
      if (!previous || !samePayload(previous, clip, 'clip')) libraryChanged = true;
      if (clip.deletedAt) {
        if (store.discardAudio) store.discardAudio(clip.id);
        continue;
      }
      if (!clip.contentHash) continue;
      const have = store.audioHash(clip.id);
      if (have === clip.contentHash) continue;
      try {
        const bytes = await client.getAudio(clip.id);
        const actual = hashBuffer(bytes);
        if (actual !== clip.contentHash) {
          problems.push(`Audio hash mismatch for ${clip.name || clip.id}`);
          continue;
        }
        store.writeAudio(clip.id, bytes);
        libraryChanged = true;
      } catch (err) {
        problems.push(`${clip.name || clip.id}: ${err.message}`);
        if (isOffline(err)) {
          return {
            status: 'offline',
            message: 'Home Server went offline during sync. Local playback still uses the saved library.',
            pulled,
            pushed,
            libraryChanged,
            revisedAt: null,
          };
        }
      }
    }
  } catch (err) {
    return {
      ...failure(err),
      pulled,
      pushed,
      libraryChanged,
    };
  }

  for (const group of groups.pushes) {
    try {
      if (group.deletedAt) await client.deleteGroup(group.id);
      else await client.putGroup(publicGroup(group));
      store.markSynced('group', group.id, group.updatedAt);
      pushed += 1;
    } catch (err) {
      problems.push(`Group ${group.name || group.id}: ${err.message}`);
      if (isOffline(err)) {
        return {
          status: 'offline',
          message: 'Home Server went offline. Local changes stay queued.',
          pulled,
          pushed,
          libraryChanged,
          revisedAt: null,
        };
      }
    }
  }

  for (const clip of clips.pushes) {
    try {
      if (clip.deletedAt) {
        await client.deleteClip(clip.id);
        store.markSynced('clip', clip.id, clip.updatedAt);
        if (store.discardAudio) store.discardAudio(clip.id);
      } else {
        await client.putClip(publicClip(clip));
        const known = remoteHash(remote.clips, clip.id);
        if (clip.contentHash && known !== clip.contentHash) {
          const bytes = store.readAudio(clip.id);
          if (bytes && bytes.length) {
            await client.putAudio(clip.id, bytes, clip.contentHash);
          }
        }
        store.markSynced('clip', clip.id, clip.updatedAt);
      }
      pushed += 1;
    } catch (err) {
      problems.push(`${clip.name || clip.id}: ${err.message}`);
      if (isOffline(err)) {
        return {
          status: 'offline',
          message: 'Home Server went offline. Local changes stay queued.',
          pulled,
          pushed,
          libraryChanged,
          revisedAt: null,
        };
      }
    }
  }

  if (problems.length) {
    return {
      status: 'error',
      message: problems[0],
      pulled,
      pushed,
      libraryChanged,
      revisedAt: null,
      problems,
    };
  }

  return {
    status: 'connected',
    message: 'Sync complete',
    pulled,
    pushed,
    libraryChanged,
    revisedAt: remote.revisedAt || null,
  };
}

module.exports = { syncLibraries, hashBuffer };
