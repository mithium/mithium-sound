#!/usr/bin/env node
// Single-instance decisions and the installer quit flag. No Electron required.
//   node scripts/test-single-instance.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  ALREADY_RUNNING_MESSAGE,
  decideInstanceClaim,
  classifyPeer,
  acquireInstanceLock,
  releaseInstanceLock,
  claimElectronInstance,
  defaultProcessState,
} = require('../src/main/singleInstance');
const {
  FLAG_NAME,
  quitFlagPath,
  shouldQuitForInstall,
  watchQuitFlag,
} = require('../src/main/installQuit');

let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-instance-'));
}

(async () => {
  await test('a second launch at the same integrity level exits so the first can show its window', () => {
    const decision = decideInstanceClaim({ gotElectronLock: false, peerBlocking: false });
    assert.strictEqual(decision.action, 'exit-silent');
  });

  await test('an elevated peer shows a plain already-running message', () => {
    const decision = decideInstanceClaim({ gotElectronLock: true, peerBlocking: true });
    assert.strictEqual(decision.action, 'message-exit');
    assert.strictEqual(decision.message, ALREADY_RUNNING_MESSAGE);
    assert.match(decision.message, /already running/);
    assert.match(decision.message, /administrator/);
  });

  await test('the first launch continues', () => {
    assert.strictEqual(decideInstanceClaim({ gotElectronLock: true, peerBlocking: false }).action, 'continue');
  });

  await test('classifyPeer blocks a live or inaccessible copy and ignores a dead or foreign pid', () => {
    const base = { currentPid: 10, currentImage: 'Mithium Sound.exe' };
    assert.strictEqual(classifyPeer({
      ...base,
      owner: { pid: 20, image: 'Mithium Sound.exe' },
      processState: () => 'alive',
      imageNameOf: () => 'Mithium Sound.exe',
    }).blocking, true);
    assert.strictEqual(classifyPeer({
      ...base,
      owner: { pid: 20 },
      processState: () => 'inaccessible',
      imageNameOf: () => null,
    }).reason, 'inaccessible');
    assert.strictEqual(classifyPeer({
      ...base,
      owner: { pid: 20 },
      processState: () => 'dead',
    }).blocking, false);
    assert.strictEqual(classifyPeer({
      ...base,
      owner: { pid: 20 },
      processState: () => 'alive',
      imageNameOf: () => 'node.exe',
    }).reason, 'different-image');
    assert.strictEqual(classifyPeer({
      ...base,
      owner: { pid: 10 },
      processState: () => 'alive',
    }).reason, 'self');
  });

  await test('the file lock lets one process through and blocks a live peer', () => {
    const dir = tempDir();
    const first = acquireInstanceLock(dir, { pid: 111, image: 'Mithium Sound.exe' }, {
      processState: () => 'alive',
      imageNameOf: () => 'Mithium Sound.exe',
    });
    assert.strictEqual(first.acquired, true);
    const second = acquireInstanceLock(dir, { pid: 222, image: 'Mithium Sound.exe' }, {
      processState: (pid) => (pid === 111 ? 'alive' : 'dead'),
      imageNameOf: () => 'Mithium Sound.exe',
    });
    assert.strictEqual(second.acquired, false);
    assert.strictEqual(second.blocking, true);
    assert.strictEqual(second.reason, 'alive');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('a dead peer loses the lock to the next launch', () => {
    const dir = tempDir();
    acquireInstanceLock(dir, { pid: 111, image: 'Mithium Sound.exe' }, {
      processState: () => 'alive',
      imageNameOf: () => 'Mithium Sound.exe',
    });
    const next = acquireInstanceLock(dir, { pid: 222, image: 'Mithium Sound.exe' }, {
      processState: () => 'dead',
      imageNameOf: () => null,
    });
    assert.strictEqual(next.acquired, true);
    releaseInstanceLock(dir, 222);
    const ownerPath = path.join(dir, 'instance.lock', 'owner.json');
    assert.strictEqual(fs.existsSync(ownerPath), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('an inaccessible peer is reported as already running', () => {
    const dir = tempDir();
    acquireInstanceLock(dir, { pid: 111, image: 'Mithium Sound.exe' });
    const events = [];
    const decision = claimElectronInstance({
      requestLock: () => true,
      onSecondInstance: (handler) => events.push(handler),
      focus: () => events.push('focus'),
      userDataDir: dir,
      pid: 333,
      imageName: 'Mithium Sound.exe',
      processState: () => 'inaccessible',
      imageNameOf: () => null,
    });
    assert.strictEqual(decision.action, 'message-exit');
    assert.strictEqual(events.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('claim focuses the existing window when Electron already owns the lock', () => {
    let focused = false;
    const decision = claimElectronInstance({
      requestLock: () => false,
      onSecondInstance: () => { throw new Error('second instance must not register a handler'); },
      focus: () => { focused = true; },
      userDataDir: tempDir(),
      pid: 1,
      imageName: 'Mithium Sound.exe',
    });
    assert.strictEqual(decision.action, 'exit-silent');
    assert.strictEqual(focused, false);
  });

  await test('the first claim registers the focus handler', () => {
    const dir = tempDir();
    let handler = null;
    let focused = false;
    const decision = claimElectronInstance({
      requestLock: () => true,
      onSecondInstance: (fn) => { handler = fn; },
      focus: () => { focused = true; },
      userDataDir: dir,
      pid: 50,
      imageName: 'Mithium Sound.exe',
      processState: () => 'dead',
      imageNameOf: () => null,
    });
    assert.strictEqual(decision.action, 'continue');
    assert.strictEqual(typeof handler, 'function');
    handler();
    assert.strictEqual(focused, true);
    releaseInstanceLock(dir, 50);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('a real live pid blocks, and a dead pid does not', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const dir = tempDir();
    try {
      const held = acquireInstanceLock(dir, { pid: child.pid, image: 'node' }, {
        imageNameOf: () => null,
      });
      assert.strictEqual(held.acquired, true);
      assert.strictEqual(defaultProcessState(child.pid), 'alive');
      const blocked = acquireInstanceLock(dir, { pid: process.pid, image: 'node' }, {
        imageNameOf: () => null,
      });
      assert.strictEqual(blocked.blocking, true);
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      const again = acquireInstanceLock(dir, { pid: process.pid, image: 'node' }, {
        imageNameOf: () => null,
      });
      assert.strictEqual(again.acquired, true);
      releaseInstanceLock(dir, process.pid);
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('a fresh installer flag quits once, and a stale flag does not', async () => {
    const dir = tempDir();
    const flag = quitFlagPath(dir);
    assert.strictEqual(path.basename(flag), FLAG_NAME);
    assert.strictEqual(shouldQuitForInstall(flag), false);

    fs.writeFileSync(flag, 'quit');
    let quit = false;
    const stop = watchQuitFlag(dir, () => { quit = true; }, { intervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    assert.strictEqual(quit, true);
    assert.strictEqual(fs.existsSync(flag), false);

    fs.writeFileSync(flag, 'quit');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(flag, old, old);
    assert.strictEqual(shouldQuitForInstall(flag), false);
    assert.strictEqual(fs.existsSync(flag), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  if (process.exitCode) {
    console.error('single instance tests failed');
    process.exit(process.exitCode);
  }
  console.log(`${passed} passed`);
})();
