#!/usr/bin/env node
// Insert order, ffmpeg render order, and Openverse result mapping.
//   node scripts/test-studio.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const edit = require('../src/shared/editPlan');
const playback = require('../src/shared/playbackTarget');
const clipEdit = require('../src/main/clipEdit');
const openverse = require('../src/main/openverse');
const remoteCert = require('../src/main/remoteCert');

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

function pcmWav(seconds, freq) {
  const rate = 44100;
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000);
    data.writeInt16LE(sample, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function doorResult(overrides) {
  return {
    id: 'a8682111-e459-4fa3-9802-4e97e534487f',
    title: 'Door slam 2.wav',
    url: 'https://cdn.freesound.org/previews/80/80929_16052-hq.mp3',
    creator: 'bennstir',
    license: 'by',
    license_version: '4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    foreign_landing_url: 'https://freesound.org/people/bennstir/sounds/80929',
    attribution: '"Door slam 2.wav" by bennstir is licensed under CC BY 4.0. To view a copy of this license, visit https://creativecommons.org/licenses/by/4.0/.',
    category: null,
    duration: 1400,
    alt_files: [{ url: 'https://freesound.org/apiv2/sounds/80929/download/', filetype: 'wav' }],
    ...overrides,
  };
}

(async () => {
  await test('phone remote hears on Windows unless the audition toggle is on', () => {
    assert.strictEqual(playback.playbackTarget(false), 'windows');
    assert.strictEqual(playback.playbackTarget(undefined), 'windows');
    assert.strictEqual(playback.playbackTarget(null), 'windows');
    assert.strictEqual(playback.playbackTarget(true), 'phone');
  });

  await test('before, middle, and after stay in that order', () => {
    const timeline = edit.buildEditTimeline({
      baseId: 10,
      baseDurationMs: 10000,
      inserts: [
        { clipId: 1, placement: 'after' },
        { clipId: 2, placement: 'before' },
        { clipId: 3, placement: 'at', atMs: 4000 },
        { clipId: 4, placement: 'at', atMs: 4000 },
        { clipId: 5, placement: 'at', atMs: 7000 },
        { clipId: 6, placement: 'before' },
      ],
    });
    assert.deepStrictEqual(timeline.map((piece) => [piece.kind, piece.clipId, piece.startMs, piece.endMs]), [
      ['insert', 2, undefined, undefined],
      ['insert', 6, undefined, undefined],
      ['base', 10, 0, 4000],
      ['insert', 3, undefined, undefined],
      ['insert', 4, undefined, undefined],
      ['base', 10, 4000, 7000],
      ['insert', 5, undefined, undefined],
      ['base', 10, 7000, 10000],
      ['insert', 1, undefined, undefined],
    ]);
  });

  await test('a point at the start or end does not invent an empty voice slice', () => {
    const timeline = edit.buildEditTimeline({
      baseId: 1,
      baseDurationMs: 5000,
      inserts: [
        { clipId: 2, placement: 'at', atMs: 0 },
        { clipId: 3, placement: 'at', atMs: 5000 },
      ],
    });
    assert.deepStrictEqual(timeline.map((piece) => [piece.kind, piece.clipId, piece.startMs, piece.endMs]), [
      ['insert', 2, undefined, undefined],
      ['base', 1, 0, 5000],
      ['insert', 3, undefined, undefined],
    ]);
  });

  await test('bad placement is rejected and an empty edit is just the voice', () => {
    assert.throws(() => edit.buildEditTimeline({
      baseId: 1,
      baseDurationMs: 1000,
      inserts: [{ clipId: 2, placement: 'under' }],
    }), /before, at a point, or after/);
    const only = edit.buildEditTimeline({ baseId: 1, baseDurationMs: 1000, inserts: [] });
    assert.deepStrictEqual(only, [{ kind: 'base', clipId: 1, startMs: 0, endMs: 1000 }]);
  });

  await test('ffmpeg filter follows the same piece order', () => {
    const timeline = edit.buildEditTimeline({
      baseId: 10,
      baseDurationMs: 10000,
      inserts: [
        { clipId: 2, placement: 'before' },
        { clipId: 3, placement: 'at', atMs: 4000 },
        { clipId: 1, placement: 'after' },
      ],
    });
    const plan = clipEdit.buildRenderPlan(timeline, {
      10: '/sounds/voice.webm',
      2: '/sounds/horn.mp3',
      3: '/sounds/boom.wav',
      1: '/sounds/laugh.mp3',
    });
    assert.deepStrictEqual(plan.inputOrder, [2, 10, 3, 1]);
    const parts = plan.filter.split(';');
    assert.strictEqual(parts[0].startsWith('[0:a]aformat='), true);
    assert.ok(parts[1].includes('atrim=start=0.000:end=4.000'));
    assert.ok(parts[2].startsWith('[2:a]aformat='));
    assert.ok(parts[3].includes('atrim=start=4.000:end=10.000'));
    assert.ok(parts[4].startsWith('[3:a]aformat='));
    assert.ok(parts[5].includes('concat=n=5:v=0:a=1[out]'));
  });

  await test('labels describe the rendered order', () => {
    const timeline = edit.buildEditTimeline({
      baseId: 10,
      baseDurationMs: 10000,
      inserts: [
        { uid: 'a', clipId: 2, placement: 'before' },
        { uid: 'b', clipId: 3, placement: 'at', atMs: 4000 },
      ],
    });
    const rows = edit.describeTimeline(timeline, { 10: 'Take', 2: 'Horn', 3: 'Boom' }, 10);
    assert.deepStrictEqual(rows.map((row) => row.label), ['Horn', 'Take 0:00–0:04', 'Boom', 'Take 0:04–0:10']);
    assert.strictEqual(rows[0].uid, 'a');
    assert.strictEqual(rows[1].uid, null);
  });

  const ffmpegPath = process.env.FFMPEG_BIN || 'ffmpeg';
  const ffmpegOk = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' }).status === 0;
  if (!ffmpegOk) {
    console.log('skip ffmpeg render (ffmpeg not on PATH)');
  } else {
    await test('ffmpeg render splices before, middle, and after into one file', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-edit-'));
      const voice = path.join(dir, 'voice.wav');
      const before = path.join(dir, 'before.wav');
      const middle = path.join(dir, 'middle.wav');
      const after = path.join(dir, 'after.wav');
      const output = path.join(dir, 'out.wav');
      fs.writeFileSync(voice, pcmWav(1.0, 440));
      fs.writeFileSync(before, pcmWav(0.25, 220));
      fs.writeFileSync(middle, pcmWav(0.5, 880));
      fs.writeFileSync(after, pcmWav(0.25, 660));
      const timeline = edit.buildEditTimeline({
        baseId: 'voice',
        baseDurationMs: 1000,
        inserts: [
          { clipId: 'after', placement: 'after' },
          { clipId: 'before', placement: 'before' },
          { clipId: 'middle', placement: 'at', atMs: 500 },
        ],
      });
      await clipEdit.renderTimeline({
        ffmpegPath,
        timeline,
        filesByClipId: { voice, before, middle, after },
        outputPath: output,
      });
      const duration = await clipEdit.probeDurationMs(ffmpegPath, output);
      assert.ok(Math.abs(duration - 2000) < 80, `expected about 2000ms, got ${duration}`);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  await test('search prefers category=sound_effect and skips rows with no audio URL', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('category=sound_effect')) {
        return jsonResponse({
          result_count: 1,
          page: 1,
          page_count: 1,
          results: [
            doorResult(),
            { id: 'missing-audio', title: 'Nope', url: null, alt_files: [{ url: 'https://freesound.org/apiv2/sounds/1/download/' }] },
            { id: 'private', title: 'Local', url: 'http://127.0.0.1/secret.mp3', license: 'by' },
            { id: 'alt-only', title: 'Alt', url: '', license: 'cc0', license_version: '1.0', creator: 'Ada', foreign_landing_url: 'https://example.com/alt', alt_files: [{ url: 'https://cdn.example.com/alt.mp3' }] },
          ],
        });
      }
      throw new Error('fallback should not run when sound effects exist');
    };
    const found = await openverse.searchAudio('door', { fetchImpl });
    assert.strictEqual(found.fellBack, false);
    assert.strictEqual(found.category, 'sound_effect');
    assert.ok(calls[0].startsWith('https://api.openverse.org/v1/audio/?'));
    assert.ok(calls[0].includes('category=sound_effect'));
    assert.ok(calls[0].includes('q=door'));
    assert.deepStrictEqual(found.results.map((row) => row.id), [
      'a8682111-e459-4fa3-9802-4e97e534487f',
      'alt-only',
    ]);
    const door = found.results[0];
    assert.strictEqual(door.license, 'CC BY 4.0');
    assert.strictEqual(door.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
    assert.strictEqual(door.creator, 'bennstir');
    assert.strictEqual(door.sourceUrl, 'https://freesound.org/people/bennstir/sounds/80929');
    assert.ok(door.attribution.includes('CC BY 4.0'));
    assert.strictEqual(door.audioUrl, 'https://cdn.freesound.org/previews/80/80929_16052-hq.mp3');
    assert.strictEqual(found.results[1].license, 'CC0 1.0');
    assert.strictEqual(found.results[1].audioUrl, 'https://cdn.example.com/alt.mp3');
  });

  await test('empty sound_effect page falls back without failing the search', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('category=sound_effect')) {
        return jsonResponse({ result_count: 0, page: 1, page_count: 0, results: [] });
      }
      return jsonResponse({
        result_count: 1,
        page: 1,
        page_count: 1,
        results: [doorResult({ creator: 'Bessonn&amp;sa', category: 'music' })],
      });
    };
    const found = await openverse.searchAudio('applause', { fetchImpl, page: 2 });
    assert.strictEqual(found.fellBack, true);
    assert.strictEqual(calls.length, 2);
    assert.ok(!calls[1].includes('category='));
    assert.ok(calls[1].includes('page=2'));
    assert.strictEqual(found.results[0].creator, 'Bessonn&sa');
    assert.strictEqual(found.results[0].license, 'CC BY 4.0');
  });

  await test('a down network is an offline error, not an empty board', async () => {
    const fetchImpl = async () => {
      const error = new Error('fetch failed');
      error.code = 'ENOTFOUND';
      throw error;
    };
    await assert.rejects(
      () => openverse.searchAudio('beep', { fetchImpl }),
      (err) => err instanceof openverse.OpenverseError && err.offline && /offline/i.test(err.message)
    );
  });

  await test('import keeps license fields and refuses a result with no public audio', async () => {
    const bytes = new Uint8Array(128);
    bytes.fill(7);
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes('/v1/audio/a8682111')) {
        return jsonResponse(doorResult());
      }
      if (href.includes('cdn.freesound.org')) {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (name === 'content-type' ? 'audio/mpeg' : null) },
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
      if (href.includes('/v1/audio/bbbbbbbb')) {
        return jsonResponse({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Gone', url: null, alt_files: [] });
      }
      throw new Error(`unexpected ${href}`);
    };
    const loaded = await openverse.loadAudioById('a8682111-e459-4fa3-9802-4e97e534487f', { fetchImpl });
    assert.strictEqual(loaded.license, 'CC BY 4.0');
    assert.strictEqual(loaded.creator, 'bennstir');
    assert.strictEqual(loaded.sourceUrl, 'https://freesound.org/people/bennstir/sounds/80929');
    assert.ok(loaded.attribution.includes('bennstir'));
    assert.strictEqual(loaded.extension, '.mp3');
    assert.strictEqual(loaded.buffer.length, 128);
    await assert.rejects(
      () => openverse.loadAudioById('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { fetchImpl }),
      /no usable audio/
    );
  });

  await test('joined attribution keeps every source license', () => {
    const joined = openverse.joinAttribution([
      { attribution_text: 'Take has no extra text', attribution_creator: '', attribution_license: '' },
      {
        attribution_text: '"Door" by bennstir is licensed under CC BY 4.0.',
        attribution_creator: 'bennstir',
        attribution_license: 'CC BY 4.0',
        attribution_license_url: 'https://creativecommons.org/licenses/by/4.0/',
        attribution_source_url: 'https://freesound.org/people/bennstir/sounds/80929',
      },
    ]);
    assert.ok(joined.text.includes('CC BY 4.0'));
    assert.strictEqual(joined.license, 'CC BY 4.0');
    assert.strictEqual(joined.creator, 'bennstir');
    assert.strictEqual(joined.sourceUrl, 'https://freesound.org/people/bennstir/sounds/80929');
  });

  await test('phone remote certificate parses and includes the LAN address', async () => {
    const pem = remoteCert.createSelfSignedCert({ dnsNames: ['localhost'], ips: ['127.0.0.1', '192.168.1.40'] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-cert-'));
    fs.writeFileSync(path.join(dir, 'cert.pem'), pem.cert);
    const text = spawnSync('openssl', ['x509', '-in', path.join(dir, 'cert.pem'), '-noout', '-text'], { encoding: 'utf8' });
    assert.strictEqual(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes('IP Address:192.168.1.40'));
    await new Promise((resolve, reject) => {
      const server = https.createServer({ cert: pem.cert, key: pem.key }, (_req, res) => {
        res.writeHead(200);
        res.end('ok');
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        https.get({ hostname: '127.0.0.1', port, rejectUnauthorized: false }, (res) => {
          res.resume();
          res.on('end', () => {
            server.close();
            resolve();
          });
        }).on('error', (err) => {
          server.close();
          reject(err);
        });
      });
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  if (process.exitCode) {
    console.error(`\n${passed} passed, with failures`);
  } else {
    console.log(`\n${passed} passed`);
  }
})();
