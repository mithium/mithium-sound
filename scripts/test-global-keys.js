#!/usr/bin/env node
// Global hotkey decisions and the Windows poller protocol.
// No Electron and no Windows session required.
//   node scripts/test-global-keys.js
//
// Manual check on Windows (this script cannot press keys):
// 1. Install the build and confirm resources/ has no WinKeyServer.exe and no
//    node-global-key-listener directory.
// 2. Unfocused or hidden to the tray: V/T play a loaded clip and auto-hold
//    keeps the key down after release. Delete stops and releases it.
// 3. Nothing loaded: armed-clip hold-to-play follows V/T down and up. Tap
//    mode plays once per press.
// 4. Repeat V, T, and Delete while a fullscreen game is focused.
// 5. Tray → Quit while V or T is held. The simulated key releases, and Task
//    Manager shows no leftover powershell.exe from Mithium Sound.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  WATCHED,
  buildPollScript,
  decodeCommand,
  pollerLaunch,
  powershellExe,
  edgesFromMasks,
  decideGlobalHotkey,
  globalHotkeyAction,
  planQuit,
  createGlobalKeyListener,
} = require('../src/main/globalHotkeys');

const root = path.join(__dirname, '..');
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

function bit(name) {
  const index = WATCHED.findIndex((key) => key.name === name);
  assert.ok(index >= 0, name);
  return 1 << index;
}

function actionFor(previous, next, context) {
  return edgesFromMasks(previous, next).map((item) => (
    globalHotkeyAction(decideGlobalHotkey(item.event, item.down, context))
  ));
}

function fakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    proc.emit('exit', 0);
  };
  return proc;
}

function silentListener(extra) {
  const logs = [];
  const errors = [];
  let child = null;
  const listener = createGlobalKeyListener({
    platform: 'win32',
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    spawn: () => {
      child = fakeChild();
      return child;
    },
    ...extra,
  });
  return { listener, logs, errors, get child() { return child; } };
}

