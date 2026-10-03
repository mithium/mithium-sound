// Loaded-clip hotkey decisions. No Electron, no Windows key injection.
//
// V and T play the phone-loaded clip from start to finish.
// When auto-hold is on (the default), one press is enough: the physical
// key-up is swallowed and the caller injects a fresh key-down after the
// hook returns, so the key stays down until the clip ends. Injecting during
// the key-up hook loses, because that physical key-up is delivered afterward
// and clears the key. Hard stop is Delete, the Windows Stop button, or Stop
// on the phone remote. Auto-hold off plays the clip and does not hold a key.
// A clip that finishes on its own, or a hard stop, unloads it. The next V or
// T does not play it again until a clip is loaded.

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
      // swallow: the global hook must eat this physical key-up. The service
      // injects the replacement key-down only after that hook has returned.
      return { type: 'reassert', key, swallow: true };
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

  function hardStop(opts = {}) {
    const key = takeRelease();
    // Delete and Stop unload. Pass { unload: false } when playback is stopping
    // only so the caller can store a different clip, or on quit.
    if (!opts || opts.unload !== false) loadedId = null;
    return { type: 'hard-stop', key };
  }

  function clipEnded() {
    if (!playbackActive && !simulatedKey) return { type: 'ignore', key: null };
    const key = takeRelease();
    loadedId = null;
    return { type: 'clip-ended', key };
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

function hookSwallowResult(decision) {
  if (decision && decision.swallow) return true;
  return undefined;
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
  hookSwallowResult,
  normalizeId,
};
