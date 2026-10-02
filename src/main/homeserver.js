const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const soundboard = require('./soundboard');
const { createClient } = require('./sync/client');
const { syncLibraries } = require('./sync/engine');

const STATE_FILE = 'homeserver-state.json';

let listener = null;
let timer = null;
let current = null;
let rerun = false;

function statePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {
      lastSyncAt: null,
      lastStatus: 'idle',
      lastMessage: '',
      lastRevisedAt: null,
    };
  }
}

function saveState(next) {
  const merged = { ...loadState(), ...next };
  try {
    fs.writeFileSync(statePath(), JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error('Failed to save Home Server state:', err.message);
  }
  return merged;
}

function enabled() {
  return !!settings.get('homeServerEnabled');
}

function getState() {
  const stored = loadState();
  if (!enabled()) {
    return {
      status: 'disabled',
      message: 'Home Server is off. Playback uses the local library.',
      lastSyncAt: stored.lastSyncAt || null,
      enabled: false,
      libraryChanged: false,
    };
  }
  return {
    status: stored.lastStatus || 'idle',
    message: stored.lastMessage || '',
    lastSyncAt: stored.lastSyncAt || null,
    enabled: true,
    libraryChanged: false,
  };
}

function emit(state) {
  if (listener) listener(state);
}

function onStatus(callback) {
  listener = callback;
}

function createStore() {
  return {
    getServerRevision() {
      const value = loadState().serverRevision;
      return Number.isInteger(value) ? value : null;
    },
    setServerRevision(value) {
      if (Number.isInteger(value)) saveState({ serverRevision: value });
    },
    getSnapshot() {
      return soundboard.getSyncSnapshot();
    },
    applyGroup(group, baseUpdatedAt) {
      soundboard.applySyncedGroup(group, baseUpdatedAt);
    },
    applyClip(clip, baseUpdatedAt) {
      soundboard.applySyncedClip(clip, baseUpdatedAt);
    },
    audioHash(id) {
      return soundboard.getAudioHash(id);
    },
    readAudio(id) {
      return soundboard.readAudioBySyncId(id);
    },
    writeAudio(id, bytes) {
      soundboard.writeAudioBySyncId(id, bytes);
    },
    discardAudio(id) {
      soundboard.discardAudioBySyncId(id);
    },
    markSynced(kind, id, updatedAt) {
      soundboard.markSyncAcknowledged(kind, id, updatedAt);
    },
  };
}

function buildClient() {
  const botToken = settings.get('botToken') || '';
  const token = (settings.get('homeServerToken') || '').trim();
  return createClient({
    baseUrl: (settings.get('homeServerUrl') || '').trim(),
    token,
    forbiddenSecrets: botToken ? [botToken] : [],
  });
}

async function runOnce() {
  if (!enabled()) {
    const state = getState();
    emit(state);
    return state;
  }

  const url = (settings.get('homeServerUrl') || '').trim();
  if (!url) {
    const state = {
      status: 'error',
      message: 'Enter a Home Server URL',
      lastSyncAt: loadState().lastSyncAt || null,
      enabled: true,
      libraryChanged: false,
    };
    saveState({ lastStatus: 'error', lastMessage: state.message });
    emit(state);
    return state;
  }

  const botToken = settings.get('botToken') || '';
  const homeToken = (settings.get('homeServerToken') || '').trim();
  if (botToken && homeToken && botToken === homeToken) {
    const state = {
      status: 'error',
      message: 'Home Server token must not be the Discord bot token',
      lastSyncAt: loadState().lastSyncAt || null,
      enabled: true,
      libraryChanged: false,
    };
    saveState({ lastStatus: 'error', lastMessage: state.message });
    emit(state);
    return state;
  }

  emit({
    status: 'syncing',
    message: 'Syncing…',
    lastSyncAt: loadState().lastSyncAt || null,
    enabled: true,
    libraryChanged: false,
  });

  let result;
  try {
    result = await syncLibraries({ client: buildClient(), store: createStore() });
  } catch (err) {
    result = {
      status: 'error',
      message: err.message || 'Home Server sync failed',
      pulled: 0,
      pushed: 0,
      libraryChanged: false,
      serverRevision: null,
    };
  }

  const nextState = {
    lastStatus: result.status,
    lastMessage: result.message,
  };
  if (result.status === 'connected') {
    nextState.lastSyncAt = new Date().toISOString();
  }
  if (Number.isInteger(result.serverRevision) && result.status !== 'offline') {
    nextState.serverRevision = result.serverRevision;
  }
  const saved = saveState(nextState);
  const payload = {
    status: result.status,
    message: result.message,
    lastSyncAt: saved.lastSyncAt || null,
    enabled: true,
    libraryChanged: !!result.libraryChanged,
    pulled: result.pulled || 0,
    pushed: result.pushed || 0,
  };
  if (result.status === 'offline') {
    console.log('Home Server offline. Local library remains in use.');
  } else if (result.status === 'error') {
    console.error('Home Server sync error:', result.message);
  } else {
    console.log(`Home Server sync: pulled ${payload.pulled}, pushed ${payload.pushed}`);
  }
  emit(payload);
  return payload;
}

async function syncNow() {
  if (current) {
    rerun = true;
    return current;
  }
  current = (async () => {
    let result;
    do {
      rerun = false;
      result = await runOnce();
    } while (rerun && enabled());
    return result;
  })();
  try {
    return await current;
  } finally {
    current = null;
  }
}

function onLocalChange() {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    syncNow().catch((err) => {
      console.error('Home Server background sync failed:', err.message);
    });
  }, 2000);
}

function start() {
  if (!enabled()) {
    emit(getState());
    return;
  }
  syncNow().catch((err) => {
    console.error('Home Server startup sync failed:', err.message);
  });
}

module.exports = {
  getState,
  syncNow,
  onLocalChange,
  onStatus,
  start,
};
