#!/usr/bin/env node
// Query shaping, short-video picking, and the 10 second section. No network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const grab = require('../src/main/soundGrab');
const mediaImport = require('../src/main/mediaImport');

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

function ffprobe() {
  return process.env.FFPROBE_BIN || require('ffprobe-static').path;
}

const entries = [
  { id: 'aaaaaaaaaaa', title: 'vine boom sound effect', duration: 1.2, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
  { id: 'bbbbbbbbbbb', title: '1 hour vine boom compilation', duration: 3600, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' },
  { id: 'ccccccccccc', title: 'mario coin sound effect', duration: 3, url: 'https://www.youtube.com/watch?v=ccccccccccc' },
  { id: 'ddddddddddd', title: 'bruh sound effect meme', duration: 2, url: 'https://www.youtube.com/watch?v=ddddddddddd' },
  { id: 'eeeeeeeeeee', title: 'unrelated podcast', duration: 8, url: 'https://www.youtube.com/watch?v=eeeeeeeeeee' },
];

(async () => {
  await test('requests gain "sound effect" unless they already say it', () => {
    assert.strictEqual(grab.shapeQuery('vine boom'), 'vine boom sound effect');
    assert.strictEqual(grab.shapeQuery('Mario coin'), 'Mario coin sound effect');
    assert.strictEqual(grab.shapeQuery('bruh sound effect'), 'bruh sound effect');
    assert.strictEqual(grab.shapeQuery('  coin   sfx  '), 'coin sfx');
  });

  await test('the best short match wins and the section stays near 10 seconds', () => {
    const vine = grab.chooseCandidate(entries.map(grab.mapSearchEntry), 'vine boom sound effect', [], 10);
    assert.strictEqual(vine.id, 'aaaaaaaaaaa');
    assert.strictEqual(vine.section.start, '0:00');
    assert.strictEqual(vine.section.end, '0:02');
    assert.ok(vine.section.endSec - vine.section.startSec <= 10);

    const skipped = grab.chooseCandidate(entries.map(grab.mapSearchEntry), 'vine boom sound effect', ['aaaaaaaaaaa'], 10);
    assert.notStrictEqual(skipped.id, 'aaaaaaaaaaa');

    const long = grab.sectionFor(95, 10, 0);
    assert.strictEqual(long.startSec, 0);
    assert.strictEqual(long.endSec, 10);
    assert.strictEqual(long.end, '0:10');

    const mid = grab.sectionFor(40, 10, 12);
    assert.strictEqual(mid.startSec, 12);
    assert.strictEqual(mid.endSec, 22);
  });

  await test('an LLM pick is optional and ignored when there is no key', async () => {
    let called = false;
    const planned = await grab.planGrab({
      request: 'Mario coin',
      entries: entries.map(grab.mapSearchEntry),
      skipIds: [],
      llm: {
        apiKey: '',
        fetchImpl: async () => {
          called = true;
          throw new Error('should not be called');
        },
      },
    });
    assert.strictEqual(called, false);
    assert.strictEqual(planned.shapedQuery, 'Mario coin sound effect');
    assert.strictEqual(planned.videoId, 'ccccccccccc');
    assert.strictEqual(planned.section.endSec <= 10, true);
  });

  await test('an LLM key can choose a later start inside the same results', async () => {
    const planned = await grab.planGrab({
      request: 'vine boom',
      entries: entries.map(grab.mapSearchEntry),
      llm: {
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'test',
        fetchImpl: async (url, options) => {
          assert.strictEqual(url, 'https://example.com/v1/chat/completions');
          assert.match(options.headers.Authorization, /^Bearer /);
          const body = JSON.parse(options.body);
          assert.strictEqual(body.messages.some((message) => String(message.content).includes('test-key')), false);
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: '{"id":"aaaaaaaaaaa","startSec":0}' } }],
            }),
          };
        },
      },
    });
    assert.strictEqual(planned.videoId, 'aaaaaaaaaaa');
    const bad = grab.parseLlmPick('{"id":"not-a-real-id","startSec":4}', entries.map(grab.mapSearchEntry));
    assert.strictEqual(bad, null);
  });

  await test('trim keeps the tone and drops the surrounding silence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-trim-'));
    const input = path.join(dir, 'padded.mp3');
    const output = path.join(dir, 'bite.mp3');
    const made = spawnSync(ffmpeg(), [
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.45',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-filter_complex', '[0:a]atrim=0:0.8,asetpts=PTS-STARTPTS[a];[1:a]asetpts=PTS-STARTPTS[b];[2:a]atrim=0:0.8,asetpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=0:a=1[out]',
      '-map', '[out]',
      '-c:a', 'libmp3lame', '-q:a', '6',
      input,
    ], { encoding: 'utf8' });
    assert.strictEqual(made.status, 0, made.stderr);
    try {
      const probe = await mediaImport.trimMainSound({
        ffmpegPath: ffmpeg(),
        ffprobePath: ffprobe(),
        inputPath: input,
        outputPath: output,
        maxSec: 10,
      });
      const volume = await mediaImport.measureVolume(ffmpeg(), output);
      assert.ok(probe.durationMs > 200 && probe.durationMs < 2500, `trimmed duration ${probe.durationMs}`);
      assert.ok(mediaImport.isAudible(volume), JSON.stringify(volume));
      assert.ok(fs.statSync(output).size > 128);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (process.exitCode) {
    console.error('Sound grab tests failed');
    process.exit(process.exitCode);
  }
  console.log(`\n${passed} tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
