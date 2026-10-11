// The installer cannot kill an elevated Mithium Sound, and closing the window
// only hides it to the tray. The installer writes this flag; the app quits itself.

const fs = require('fs');
const path = require('path');

const FLAG_NAME = 'quit-for-install';
const FRESH_MS = 120000;

function quitFlagPath(userDataDir) {
  return path.join(userDataDir, FLAG_NAME);
}

function shouldQuitForInstall(flagPath, now = Date.now(), fsImpl = fs) {
  let st;
  try {
    st = fsImpl.statSync(flagPath);
  } catch {
    return false;
  }
  const age = now - st.mtimeMs;
  try {
    fsImpl.unlinkSync(flagPath);
  } catch {
    // Still honor a fresh flag if another process already removed it.
  }
  if (!Number.isFinite(age) || age > FRESH_MS || age < -5000) return false;
  return true;
}

function watchQuitFlag(userDataDir, onQuit, opts = {}) {
  const flagPath = quitFlagPath(userDataDir);
  const fsImpl = opts.fs || fs;
  const intervalMs = opts.intervalMs || 400;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (shouldQuitForInstall(flagPath, Date.now(), fsImpl)) onQuit();
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  FLAG_NAME,
  FRESH_MS,
  quitFlagPath,
  shouldQuitForInstall,
  watchQuitFlag,
};
