#!/usr/bin/env node
// Saved output and microphone devices survive a new Chromium device id.
//   node scripts/test-audio-devices.js

const assert = require('assert');
const devices = require('../src/shared/audioDevices');

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

function output(id, label) {
  return { kind: 'audiooutput', deviceId: id, label: label };
}

function input(id, label) {
  return { kind: 'audioinput', deviceId: id, label: label };
}

const voicemeeter = 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)';
const speakers = 'Speakers (Realtek High Definition Audio)';

(async () => {
  await test('matches a saved output device by its current id', () => {
    const resolved = devices.resolveSavedDevice([
      output('default', 'Default - ' + speakers),
      output('sp-1', speakers),
      output('vm-7', voicemeeter),
    ], { deviceId: 'vm-7', label: voicemeeter }, 'output');
    assert.strictEqual(resolved.status, 'matched');
    assert.strictEqual(resolved.activeDeviceId, 'vm-7');
    assert.strictEqual(resolved.persist, false);
    assert.strictEqual(devices.sinkIdFor(resolved.activeDeviceId), 'vm-7');
  });

  await test('uses the label when Chromium assigns a new device id', () => {
    const resolved = devices.resolveSavedDevice([
      output('default', 'Default - ' + speakers),
      output('sp-new', speakers),
      output('vm-next', voicemeeter),
    ], { deviceId: 'vm-old', label: voicemeeter }, 'output');
    assert.strictEqual(resolved.status, 'matched');
    assert.strictEqual(resolved.activeDeviceId, 'vm-next');
    assert.strictEqual(resolved.saved.deviceId, 'vm-next');
    assert.strictEqual(resolved.saved.label, voicemeeter);
    assert.strictEqual(resolved.persist, true);
    assert.strictEqual(resolved.note, '');
  });

  await test('label match ignores case and a Default prefix', () => {
    const resolved = devices.resolveSavedDevice([
      output('vm-2', 'default - ' + voicemeeter.toLowerCase()),
    ], { deviceId: 'gone', label: '  ' + voicemeeter + '  ' }, 'output');
    assert.strictEqual(resolved.activeDeviceId, 'vm-2');
    assert.strictEqual(resolved.persist, true);
  });

  await test('does not adopt the virtual default entry in place of a saved device', () => {
    const saved = { deviceId: 'vm-old', label: voicemeeter };
    const resolved = devices.resolveSavedDevice([
      output('default', `Default - ${voicemeeter}`),
      output('communications', `Communications - ${voicemeeter}`),
    ], saved, 'output');
    assert.strictEqual(resolved.status, 'missing');
    assert.strictEqual(resolved.persist, false);
    assert.strictEqual(resolved.activeDeviceId, 'default');
    assert.strictEqual(resolved.saved.deviceId, 'vm-old');
    assert.strictEqual(resolved.saved.label, voicemeeter);
  });

  await test('keeps a missing device instead of replacing it with default', () => {
    const saved = { deviceId: 'vm-unplugged', label: voicemeeter };
    const resolved = devices.resolveSavedDevice([
      output('default', 'Default - ' + speakers),
      output('sp-1', speakers),
    ], saved, 'output');
    assert.strictEqual(resolved.status, 'missing');
    assert.strictEqual(resolved.activeDeviceId, 'default');
    assert.strictEqual(resolved.persist, false);
    assert.deepStrictEqual(resolved.saved, saved);
    assert.strictEqual(devices.sinkIdFor(resolved.activeDeviceId), '');
    assert.ok(resolved.note.includes(voicemeeter));
    assert.ok(resolved.note.includes('system default'));

    const back = devices.resolveSavedDevice([
      output('sp-1', speakers),
      output('vm-again', voicemeeter),
    ], resolved.saved, 'output');
    assert.strictEqual(back.status, 'matched');
    assert.strictEqual(back.activeDeviceId, 'vm-again');
    assert.strictEqual(back.persist, true);
  });

  await test('an explicit system default does not cling to an old label', () => {
    const choice = devices.choiceFromOption('default', voicemeeter);
    assert.deepStrictEqual(choice, { deviceId: 'default', label: '' });
    const resolved = devices.resolveSavedDevice([
      output('vm-1', voicemeeter),
    ], choice, 'output');
    assert.strictEqual(resolved.status, 'default');
    assert.strictEqual(resolved.persist, false);
    assert.strictEqual(resolved.note, '');
  });

  await test('stores the label of the device the user picked', () => {
    const choice = devices.choiceFromOption('vm-1', '  ' + voicemeeter + ' ');
    assert.deepStrictEqual(choice, { deviceId: 'vm-1', label: voicemeeter });
  });

  await test('does not treat a placeholder label as a real device name', () => {
    assert.strictEqual(devices.usableLabel('Device a1b2c3d4...'), '');
    assert.strictEqual(devices.usableLabel('Microphone 2'), '');
    const resolved = devices.resolveSavedDevice([
      input('mic-a', 'Microphone (USB Audio)'),
    ], { deviceId: 'mic-old', label: 'Microphone 2' }, 'input');
    assert.strictEqual(resolved.status, 'missing');
    assert.strictEqual(resolved.saved.label, '');
    assert.ok(resolved.note.includes('default microphone'));
  });

  await test('restores a microphone by label and does not pick a different one', () => {
    const resolved = devices.resolveSavedDevice([
      input('mic-a', 'Microphone (NVIDIA Broadcast)'),
      input('mic-b', 'Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)'),
    ], {
      deviceId: 'mic-old',
      label: 'Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)',
    }, 'input');
    assert.strictEqual(resolved.activeDeviceId, 'mic-b');
    assert.notStrictEqual(resolved.activeDeviceId, 'mic-a');
  });

  await test('id match wins when two devices share a label', () => {
    const resolved = devices.resolveSavedDevice([
      output('first', speakers),
      output('second', speakers),
    ], { deviceId: 'second', label: speakers }, 'output');
    assert.strictEqual(resolved.activeDeviceId, 'second');
    assert.strictEqual(resolved.persist, false);
  });

  await test('asks for media permission only when names are hidden', async () => {
    let prompts = 0;
    const open = {
      async enumerateDevices() {
        return [
          output('vm-1', voicemeeter),
          input('mic-1', 'Microphone (USB Audio)'),
        ];
      },
      async getUserMedia() {
        prompts += 1;
        throw new Error('should not prompt');
      },
    };
    const listed = await devices.listDevices(open);
    assert.strictEqual(listed.length, 2);
    assert.strictEqual(prompts, 0);
    assert.strictEqual(devices.needsLabelUnlock(listed), false);

    let enumerations = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const closed = {
      async enumerateDevices() {
        enumerations += 1;
        if (enumerations === 1) {
          return [input('', ''), output('default', '')];
        }
        return [input('mic-1', 'Microphone (USB Audio)'), output('vm-1', voicemeeter)];
      },
      async getUserMedia() {
        prompts += 1;
        await gate;
        return { getTracks: () => [{ stop() {} }] };
      },
    };
    assert.strictEqual(devices.needsLabelUnlock([input('', ''), output('default', '')]), true);
    const first = devices.listDevices(closed);
    const second = devices.listDevices(closed);
    assert.strictEqual(first, second);
    release();
    const opened = await first;
    assert.strictEqual(prompts, 1);
    assert.strictEqual(opened[0].deviceId, 'mic-1');
    assert.strictEqual(opened[1].label, voicemeeter);
  });

  await test('a failed permission prompt still returns the devices already listed', async () => {
    const media = {
      async enumerateDevices() {
        return [output('default', '')];
      },
      async getUserMedia() {
        throw new Error('NotAllowedError');
      },
    };
    const listed = await devices.listDevices(media);
    assert.strictEqual(listed.length, 1);
    const again = await devices.listDevices(media);
    assert.strictEqual(again.length, 1);
  });

  if (process.exitCode) process.exit(process.exitCode);
  console.log(`${passed} passed`);
})();
