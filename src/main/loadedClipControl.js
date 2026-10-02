// Loaded-clip hotkey decisions. No Electron, no Windows key injection.
//
// V and T play the phone-loaded clip from start to finish.
// When auto-hold is on (the default), the matching key is treated as held
// until the clip ends or a hard stop releases it. Physical keyup does not
// stop playback; the caller re-asserts the key-down so Windows stays held.
// Hard stop is Delete, the Windows Stop button, or Stop on the phone remote.

function createController(initial = {}) {
  let loadedId = normalizeId(initial.loadedId);
  let autoHold = initial.autoHold !== false;
  let simulatedKey = null;
  let playbackActive = false;
  let releasing = null;

  function snapshot() {
    return {
      id: loadedId,
      autoHold,
      simulating: simulatedKey,
      playbackActive,
    };
  }

  function setLoaded(id) {
    loadedId = normalizeId(id);
  }

  function setAutoHold(enabled) {
    const next = !!enabled;
    const releaseKey = !next && simulatedKey ? simulatedKey : null;
    autoHold = next;
    if (releaseKey) {
      releasing = releaseKey;
      simulatedKey = null;
    }
    return { releaseKey };
  }

  function arm(key) {
    if (key !== 'v' && key !== 't') return { type: 'ignore' };
    if (loadedId == null) return { type: 'legacy' };
    if (playbackActive) return { type: 'ignore' };
    playbackActive = true;
    if (autoHold) simulatedKey = key;
    return { type: 'play', id: loadedId, key, simulate: autoHold };
  }

  function keyUp(key) {
    if (releasing === key) {
      releasing = null;
      return { type: 'release-ack', key };
    }
    if (autoHold && simulatedKey === key) {
      return { type: 'reassert', key };
    }
    if (loadedId == null) return { type: 'legacy', key };
    return { type: 'ignore', key };
  }

  function takeRelease() {
    const key = simulatedKey;
    simulatedKey = null;
    playbackActive = false;
    if (key) releasing = key;
    return key;
  }

  function hardStop() {
    return { type: 'hard-stop', key: takeRelease() };
  }

  function clipEnded() {
    if (!playbackActive && !simulatedKey) return { type: 'ignore', key: null };
    return { type: 'clip-ended', key: takeRelease() };
  }

  function playFailed() {
    return { type: 'play-failed', key: takeRelease() };
  }

  return {
    snapshot,
    setLoaded,
    setAutoHold,
    arm,
    keyUp,
    hardStop,
    clipEnded,
    playFailed,
  };
}

function normalizeId(id) {
  if (id == null || id === '') return null;
  const number = Number(id);
  if (!Number.isFinite(number)) return null;
  return number;
}

function classifyGlobalEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const name = event.name || '';
  const down = event.state === 'DOWN';
  if (name === 'V' || name === 'T' || name === 'DELETE') {
    return {
      kind: 'key',
      key: name === 'DELETE' ? 'Delete' : name.toLowerCase(),
      down,
    };
  }
  return null;
}

module.exports = {
  createController,
  classifyGlobalEvent,
  normalizeId,
};
