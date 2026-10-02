const { createController, normalizeId } = require('./loadedClipControl');

let service = null;

function createLoadedClipService({ injector, getSounds, readSettings, writeSettings, hooks }) {
  const stored = readSettings ? readSettings() : {};
  const control = createController({
    loadedId: stored.loadedClipId,
    autoHold: stored.loadedClipAutoHold !== false,
  });

  function sounds() {
    try {
      return getSounds ? getSounds() : [];
    } catch {
      return [];
    }
  }

  function publicState() {
    const snap = control.snapshot();
    const match = snap.id == null ? null : sounds().find((sound) => sound.id === snap.id);
    return {
      id: match ? match.id : snap.id,
      name: match ? match.name : null,
      autoHold: snap.autoHold,
      simulating: snap.simulating,
      playbackActive: snap.playbackActive,
    };
  }

  function persist() {
    if (!writeSettings) return;
    const snap = control.snapshot();
    writeSettings({
      loadedClipId: snap.id,
      loadedClipAutoHold: snap.autoHold,
    });
  }

  function emit() {
    if (hooks && hooks.onState) hooks.onState(publicState());
  }

  async function releaseKey(key) {
    if (key && injector) await injector.keyUp(key);
  }

  async function releaseHold(opts = {}) {
    const decision = control.hardStop();
    await releaseKey(decision.key);
    emit();
    if (opts.stopAudio && hooks && hooks.onHardStop) {
      hooks.onHardStop({ notifyRenderer: !!opts.notifyRenderer });
    }
    return decision;
  }

  async function dropIfMissing() {
    const snap = control.snapshot();
    if (snap.id == null) return;
    if (sounds().some((sound) => sound.id === snap.id)) return;
    if (snap.playbackActive || snap.simulating) {
      await releaseHold({ stopAudio: true, notifyRenderer: true });
    }
    control.setLoaded(null);
    persist();
    emit();
  }

  return {
    publicState,
    emit,
    async setLoaded(id) {
      if (id != null && id !== '' && normalizeId(id) == null) {
        const error = new Error('Invalid clip id');
        error.status = 400;
        throw error;
      }
      const next = normalizeId(id);
      const snap = control.snapshot();
      if (snap.id === next) {
        emit();
        return publicState();
      }
      if (next != null && !sounds().some((sound) => sound.id === next)) {
        const error = new Error('Sound not found');
        error.status = 404;
        throw error;
      }
      if (snap.playbackActive || snap.simulating) {
        await releaseHold({ stopAudio: true, notifyRenderer: true });
      }
      control.setLoaded(next);
      persist();
      emit();
      return publicState();
    },
    async setAutoHold(enabled) {
      const result = control.setAutoHold(enabled);
      await releaseKey(result.releaseKey);
      persist();
      emit();
      return publicState();
    },
    keyDown(key) {
      const snap = control.snapshot();
      if (snap.id != null && !sounds().some((sound) => sound.id === snap.id)) {
        dropIfMissing();
        return { type: 'ignore' };
      }
      const decision = control.arm(key);
      if (decision.type === 'play') emit();
      return decision;
    },
    keyUp(key) {
      const decision = control.keyUp(key);
      if (decision.type === 'reassert' && injector) {
        injector.keyDown(decision.key);
      }
      return decision;
    },
    async hardStop(opts = {}) {
      return releaseHold({
        stopAudio: true,
        notifyRenderer: !!opts.notifyRenderer,
      });
    },
    async clipEnded() {
      const decision = control.clipEnded();
      await releaseKey(decision.key);
      emit();
      return decision;
    },
    async playFailed() {
      const decision = control.playFailed();
      await releaseKey(decision.key);
      emit();
      if (hooks && hooks.onHardStop) hooks.onHardStop({ notifyRenderer: false });
      return decision;
    },
    async onLibraryChanged() {
      await dropIfMissing();
    },
    async shutdown() {
      const decision = control.hardStop();
      if (decision.key) await releaseKey(decision.key);
    },
  };
}

function init(opts) {
  service = createLoadedClipService(opts);
  return service;
}

function getService() {
  return service;
}

function getPublicState() {
  if (!service) {
    return { id: null, name: null, autoHold: true, simulating: null, playbackActive: false };
  }
  return service.publicState();
}

module.exports = {
  createLoadedClipService,
  init,
  getService,
  getPublicState,
};
