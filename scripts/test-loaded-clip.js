#!/usr/bin/env node
// Loaded-clip hotkey decisions. No Electron required.
//   node scripts/test-loaded-clip.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createController,
  classifyGlobalEvent,
  hookSwallowResult,
} = require('../src/main/loadedClipControl');
const { createLoadedClipService } = require('../src/main/loadedClip');
const {
  injectionScript,
  KEYEVENTF_KEYUP,
  KEYEVENTF_SCANCODE,
} = require('../src/main/winKeyHold');

function flushImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

function fakeInjector() {
  const events = [];
  return {
    events,
    keyDown(name) {
      events.push(['down', name]);
      return Promise.resolve();
    },
    keyUp(name) {
      events.push(['up', name]);
      return Promise.resolve();
    },
    releaseAll() {
      events.push(['release-all']);
      return Promise.resolve();
    },
  };
}

(async () => {
  await test('auto-hold defaults on', () => {
    const control = createController();
    assert.strictEqual(control.snapshot().autoHold, true);
    assert.strictEqual(control.snapshot().id, null);
  });

  await test('explicit auto-hold off is preserved', () => {
    const control = createController({ autoHold: false, loadedId: 4 });
    assert.strictEqual(control.snapshot().autoHold, false);
    assert.strictEqual(control.snapshot().id, 4);
  });

  await test('V or T with nothing loaded stays on the legacy armed-clip path', () => {
    const control = createController();
    assert.strictEqual(control.arm('v').type, 'legacy');
    assert.strictEqual(control.arm('t').type, 'legacy');
    assert.strictEqual(control.keyUp('v').type, 'legacy');
  });

  await test('one press arms a full play and keyup asks to re-hold V', () => {
    const control = createController({ loadedId: 7 });
    const play = control.arm('v');
    assert.strictEqual(play.type, 'play');
    assert.strictEqual(play.simulate, true);
    assert.strictEqual(play.key, 'v');
    assert.strictEqual(control.arm('t').type, 'ignore');
    assert.deepStrictEqual(control.keyUp('v'), { type: 'reassert', key: 'v', swallow: true });
    assert.strictEqual(hookSwallowResult(control.keyUp('v')), true);
    assert.strictEqual(control.snapshot().simulating, 'v');
  });

  await test('auto-hold off plays without a simulated key', () => {
    const control = createController({ loadedId: 7, autoHold: false });
    const play = control.arm('t');
    assert.strictEqual(play.simulate, false);
    assert.strictEqual(control.snapshot().simulating, null);
    assert.strictEqual(control.keyUp('t').type, 'ignore');
  });

  await test('hard stop releases whichever key was held and unloads the clip', async () => {
    const control = createController({ loadedId: 3 });
    control.arm('t');
    assert.deepStrictEqual(control.hardStop(), { type: 'hard-stop', key: 't' });
    assert.strictEqual(control.snapshot().simulating, null);
    assert.strictEqual(control.snapshot().playbackActive, false);
    assert.strictEqual(control.snapshot().id, null);
    assert.strictEqual(control.arm('t').type, 'legacy');
    assert.strictEqual(control.arm('v').type, 'legacy');
    const ack = control.keyUp('t');
    assert.strictEqual(ack.type, 'release-ack');
    assert.ok(!ack.swallow);
    assert.strictEqual(hookSwallowResult(ack), undefined);
  });

  await test('hard stop before a press still unloads the armed clip', () => {
    const control = createController({ loadedId: 3 });
    assert.deepStrictEqual(control.hardStop(), { type: 'hard-stop', key: null });
    assert.strictEqual(control.snapshot().id, null);
    assert.strictEqual(control.arm('v').type, 'legacy');
  });

  await test('stopping playback without unload keeps the clip armed', () => {
    const control = createController({ loadedId: 3 });
    control.arm('v');
    assert.deepStrictEqual(control.hardStop({ unload: false }), { type: 'hard-stop', key: 'v' });
    assert.strictEqual(control.snapshot().id, 3);
    assert.strictEqual(control.snapshot().playbackActive, false);
    assert.strictEqual(control.snapshot().simulating, null);
  });

  await test('clip end releases the simulated key and unloads the clip', () => {
    const control = createController({ loadedId: 3 });
    control.arm('v');
    assert.deepStrictEqual(control.clipEnded(), { type: 'clip-ended', key: 'v' });
    assert.strictEqual(control.snapshot().id, null);
    assert.strictEqual(control.snapshot().playbackActive, false);
    assert.strictEqual(control.snapshot().simulating, null);
    assert.strictEqual(control.clipEnded().type, 'ignore');
    assert.strictEqual(control.arm('v').type, 'legacy');
    assert.strictEqual(control.arm('t').type, 'legacy');
  });

  await test('clip end with auto-hold off unloads and does not invent a held key', () => {
    const control = createController({ loadedId: 8, autoHold: false });
    const play = control.arm('t');
    assert.strictEqual(play.simulate, false);
    assert.deepStrictEqual(control.clipEnded(), { type: 'clip-ended', key: null });
    assert.strictEqual(control.snapshot().id, null);
    assert.strictEqual(control.snapshot().autoHold, false);
    assert.strictEqual(control.arm('t').type, 'legacy');
  });

  await test('a clip end that is not playing leaves the loaded clip armed', () => {
    const control = createController({ loadedId: 3 });
    assert.deepStrictEqual(control.clipEnded(), { type: 'ignore', key: null });
    assert.strictEqual(control.snapshot().id, 3);
    assert.strictEqual(control.arm('v').type, 'play');
  });

  await test('a failed play releases the key and leaves the clip loaded', () => {
    const control = createController({ loadedId: 3 });
    control.arm('v');
    assert.deepStrictEqual(control.playFailed(), { type: 'play-failed', key: 'v' });
    assert.strictEqual(control.snapshot().id, 3);
    assert.strictEqual(control.snapshot().playbackActive, false);
    assert.strictEqual(control.arm('v').id, 3);
  });

  await test('turning auto-hold off releases a held key and leaves playback running', () => {
    const control = createController({ loadedId: 3 });
    control.arm('v');
    assert.deepStrictEqual(control.setAutoHold(false), { releaseKey: 'v' });
    assert.strictEqual(control.snapshot().simulating, null);
    assert.strictEqual(control.snapshot().playbackActive, true);
    assert.strictEqual(control.snapshot().autoHold, false);
  });

  await test('global events map V, T, and Delete, and ignore mouse buttons and B', () => {
    assert.deepStrictEqual(classifyGlobalEvent({ name: 'V', state: 'DOWN' }), {
      kind: 'key', key: 'v', down: true,
    });
    assert.deepStrictEqual(classifyGlobalEvent({ name: 'T', state: 'UP' }), {
      kind: 'key', key: 't', down: false,
    });
    assert.deepStrictEqual(classifyGlobalEvent({ name: 'DELETE', state: 'DOWN' }), {
      kind: 'key', key: 'Delete', down: true,
    });
    assert.strictEqual(classifyGlobalEvent({ name: 'MOUSE LEFT', state: 'DOWN' }), null);
    assert.strictEqual(classifyGlobalEvent({ name: 'MOUSE RIGHT', state: 'DOWN' }), null);
    assert.strictEqual(classifyGlobalEvent({ name: 'B', state: 'DOWN' }), null);
    assert.strictEqual(classifyGlobalEvent({ vKey: 1, state: 'DOWN' }), null);
  });

  await test('service sends a real key-up on hard stop and a key-down when re-holding', async () => {
    const injector = fakeInjector();
    const stops = [];
    const service = createLoadedClipService({
      injector,
      getSounds: () => [{ id: 9, name: 'Horn' }],
      readSettings: () => ({}),
      writeSettings: () => {},
      hooks: { onHardStop: (opts) => stops.push(opts), onState: () => {} },
    });
    assert.strictEqual(service.publicState().autoHold, true);
    assert.strictEqual(service.publicState().name, null);
    service.setLoaded(9);
    assert.strictEqual(service.publicState().name, 'Horn');
    const play = service.keyDown('v');
    assert.strictEqual(play.type, 'play');
    assert.strictEqual(play.simulate, true);
    const up = service.keyUp('v');
    assert.strictEqual(up.type, 'reassert');
    assert.strictEqual(up.swallow, true);
    assert.deepStrictEqual(injector.events, []);
    await flushImmediate();
    assert.deepStrictEqual(injector.events, [['down', 'v']]);
    await service.hardStop({ notifyRenderer: true });
    assert.deepStrictEqual(injector.events, [['down', 'v'], ['up', 'v']]);
    await flushImmediate();
    assert.deepStrictEqual(injector.events, [['down', 'v'], ['up', 'v']]);
    assert.deepStrictEqual(stops, [{ notifyRenderer: true }]);
    assert.strictEqual(service.publicState().simulating, null);
    assert.strictEqual(service.publicState().id, null);
    assert.strictEqual(service.keyDown('v').type, 'legacy');
    assert.strictEqual(service.keyDown('t').type, 'legacy');
  });

  await test('saved auto-hold off is restored and does not inject a key', async () => {
    const injector = fakeInjector();
    const service = createLoadedClipService({
      injector,
      getSounds: () => [{ id: 2, name: 'Beep' }],
      readSettings: () => ({ loadedClipId: 2, loadedClipAutoHold: false }),
      writeSettings: () => {},
      hooks: { onState: () => {} },
    });
    assert.strictEqual(service.publicState().autoHold, false);
    assert.strictEqual(service.publicState().id, 2);
    const play = service.keyDown('t');
    assert.strictEqual(play.simulate, false);
    assert.strictEqual(service.keyUp('t').type, 'ignore');
    assert.deepStrictEqual(injector.events, []);
    await service.hardStop({ notifyRenderer: false });
    assert.deepStrictEqual(injector.events, []);
    assert.strictEqual(service.publicState().id, null);
    assert.strictEqual(service.publicState().autoHold, false);
    assert.strictEqual(service.keyDown('t').type, 'legacy');
  });

  await test('hard stop before the deferred hold does not press the key again', async () => {
    const injector = fakeInjector();
    const service = createLoadedClipService({
      injector,
      getSounds: () => [{ id: 9, name: 'Horn' }],
      readSettings: () => ({ loadedClipId: 9 }),
      writeSettings: () => {},
      hooks: { onHardStop: () => {}, onState: () => {} },
    });
    service.keyDown('v');
    assert.strictEqual(service.keyUp('v').swallow, true);
    await service.hardStop({ notifyRenderer: true });
    await flushImmediate();
    assert.deepStrictEqual(injector.events, [['up', 'v']]);
    assert.strictEqual(service.publicState().simulating, null);
    assert.strictEqual(service.publicState().playbackActive, false);
    assert.strictEqual(service.publicState().id, null);
    assert.strictEqual(service.keyDown('v').type, 'legacy');
  });

  await test('clip end after a press releases the key and does not re-hold it', async () => {
    const injector = fakeInjector();
    const service = createLoadedClipService({
      injector,
      getSounds: () => [{ id: 9, name: 'Horn' }],
      readSettings: () => ({ loadedClipId: 9 }),
      writeSettings: () => {},
      hooks: { onState: () => {} },
    });
    service.keyDown('t');
    service.keyUp('t');
    await flushImmediate();
    await service.clipEnded();
    await flushImmediate();
    assert.deepStrictEqual(injector.events, [['down', 't'], ['up', 't']]);
    assert.strictEqual(service.publicState().simulating, null);
    assert.strictEqual(service.publicState().id, null);
    assert.strictEqual(service.keyDown('t').type, 'legacy');
    assert.strictEqual(service.keyDown('v').type, 'legacy');
  });

  await test('a finished clip is persisted unloaded and can be loaded again', async () => {
    const injector = fakeInjector();
    const saved = [];
    const service = createLoadedClipService({
      injector,
      getSounds: () => [{ id: 9, name: 'Horn' }],
      readSettings: () => ({ loadedClipId: 9, loadedClipAutoHold: true }),
      writeSettings: (partial) => saved.push(partial),
      hooks: { onState: () => {} },
    });
    service.keyDown('v');
    service.keyUp('v');
    await flushImmediate();
    await service.clipEnded();
    assert.strictEqual(service.publicState().id, null);
    assert.strictEqual(service.publicState().name, null);
    assert.strictEqual(service.publicState().autoHold, true);
    assert.strictEqual(service.publicState().playbackActive, false);
    assert.ok(saved.some((partial) => partial.loadedClipId == null && partial.loadedClipAutoHold === true));
    assert.strictEqual(service.keyDown('v').type, 'legacy');
    await service.setLoaded(9);
    const again = service.keyDown('v');
    assert.strictEqual(again.type, 'play');
    assert.strictEqual(again.id, 9);
    assert.strictEqual(again.simulate, true);
  });

  await test('Delete or Stop unloads a clip that was not playing and remembers that', async () => {
    const saved = [];
    const service = createLoadedClipService({
      injector: fakeInjector(),
      getSounds: () => [{ id: 9, name: 'Horn' }],
      readSettings: () => ({ loadedClipId: 9, loadedClipAutoHold: true }),
      writeSettings: (partial) => saved.push(partial),
      hooks: { onHardStop: () => {}, onState: () => {} },
    });
    await service.hardStop({ notifyRenderer: true });
    assert.strictEqual(service.publicState().id, null);
    assert.strictEqual(service.keyDown('t').type, 'legacy');
    assert.deepStrictEqual(saved[saved.length - 1], {
      loadedClipId: null,
      loadedClipAutoHold: true,
    });
  });

  await test('loading a different clip while one is playing keeps the new clip armed', async () => {
    const service = createLoadedClipService({
      injector: fakeInjector(),
      getSounds: () => [{ id: 9, name: 'Horn' }, { id: 4, name: 'Bell' }],
      readSettings: () => ({ loadedClipId: 9 }),
      writeSettings: () => {},
      hooks: { onHardStop: () => {}, onState: () => {} },
    });
    assert.strictEqual(service.keyDown('v').type, 'play');
    await service.setLoaded(4);
    assert.strictEqual(service.publicState().id, 4);
    assert.strictEqual(service.publicState().name, 'Bell');
    assert.strictEqual(service.publicState().playbackActive, false);
    assert.strictEqual(service.publicState().simulating, null);
    const play = service.keyDown('t');
    assert.strictEqual(play.type, 'play');
    assert.strictEqual(play.id, 4);
    assert.strictEqual(play.simulate, true);
  });

  await test('a failed play releases the hold and leaves the clip loaded for another press', async () => {
    const injector = fakeInjector();
    const stops = [];
    const service = createLoadedClipService({
      injector,
      getSounds: () => [{ id: 9, name: 'Horn' }],
      readSettings: () => ({ loadedClipId: 9 }),
      writeSettings: () => {},
      hooks: { onHardStop: (opts) => stops.push(opts), onState: () => {} },
    });
    service.keyDown('v');
    service.keyUp('v');
    await flushImmediate();
    await service.playFailed();
    assert.deepStrictEqual(injector.events, [['down', 'v'], ['up', 'v']]);
    assert.strictEqual(service.publicState().id, 9);
    assert.strictEqual(service.publicState().simulating, null);
    assert.deepStrictEqual(stops, [{ notifyRenderer: false }]);
    const retry = service.keyDown('v');
    assert.strictEqual(retry.type, 'play');
    assert.strictEqual(retry.id, 9);
  });

  await test('scan-code hold is injected, and the hook package is left in place', () => {
    assert.strictEqual(KEYEVENTF_SCANCODE, 0x0008);
    assert.strictEqual(KEYEVENTF_KEYUP, 0x0002);
    assert.ok(injectionScript.includes('MapVirtualKey'));
    assert.ok(injectionScript.includes('keybd_event'));
    assert.ok(injectionScript.includes(`[uint32]${KEYEVENTF_SCANCODE}`));
    assert.ok(injectionScript.includes(`[uint32]${KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP}`));
    assert.ok(!injectionScript.includes('[uint32]0'));
    assert.ok(!injectionScript.includes('SendInput'));
    const root = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const index = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
    const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    assert.ok(pkg.dependencies['node-global-key-listener']);
    assert.ok(index.includes('node-global-key-listener'));
    assert.ok(index.includes('hookSwallowResult'));
    assert.ok(index.includes('if (hookSwallowResult(decision)) return true;'));
    assert.ok(index.includes('keyHold.warm()'));
    assert.ok(index.includes('keyHold.close()'));
    assert.ok(!index.includes('requireAdministrator'));
    assert.ok(builder.includes('node-global-key-listener'));
    assert.ok(!index.includes("name === 'B'"));
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
  console.log(`${passed} passed`);
})();
