#!/usr/bin/env node
// Loaded-clip hotkey decisions. No Electron required.
//   node scripts/test-loaded-clip.js

const assert = require('assert');
const {
  DOUBLE_CLICK_MS,
  createController,
  classifyGlobalEvent,
} = require('../src/main/loadedClipControl');
const { createLoadedClipService } = require('../src/main/loadedClip');

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
    assert.deepStrictEqual(control.keyUp('v'), { type: 'reassert', key: 'v' });
    assert.strictEqual(control.snapshot().simulating, 'v');
  });

  await test('auto-hold off plays without a simulated key', () => {
    const control = createController({ loadedId: 7, autoHold: false });
    const play = control.arm('t');
    assert.strictEqual(play.simulate, false);
    assert.strictEqual(control.snapshot().simulating, null);
    assert.strictEqual(control.keyUp('t').type, 'ignore');
  });

  await test('hard stop releases whichever key was held', async () => {
    const control = createController({ loadedId: 3 });
    control.arm('t');
    assert.deepStrictEqual(control.hardStop(), { type: 'hard-stop', key: 't' });
    assert.strictEqual(control.snapshot().simulating, null);
    assert.strictEqual(control.snapshot().playbackActive, false);
    assert.strictEqual(control.keyUp('t').type, 'release-ack');
  });

  await test('clip end releases the simulated key', () => {
    const control = createController({ loadedId: 3 });
    control.arm('v');
    assert.deepStrictEqual(control.clipEnded(), { type: 'clip-ended', key: 'v' });
    assert.strictEqual(control.clipEnded().type, 'ignore');
  });

  await test('turning auto-hold off releases a held key and leaves playback running', () => {
    const control = createController({ loadedId: 3 });
    control.arm('v');
    assert.deepStrictEqual(control.setAutoHold(false), { releaseKey: 'v' });
    assert.strictEqual(control.snapshot().simulating, null);
    assert.strictEqual(control.snapshot().playbackActive, true);
    assert.strictEqual(control.snapshot().autoHold, false);
  });

  await test('double-click is two downs of the same button within 500ms', () => {
    const control = createController({ loadedId: 1 });
    assert.strictEqual(DOUBLE_CLICK_MS, 500);
    assert.strictEqual(control.mouseDown('left', 1000).doubleClick, false);
    assert.strictEqual(control.mouseDown('right', 1200).doubleClick, false);
    assert.strictEqual(control.mouseDown('left', 1500).doubleClick, true);
    assert.strictEqual(control.mouseDown('left', 1500 + DOUBLE_CLICK_MS).doubleClick, false);
    assert.strictEqual(control.mouseDown('left', 1500 + DOUBLE_CLICK_MS + DOUBLE_CLICK_MS).doubleClick, true);
    assert.strictEqual(control.mouseDown('right', 4000).doubleClick, false);
    assert.strictEqual(control.mouseDown('right', 4000 + DOUBLE_CLICK_MS + 1).doubleClick, false);
  });

  await test('global events map V, T, Delete, and either mouse button, not B', () => {
    assert.deepStrictEqual(classifyGlobalEvent({ name: 'V', state: 'DOWN' }), {
      kind: 'key', key: 'v', down: true,
    });
    assert.deepStrictEqual(classifyGlobalEvent({ name: 'T', state: 'UP' }), {
      kind: 'key', key: 't', down: false,
    });
    assert.deepStrictEqual(classifyGlobalEvent({ name: 'DELETE', state: 'DOWN' }), {
      kind: 'key', key: 'Delete', down: true,
    });
    assert.deepStrictEqual(classifyGlobalEvent({ name: 'MOUSE LEFT', state: 'DOWN' }), {
      kind: 'mouse', button: 'left', down: true,
    });
    assert.deepStrictEqual(classifyGlobalEvent({ name: 'MOUSE RIGHT', state: 'DOWN' }), {
      kind: 'mouse', button: 'right', down: true,
    });
    assert.strictEqual(classifyGlobalEvent({ name: 'B', state: 'DOWN' }), null);
    assert.deepStrictEqual(classifyGlobalEvent({ vKey: 1, state: 'DOWN' }), {
      kind: 'mouse', button: 'left', down: true,
    });
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
    assert.strictEqual(service.keyUp('v').type, 'reassert');
    assert.deepStrictEqual(injector.events, [['down', 'v']]);
    await service.hardStop({ notifyRenderer: true });
    assert.deepStrictEqual(injector.events, [['down', 'v'], ['up', 'v']]);
    assert.deepStrictEqual(stops, [{ notifyRenderer: true }]);
    assert.strictEqual(service.snapshot ? service.publicState().simulating : service.publicState().simulating, null);
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
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
  console.log(`${passed} passed`);
})();