(async () => {
  await test('poller uses signed powershell and GetAsyncKeyState, not a keyboard hook', () => {
    assert.strictEqual(powershellExe({}), 'powershell.exe');
    assert.strictEqual(
      powershellExe({ SystemRoot: 'C:\\Windows' }),
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    const launch = pollerLaunch({ SystemRoot: 'C:\\Windows' });
    assert.strictEqual(launch.command, powershellExe({ SystemRoot: 'C:\\Windows' }));
    assert.ok(launch.args.includes('-EncodedCommand'));
    assert.ok(!launch.args.includes('-Command'));
    const encoded = launch.args[launch.args.indexOf('-EncodedCommand') + 1];
    assert.strictEqual(decodeCommand(encoded), launch.script);
    assert.strictEqual(launch.script, buildPollScript());
    assert.ok(launch.script.includes('GetAsyncKeyState'));
    assert.ok(launch.script.includes('[Console]::Out.WriteLine'));
    assert.ok(launch.script.includes('0x56,0x54,0x2E'));
    assert.ok(!launch.script.includes('SetWindowsHookEx'));
    assert.ok(!launch.script.includes('keybd_event'));
    assert.ok(!/WinKey/i.test(launch.script));
  });

  await test('V down then up is a press and a release, including for hold-to-play', () => {
    const ctx = { focused: false };
    assert.deepStrictEqual(actionFor(0, bit('V'), ctx), [{ type: 'keydown', key: 'v' }]);
    assert.deepStrictEqual(actionFor(bit('V'), 0, ctx), [{ type: 'keyup', key: 'v' }]);
    assert.deepStrictEqual(actionFor(0, bit('T'), ctx), [{ type: 'keydown', key: 't' }]);
    assert.deepStrictEqual(actionFor(bit('T'), 0, ctx), [{ type: 'keyup', key: 't' }]);
    assert.deepStrictEqual(edgesFromMasks(bit('V'), bit('V')), []);
  });

  await test('Delete down stops and Delete up does not', () => {
    const ctx = { focused: false };
    assert.deepStrictEqual(actionFor(0, bit('DELETE'), ctx), [{ type: 'hard-stop' }]);
    assert.deepStrictEqual(actionFor(bit('DELETE'), 0, ctx), [null]);
  });

  await test('modifier chords, focus, mouse, and other keys do not dispatch', () => {
    const chord = bit('V') | bit('LEFT SHIFT');
    assert.deepStrictEqual(actionFor(0, chord, { focused: false }), [null, null]);
    assert.deepStrictEqual(actionFor(0, bit('V'), { focused: true }), [null]);
    assert.strictEqual(decideGlobalHotkey(
      { name: 'MOUSE LEFT', state: 'DOWN' },
      {},
      { focused: false },
    ), null);
    assert.strictEqual(decideGlobalHotkey(
      { name: 'B', state: 'DOWN' },
      {},
      { focused: false },
    ), null);
  });

  await test('a re-injected V down during auto-hold is not a second press, but release still is', () => {
    const holding = { focused: false, playbackActive: true, simulating: 'v' };
    assert.deepStrictEqual(actionFor(0, bit('V'), holding), [null]);
    assert.deepStrictEqual(actionFor(bit('V'), 0, holding), [{ type: 'keyup', key: 'v' }]);
    assert.deepStrictEqual(actionFor(0, bit('T'), holding), [{ type: 'keydown', key: 't' }]);
  });

  await test('quit always stops hotkeys and delays only to release a simulated key', () => {
    assert.deepStrictEqual(planQuit({ quitReleaseStarted: false, simulating: false }), {
      delayForRelease: false,
    });
    assert.deepStrictEqual(planQuit({ quitReleaseStarted: false, simulating: true }), {
      delayForRelease: true,
    });
    assert.deepStrictEqual(planQuit({ quitReleaseStarted: true, simulating: true }), {
      delayForRelease: false,
    });
  });

  await test('poller turns masks into one edge and stops on kill', () => {
    const seen = [];
    const harness = silentListener();
    harness.listener.addListener((event, down) => {
      seen.push([event.name, event.state, !!down.V]);
    });
    harness.child.stdout.emit('data', 'rea');
    harness.child.stdout.emit('data', 'dy\n0\r\n');
    harness.child.stdout.emit('data', '1');
    harness.child.stdout.emit('data', '\n');
    assert.deepStrictEqual(seen, [['V', 'DOWN', true]]);
    assert.ok(harness.logs.some((line) => line.includes('armed for V, T, and Delete')));

    harness.child.stdout.emit('data', '0\n4\n');
    assert.deepStrictEqual(seen, [
      ['V', 'DOWN', true],
      ['V', 'UP', false],
      ['DELETE', 'DOWN', false],
    ]);

    harness.listener.kill();
    assert.strictEqual(harness.child.killed, true);
    harness.child.stdout.emit('data', '1\n');
    assert.strictEqual(seen.length, 3);
  });

  await test('a key already held when the poller starts does not fire until it changes', () => {
    const seen = [];
    const harness = silentListener();
    harness.listener.addListener((event) => seen.push(event.state));
    harness.child.stdout.emit('data', 'ready\n1\n0\n');
    assert.deepStrictEqual(seen, ['UP']);
  });

  await test('linux does not spawn a poller, and a failed spawn is reported', () => {
    let spawned = false;
    const listener = createGlobalKeyListener({
      platform: 'linux',
      log: () => {},
      logError: () => {},
      spawn: () => {
        spawned = true;
        return fakeChild();
      },
    });
    assert.strictEqual(spawned, false);
    listener.kill();

    const errors = [];
    const broken = createGlobalKeyListener({
      platform: 'win32',
      log: () => {},
      logError: (message) => errors.push(message),
      spawn: () => {
        throw new Error('powershell missing');
      },
    });
    broken.kill();
    assert.ok(errors.some((line) => line.includes('powershell missing')));
  });

  await test('a listener exception does not stop later key events', () => {
    const seen = [];
    const harness = silentListener();
    harness.listener.addListener(() => {
      throw new Error('renderer gone');
    });
    harness.listener.addListener((event) => seen.push(event.name));
    harness.child.stdout.emit('data', 'ready\n0\n1\n');
    assert.deepStrictEqual(seen, ['V']);
    assert.ok(harness.errors.some((line) => line.includes('renderer gone')));
  });

  await test('packaging and main process do not vendor the old hook executable', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
    const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    const index = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
    assert.ok(!pkg.dependencies['node-global-key-listener']);
    assert.ok(!(pkg.devDependencies && pkg.devDependencies['node-global-key-listener']));
    assert.strictEqual(pkg.scripts['test:global-keys'], 'node scripts/test-global-keys.js');
    for (const text of [lock, builder, index]) {
      assert.ok(!text.includes('node-global-key-listener'));
      assert.ok(!text.includes('WinKeyServer'));
    }
    assert.ok(!lock.includes('sudo-prompt'));
    assert.ok(index.includes("require('./globalHotkeys')"));
    assert.ok(!index.includes('GlobalKeyboardListener'));
    const quitAt = index.indexOf("app.on('before-quit'");
    const quitFn = index.slice(quitAt, index.indexOf("app.on('window-all-closed'"));
    const stopAt = quitFn.indexOf('unregisterGlobalShortcuts()');
    const delayAt = quitFn.indexOf('plan.delayForRelease');
    assert.ok(stopAt !== -1 && delayAt !== -1 && stopAt < delayAt);
    assert.ok(quitFn.includes('keyHold.close()'));
    assert.ok(quitFn.includes('keyHold.dispose()'));
    assert.ok(quitFn.indexOf('keyHold.close()') < quitFn.indexOf('keyHold.dispose()'));
    assert.ok(index.includes('unregisterGlobalShortcuts()'));
  });

  if (process.exitCode) process.exit(process.exitCode);
  console.log(`${passed} passed`);
  console.log('Manual Windows check is in the header of scripts/test-global-keys.js and src/main/globalHotkeys.js.');
})();
