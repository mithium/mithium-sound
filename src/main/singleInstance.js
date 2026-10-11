// One Mithium Sound process. Electron's single-instance lock does not cross
// integrity levels, so an elevated copy and a normal copy both think they
// are the first. A lock in userData is visible to both.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCK_DIR_NAME = 'instance.lock';
const ALREADY_RUNNING_MESSAGE = 'Mithium Sound is already running. It may be running as administrator.';

function decideInstanceClaim({ gotElectronLock, peerBlocking }) {
  if (!gotElectronLock) return { action: 'exit-silent' };
  if (peerBlocking) return { action: 'message-exit', message: ALREADY_RUNNING_MESSAGE };
  return { action: 'continue' };
}

function defaultProcessState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    if (err && err.code === 'EPERM') return 'inaccessible';
    return 'dead';
  }
}

function defaultImageName(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    const line = String(out).split(/\r?\n/).map((row) => row.trim()).find((row) => row.startsWith('"'));
    if (!line || /no tasks are running/i.test(line)) return null;
    const match = /^"([^"]+)"/.exec(line);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function classifyPeer({ owner, currentPid, currentImage, processState, imageNameOf }) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return { blocking: false, reason: 'empty' };
  }
  if (owner.pid === currentPid) return { blocking: false, reason: 'self' };
  const state = processState(owner.pid);
  if (state === 'dead') return { blocking: false, reason: 'stale' };
  if (state === 'inaccessible') return { blocking: true, reason: 'inaccessible' };
  let image = null;
  if (typeof imageNameOf === 'function') {
    try {
      image = imageNameOf(owner.pid) || null;
    } catch {
      image = null;
    }
  }
  if (image && currentImage && image.toLowerCase() !== String(currentImage).toLowerCase()) {
    return { blocking: false, reason: 'different-image' };
  }
  return { blocking: true, reason: 'alive' };
}

function lockPaths(userDataDir) {
  const lockDir = path.join(userDataDir, LOCK_DIR_NAME);
  return { lockDir, ownerPath: path.join(lockDir, 'owner.json') };
}

function readOwner(ownerPath) {
  try {
    return { owner: JSON.parse(fs.readFileSync(ownerPath, 'utf8')), error: null };
  } catch (err) {
    return { owner: null, error: err };
  }
}

function acquireInstanceLock(userDataDir, owner, deps = {}) {
  const processState = deps.processState || defaultProcessState;
  const imageNameOf = deps.imageNameOf || defaultImageName;
  fs.mkdirSync(userDataDir, { recursive: true });
  const { lockDir, ownerPath } = lockPaths(userDataDir);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: owner.pid, image: owner.image || '' }));
      return { acquired: true };
    } catch (err) {
      if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
        return { acquired: false, blocking: true, reason: 'inaccessible' };
      }
      if (!err || err.code !== 'EEXIST') throw err;

      const read = readOwner(ownerPath);
      if (read.error && (read.error.code === 'EACCES' || read.error.code === 'EPERM')) {
        return { acquired: false, blocking: true, reason: 'inaccessible' };
      }
      if (!read.owner || typeof read.owner !== 'object') {
        let age = 0;
        try {
          age = Date.now() - fs.statSync(lockDir).mtimeMs;
        } catch {
          age = 0;
        }
        if (age > 5000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
        return { acquired: false, blocking: true, reason: 'starting' };
      }

      const peer = classifyPeer({
        owner: read.owner,
        currentPid: owner.pid,
        currentImage: owner.image,
        processState,
        imageNameOf,
      });
      if (!peer.blocking) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      return { acquired: false, blocking: true, reason: peer.reason, peer: read.owner };
    }
  }
  return { acquired: false, blocking: true, reason: 'busy' };
}

function releaseInstanceLock(userDataDir, pid) {
  const { lockDir, ownerPath } = lockPaths(userDataDir);
  try {
    const read = readOwner(ownerPath);
    if (!read.owner || read.owner.pid !== pid) return;
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Already gone, or not ours to remove.
  }
}

function claimElectronInstance(opts) {
  const gotElectronLock = opts.requestLock();
  if (!gotElectronLock) return { action: 'exit-silent' };
  let acquired = { acquired: true };
  try {
    acquired = acquireInstanceLock(opts.userDataDir, {
      pid: opts.pid,
      image: opts.imageName,
    }, {
      processState: opts.processState,
      imageNameOf: opts.imageNameOf,
    });
  } catch (err) {
    console.error('Instance lock failed:', err);
  }
  if (!acquired.acquired && acquired.blocking) {
    return { action: 'message-exit', message: ALREADY_RUNNING_MESSAGE };
  }
  if (typeof opts.onSecondInstance === 'function') {
    opts.onSecondInstance(() => {
      if (typeof opts.focus === 'function') opts.focus();
    });
  }
  return { action: 'continue' };
}

module.exports = {
  LOCK_DIR_NAME,
  ALREADY_RUNNING_MESSAGE,
  decideInstanceClaim,
  defaultProcessState,
  defaultImageName,
  classifyPeer,
  acquireInstanceLock,
  releaseInstanceLock,
  claimElectronInstance,
};
