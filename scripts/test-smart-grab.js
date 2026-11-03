#!/usr/bin/env node
// Smart grab: duration parsing, transcript moments, and exact section cuts.
// Quick grab stays covered by scripts/test-sound-grab.js.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const quick = require('../src/main/soundGrab');
const smart = require('../src/main/smartGrab');
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

const MEAN_GIRLS = `WEBVTT

00:01:02.000 --> 00:01:04.500
I'm not a regular mom

00:01:04.500 --> 00:01:06.200
I'm a cool mom
`;

(async () => {
  await test('quick grab still shapes short sound-effect searches the same way', () => {
    assert.strictEqual(quick.DEFAULT_MAX_SEC, 10);
    assert.strictEqual(quick.shapeQuery('vine boom'), 'vine boom sound effect');
    assert.strictEqual(quick.shapeQuery('bruh sound effect'), 'bruh sound effect');
    const section = quick.sectionFor(95, 10, 0);
    assert.strictEqual(section.startSec, 0);
    assert.strictEqual(section.endSec, 10);
  });

  await test('duration is read from the request, defaults to about 5 seconds, and caps at 30', () => {
    const airhorn = smart.interpretRequest('the airhorn from the Shrek trailer, 10 seconds');
    assert.strictEqual(airhorn.durationSec, 10);
    assert.strictEqual(airhorn.durationExplicit, true);
    assert.strictEqual(airhorn.preferShort, false);
    assert.match(airhorn.shapedQuery, /airhorn/i);
    assert.match(airhorn.shapedQuery, /shrek/i);
    assert.match(airhorn.shapedQuery, /trailer/i);
    assert.doesNotMatch(airhorn.shapedQuery, /sound effect/i);

    const coin = smart.interpretRequest('grab 4 seconds of the Mario coin');
    assert.strictEqual(coin.durationSec, 4);
    assert.strictEqual(coin.durationExplicit, true);
    assert.strictEqual(coin.shapedQuery, 'Mario coin sound effect');

    const line = smart.interpretRequest('the line "I\'m not a regular mom" from Mean Girls');
    assert.strictEqual(line.durationSec, 5);
    assert.strictEqual(line.durationExplicit, false);
    assert.strictEqual(line.kind, 'speech');
    assert.strictEqual(line.quote, "I'm not a regular mom");
    assert.match(line.shapedQuery, /Mean Girls/);
    assert.match(line.shapedQuery, /regular mom/);
    assert.doesNotMatch(line.shapedQuery, /sound effect/i);

    assert.strictEqual(smart.interpretRequest('vine boom').durationSec, 5);
    assert.strictEqual(smart.interpretRequest('vine boom').shapedQuery, 'vine boom sound effect');
    assert.strictEqual(smart.interpretRequest('10s vine boom').durationSec, 10);
    assert.strictEqual(smart.interpretRequest('45 seconds of rain').durationSec, 30);
    assert.strictEqual(smart.interpretRequest('1 minute of rain').durationSec, 30);
    assert.strictEqual(smart.interpretRequest('half a second of the beep').durationSec, 1);

    const vimeo = smart.interpretRequest('https://vimeo.com/123456789 8 seconds');
    assert.strictEqual(vimeo.url, 'https://vimeo.com/123456789');
    assert.strictEqual(vimeo.durationSec, 8);
    assert.strictEqual(vimeo.shapedQuery, '');

    const timed = smart.interpretRequest('https://youtu.be/dQw4w9WgXcQ?t=1m5s');
    assert.strictEqual(timed.urlStartSec, 65);
    assert.strictEqual(timed.durationSec, 5);
    assert.strictEqual(timed.durationExplicit, false);
  });

  await test('an LLM search can be adopted without overriding an explicit length', () => {
    const local = smart.interpretRequest('the airhorn from the Shrek trailer, 10 seconds');
    const merged = smart.applyLlmInterpret(local, {
      search: 'Shrek official trailer airhorn',
      quote: '',
      kind: 'effect',
    });
    assert.strictEqual(merged.durationSec, 10);
    assert.strictEqual(merged.shapedQuery, 'Shrek official trailer airhorn');

    const generic = smart.applyLlmInterpret(smart.interpretRequest('vine boom'), {
      search: 'something else entirely',
      kind: 'moment',
    });
    assert.strictEqual(generic.shapedQuery, 'vine boom sound effect');
    assert.strictEqual(generic.durationSec, 5);
  });

  await test('a spoken line is found in captions, including a line split across cues', () => {
    const cues = smart.parseCues(MEAN_GIRLS);
    const hit = smart.matchTranscriptMoment(cues, "I'm not a regular mom");
    assert.ok(hit);
    assert.ok(Math.abs(hit.startSec - 62) < 0.05, `start ${hit.startSec}`);
    assert.ok(hit.score >= 100);

    const split = smart.parseCues(`WEBVTT

00:00:10.000 --> 00:00:11.200
I'm not a
00:00:11.200 --> 00:00:12.800
regular mom
`);
    const splitHit = smart.matchTranscriptMoment(split, "I'm not a regular mom");
    assert.ok(splitHit);
    assert.ok(Math.abs(splitHit.startSec - 10) < 0.05);

    const json3 = smart.parseCues(JSON.stringify({
      events: [{ tStartMs: 62000, dDurationMs: 2500, segs: [{ utf8: "I'm not a regular mom" }] }],
    }));
    const jsonHit = smart.matchTranscriptMoment(json3, "I'm not a regular mom");
    assert.ok(jsonHit);
    assert.strictEqual(jsonHit.startSec, 62);
    assert.strictEqual(smart.matchTranscriptMoment(cues, 'this line is not in the video'), null);
  });

  await test('chapters and description timestamps can name the moment', () => {
    const chapters = smart.matchChapters(
      [{ start_time: 72, end_time: 80, title: 'Airhorn' }],
      'airhorn Shrek trailer',
    );
    assert.strictEqual(chapters[0].startSec, 72);
    const described = smart.matchDescription('0:00 intro\n1:23 airhorn in the swamp\n', 'airhorn');
    assert.strictEqual(described[0].startSec, 83);
  });

  await test('the cut is the requested length inside a long video and never past 30 seconds', () => {
    const ten = smart.cutSection(6000, 10, 62);
    assert.strictEqual(ten.start, '1:02');
    assert.strictEqual(ten.end, '1:12');
    assert.strictEqual(ten.exactSec, 10);

    const asked = smart.cutSection(6000, 10, 72);
    assert.strictEqual(asked.startSec, 72);
    assert.strictEqual(asked.endSec, 82);
    assert.strictEqual(asked.exactSec, 10);

    const capped = smart.cutSection(6000, 90, 0);
    assert.strictEqual(capped.maxSec, 30);
    assert.strictEqual(capped.endSec, 30);
    assert.strictEqual(smart.cutSection(1.2, 5, 0).endSec, 2);
  });

  await test('a transcript moment becomes the section that gets cut', async () => {
    const plan = await smart.planSmart({
      request: 'the line "I\'m not a regular mom" from Mean Girls',
      entries: [{
        id: 'meangirls11',
        title: 'Mean Girls',
        durationSec: 6000,
        url: 'https://www.youtube.com/watch?v=meangirls11',
      }],
      inspect: async () => ({ cuesText: MEAN_GIRLS, durationSec: 6000 }),
    });
    assert.strictEqual(plan.via, 'transcript');
    assert.strictEqual(plan.section.start, '1:02');
    assert.strictEqual(plan.section.end, '1:07');
    assert.strictEqual(plan.section.exactSec, 5);
    assert.strictEqual(plan.exactCut, true);
    assert.strictEqual(plan.videoId, 'meangirls11');
  });

  await test('a named moment in a long video beats a short unrelated effect', async () => {
    const plan = await smart.planSmart({
      request: 'the airhorn from the Shrek trailer, 10 seconds',
      entries: [
        { id: 'shortairhorn', title: 'airhorn sound effect', durationSec: 2, url: 'https://www.youtube.com/watch?v=shortairhorn' },
        {
          id: 'shrektrailer',
          title: 'Shrek official trailer',
          durationSec: 150,
          url: 'https://www.youtube.com/watch?v=shrektrailer',
          moments: [{ startSec: 72, score: 40, kind: 'chapter', label: 'Airhorn' }],
        },
      ],
    });
    assert.strictEqual(plan.videoId, 'shrektrailer');
    assert.strictEqual(plan.section.startSec, 72);
    assert.strictEqual(plan.section.endSec, 82);
    assert.strictEqual(plan.section.exactSec, 10);
  });

  await test('with no key, a generic short effect is left on the quick-style short match', async () => {
    let inspected = false;
    const plan = await smart.planSmart({
      request: 'vine boom',
      entries: [
        { id: 'aaaaaaaaaaa', title: 'vine boom sound effect', durationSec: 1.2, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
        { id: 'bbbbbbbbbbb', title: '1 hour vine boom compilation', durationSec: 3600, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' },
      ],
      inspect: async () => {
        inspected = true;
        return null;
      },
    });
    assert.strictEqual(inspected, false);
    assert.strictEqual(plan.videoId, 'aaaaaaaaaaa');
    assert.strictEqual(plan.section.maxSec, 5);
    assert.ok(plan.section.endSec <= 5);
  });

  await test('an LLM key picks the video and the timestamp', async () => {
    let calls = 0;
    const plan = await smart.planSmart({
      request: 'the airhorn from the Shrek trailer, 10 seconds',
      entries: [
        { id: 'shortairhorn', title: 'airhorn sound effect', durationSec: 2, url: 'https://www.youtube.com/watch?v=shortairhorn' },
        { id: 'shrektrailer', title: 'Shrek official trailer', durationSec: 150, url: 'https://www.youtube.com/watch?v=shrektrailer' },
      ],
      llm: {
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'test',
        fetchImpl: async (url, options) => {
          calls += 1;
          assert.strictEqual(url, 'https://example.com/v1/chat/completions');
          assert.match(options.headers.Authorization, /^Bearer /);
          assert.strictEqual(String(options.body).includes('test-key'), false);
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: '{"id":"shrektrailer","startSec":72}' } }],
            }),
          };
        },
      },
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(plan.videoId, 'shrektrailer');
    assert.strictEqual(plan.via, 'llm');
    assert.strictEqual(plan.section.startSec, 72);
    assert.strictEqual(plan.section.endSec, 82);
  });

  await test('nudge moves the same cut earlier, later, longer, and shorter', () => {
    const current = { startSec: 62, lengthSec: 10, videoDurationSec: 6000 };
    assert.strictEqual(smart.nudgeSection(current, 'earlier').startSec, 60);
    assert.strictEqual(smart.nudgeSection(current, 'later').startSec, 64);
    assert.strictEqual(smart.nudgeSection(current, 'longer').lengthSec, 12);
    assert.strictEqual(smart.nudgeSection(current, 'shorter').lengthSec, 8);
    assert.strictEqual(smart.nudgeSection({ startSec: 0, lengthSec: 30, videoDurationSec: 6000 }, 'longer').lengthSec, 30);
    assert.strictEqual(smart.nudgeSection({ startSec: 1, lengthSec: 1, videoDurationSec: 6000 }, 'shorter').lengthSec, 1);
    assert.strictEqual(smart.nudgeSection({ startSec: 1, lengthSec: 5, videoDurationSec: 6000 }, 'earlier').startSec, 0);
  });

  await test('loudness windows pick the onset, not the silence around it', () => {
    const peaks = smart.loudnessPeaks(smart.parseRmsWindows([
      'pts_time:0',
      'lavfi.astats.Overall.RMS_level=-inf',
      'pts_time:1',
      'lavfi.astats.Overall.RMS_level=-12.5',
      'pts_time:2',
      'lavfi.astats.Overall.RMS_level=-40',
    ].join('\n')));
    assert.strictEqual(peaks[0].startSec, 1);
    assert.strictEqual(peaks[0].kind, 'loudness');
  });

  await test('ffmpeg cuts a section to the requested length', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-smart-cut-'));
    const input = path.join(dir, 'tone.mp3');
    const output = path.join(dir, 'cut.mp3');
    const made = spawnSync(ffmpeg(), [
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-c:a', 'libmp3lame', '-q:a', '6',
      input,
    ], { encoding: 'utf8' });
    assert.strictEqual(made.status, 0, made.stderr);
    try {
      const probe = await mediaImport.cutExact({
        ffmpegPath: ffmpeg(),
        ffprobePath: ffprobe(),
        inputPath: input,
        outputPath: output,
        lengthSec: 4,
      });
      assert.ok(probe.durationMs > 3200 && probe.durationMs < 4800, `cut duration ${probe.durationMs}`);
      const source = await mediaImport.probeFile(ffprobe(), input);
      assert.ok(probe.durationMs < source.durationMs - 2000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('ffmpeg loudness scan finds a tone after silence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-smart-rms-'));
    const input = path.join(dir, 'burst.mp3');
    const made = spawnSync(ffmpeg(), [
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.4',
      '-filter_complex', '[0:a]atrim=0:1.2,asetpts=PTS-STARTPTS[a];[1:a]asetpts=PTS-STARTPTS[b];[0:a]atrim=0:1.2,asetpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=0:a=1[out]',
      '-map', '[out]',
      '-c:a', 'libmp3lame', '-q:a', '6',
      input,
    ], { encoding: 'utf8' });
    assert.strictEqual(made.status, 0, made.stderr);
    try {
      const text = await mediaImport.readRmsMetadata(ffmpeg(), input);
      const peaks = smart.loudnessPeaks(smart.parseRmsWindows(text));
      assert.ok(peaks.length > 0, text.slice(0, 500));
      assert.ok(Math.abs(peaks[0].startSec - 1) < 0.2, `peak ${peaks[0].startSec}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (process.exitCode) {
    console.error('Smart grab tests failed');
    process.exit(process.exitCode);
  }
  console.log(`\n${passed} tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
