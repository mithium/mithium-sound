#!/usr/bin/env node
// MyInstants and Freesound result mapping. No network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const myinstants = require('../src/main/myinstants');
const freesound = require('../src/main/freesound');
const { durationFromMp3 } = require('../src/main/mp3Duration');
const lengthCap = require('../src/shared/lengthCap');

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

function ffmpeg() {
  return process.env.FFMPEG_BIN || require('ffmpeg-static');
}

function makeMp3(seconds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-mp3-'));
  const file = path.join(dir, 'tone.mp3');
  const result = spawnSync(ffmpeg(), [
    '-y', '-hide_banner',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:a', 'libmp3lame', '-q:a', '6',
    file,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ffmpeg failed');
  return { file, bytes: fs.readFileSync(file), dir };
}

(async () => {
  await test('MP3 length comes from the file header, not a full save', () => {
    const made = makeMp3(1.2);
    try {
      const ms = durationFromMp3(made.bytes.subarray(0, 8192), made.bytes.length);
      assert.ok(ms > 900 && ms < 1600, `expected about 1200ms, got ${ms}`);
      assert.strictEqual(lengthCap.matches(ms, 10000), true);
      assert.strictEqual(lengthCap.matches(ms, 30000), true);
    } finally {
      fs.rmSync(made.dir, { recursive: true, force: true });
    }
  });

  await test('MyInstants rows keep a direct MP3 and a length measured before download', async () => {
    const made = makeMp3(0.8);
    try {
      const payload = {
        count: 24,
        next: 'https://www.myinstants.com/api/v1/instants/?page=2',
        results: [
          {
            name: 'Vine Boom Sound Effect',
            slug: 'vine-boom-sound-70972',
            sound: 'https://www.myinstants.com/media/sounds/vine-boom.mp3',
          },
          {
            name: 'Local secret',
            slug: 'local-secret',
            sound: 'http://127.0.0.1/secret.mp3',
          },
          {
            name: 'Not an mp3',
            slug: 'not-mp3',
            sound: 'https://www.myinstants.com/media/sounds/note.wav',
          },
        ],
      };
      const mapped = myinstants.mapSearchPayload(payload);
      assert.deepStrictEqual(mapped.results.map((row) => row.id), ['mi:vine-boom-sound-70972']);
      assert.strictEqual(mapped.results[0].lengthLabel, '');
      assert.strictEqual(mapped.results[0].audioUrl, 'https://www.myinstants.com/media/sounds/vine-boom.mp3');
      const calls = [];
      const fetchImpl = async (url) => {
        const href = String(url);
        calls.push(href);
        if (href.includes('/api/v1/instants/?')) {
          return {
            ok: true,
            status: 200,
            json: async () => payload,
          };
        }
        const prefix = Buffer.from(made.bytes.subarray(0, Math.min(8192, made.bytes.length)));
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? `bytes 0-${prefix.length - 1}/${made.bytes.length}` : null) },
          arrayBuffer: async () => prefix.buffer.slice(prefix.byteOffset, prefix.byteOffset + prefix.byteLength),
        };
      };
      const found = await myinstants.searchInstants('vine boom', { fetchImpl, page: 1 });
      assert.strictEqual(found.results.length, 1);
      assert.ok(found.results[0].durationMs > 400 && found.results[0].durationMs < 1400);
      assert.ok(found.results[0].lengthLabel);
      assert.ok(calls[0].includes('name=vine+boom') || calls[0].includes('name=vine%20boom'));
      assert.ok(calls.every((href) => !href.includes('127.0.0.1')));
    } finally {
      fs.rmSync(made.dir, { recursive: true, force: true });
    }
  });

  await test('a long MyInstants file is left out of the list', async () => {
    const made = makeMp3(1);
    try {
      const prefix = Buffer.from(made.bytes.subarray(0, Math.min(8192, made.bytes.length)));
      const info = prefix.indexOf('Info');
      const xing = prefix.indexOf('Xing');
      if (info >= 0) prefix.write('Nope', info);
      if (xing >= 0) prefix.write('Nope', xing);
      const row = myinstants.mapInstant({
        name: 'Long take',
        slug: 'long-take',
        sound: 'https://cdn.example.com/long.mp3',
      });
      const fetchImpl = async () => ({
        ok: true,
        status: 206,
        headers: { get: (name) => (String(name).toLowerCase() === 'content-range' ? `bytes 0-${prefix.length - 1}/4000000` : null) },
        arrayBuffer: async () => prefix.buffer.slice(prefix.byteOffset, prefix.byteOffset + prefix.byteLength),
      });
      const timed = await myinstants.attachDuration(row, fetchImpl);
      assert.strictEqual(timed, null);
    } finally {
      fs.rmSync(made.dir, { recursive: true, force: true });
    }
  });

  await test('Freesound uses the optional token and the duration field', async () => {
    let seen = '';
    const fetchImpl = async (url) => {
      seen = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          count: 1,
          results: [{
            id: 80929,
            name: 'Door slam',
            duration: 1.4,
            username: 'bennstir',
            license: 'Attribution',
            url: 'https://freesound.org/people/bennstir/sounds/80929',
            previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/80/80929_16052-hq.mp3' },
          }, {
            id: 2,
            name: 'Long song',
            duration: 180,
            username: 'x',
            license: 'Attribution',
            url: 'https://freesound.org/s/2/',
            previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/long.mp3' },
          }],
        }),
      };
    };
    assert.strictEqual(await freesound.searchFreesound('door', '', { fetchImpl }), null);
    const found = await freesound.searchFreesound('door', 'lab-token', { fetchImpl });
    assert.ok(seen.includes('token=lab-token'));
    assert.ok(seen.includes('duration'));
    assert.deepStrictEqual(found.results.map((row) => row.id), ['fs:80929']);
    assert.strictEqual(found.results[0].durationMs, 1400);
    assert.strictEqual(found.results[0].lengthLabel, '1.4s');
    assert.strictEqual(found.results[0].creator, 'bennstir');
    assert.strictEqual(lengthCap.matches(found.results[0].durationMs, 10000), true);
  });

  if (process.exitCode) {
    console.error('Sound search tests failed');
    process.exit(process.exitCode);
  }
  console.log(`\n${passed} tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
