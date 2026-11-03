#!/usr/bin/env node
// Real AAC-in-M4A, plus other containers, converted with the bundled ffmpeg.
// Format comes from ffprobe. The extension is not consulted.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
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

function run(args) {
  const result = spawnSync(ffmpeg(), args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffmpeg failed: ${args.join(' ')}`);
  }
}

(async () => {
  await test('the file picker accepts every file, including m4a, aac, 3gp, and amr', () => {
    const filters = mediaImport.importDialogFilters();
    assert.strictEqual(filters[0].extensions[0], '*');
    const listed = filters[1].extensions;
    for (const ext of ['m4a', 'aac', '3gp', 'amr', 'ogg', 'opus', 'webm', 'flac', 'wav', 'mp4', 'mov']) {
      assert.ok(listed.includes(ext), ext);
    }
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-import-'));
  const signal = path.join(dir, 'Voice 261018_013810.m4a');
  try {
    run([
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'sine=frequency=523:duration=0.5',
      '-c:a', 'aac', '-b:a', '64k',
      signal,
    ]);
    const copies = {
      bare: path.join(dir, 'Voice 261018_013810'),
      bin: path.join(dir, 'Voice 261018_013810.bin'),
      aac: path.join(dir, 'note.aac'),
      mp4: path.join(dir, 'clip.mp4'),
      mov: path.join(dir, 'clip.mov'),
      ogg: path.join(dir, 'clip.ogg'),
      opus: path.join(dir, 'clip.webm'),
      flac: path.join(dir, 'clip.flac'),
      wav: path.join(dir, 'clip.wav'),
      amr: path.join(dir, 'clip.amr'),
      gp: path.join(dir, 'clip.3gp'),
    };
    fs.copyFileSync(signal, copies.bare);
    fs.copyFileSync(signal, copies.bin);
    run(['-y', '-hide_banner', '-i', signal, '-c:a', 'aac', '-b:a', '64k', '-f', 'adts', copies.aac]);
    run(['-y', '-hide_banner', '-i', signal, '-c:a', 'aac', '-b:a', '64k', copies.mp4]);
    run(['-y', '-hide_banner', '-i', signal, '-c:a', 'aac', '-b:a', '64k', '-f', 'mov', copies.mov]);
    run(['-y', '-hide_banner', '-i', signal, '-c:a', 'libvorbis', '-q:a', '3', copies.ogg]);
    run(['-y', '-hide_banner', '-i', signal, '-c:a', 'libopus', '-b:a', '48k', copies.opus]);
    run(['-y', '-hide_banner', '-i', signal, '-c:a', 'flac', copies.flac]);
    run(['-y', '-hide_banner', '-i', signal, '-c:a', 'pcm_s16le', copies.wav]);
    run(['-y', '-hide_banner', '-i', signal, '-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb', copies.amr]);
    run(['-y', '-hide_banner', '-i', signal, '-c:a', 'aac', '-b:a', '64k', '-f', '3gp', copies.gp]);

    await test('Signal AAC M4A is detected by ffprobe, including a missing or odd extension', async () => {
      for (const filePath of [signal, copies.bare, copies.bin, copies.aac]) {
        const probe = await mediaImport.probeFile(ffprobe(), filePath);
        assert.strictEqual(probe.hasAudio, true, filePath);
        assert.strictEqual(probe.codec, 'aac', `${filePath} codec ${probe.codec}`);
        assert.ok(probe.durationMs > 300 && probe.durationMs < 900, `${filePath} duration ${probe.durationMs}`);
      }
      assert.strictEqual(mediaImport.displayNameFromPath(signal), 'Voice 261018_013810');
      assert.strictEqual(mediaImport.displayNameFromPath(copies.bare), 'Voice 261018_013810');
    });

    await test('common audio and video imports become audible MP3s', async () => {
      const jobs = [
        [signal, 'aac'],
        [copies.aac, 'aac'],
        [copies.mp4, 'aac'],
        [copies.mov, 'aac'],
        [copies.ogg, 'vorbis'],
        [copies.opus, 'opus'],
        [copies.flac, 'flac'],
        [copies.wav, 'pcm_s16le'],
        [copies.amr, 'amr_nb'],
        [copies.gp, 'aac'],
      ];
      for (const [source, codec] of jobs) {
        const output = path.join(dir, `${path.basename(source)}.out.mp3`);
        const converted = await mediaImport.convertFileToMp3({
          sourcePath: source,
          outputPath: output,
          ffmpegPath: ffmpeg(),
          ffprobePath: ffprobe(),
        });
        assert.strictEqual(converted.source.codec, codec, source);
        assert.strictEqual(converted.output.codec, 'mp3');
        assert.ok(converted.output.durationMs > 250, `${source} out ${converted.output.durationMs}`);
        const volume = await mediaImport.measureVolume(ffmpeg(), output);
        assert.ok(mediaImport.isAudible(volume), `${source} ${JSON.stringify(volume)}`);
        assert.ok(fs.statSync(output).size > 128);
      }
    });

    await test('a text file is rejected instead of saved as a silent mp3', async () => {
      const text = path.join(dir, 'notes.txt');
      fs.writeFileSync(text, 'this is not audio'.repeat(20));
      await assert.rejects(
        () => mediaImport.convertFileToMp3({
          sourcePath: text,
          outputPath: path.join(dir, 'notes.mp3'),
          ffmpegPath: ffmpeg(),
          ffprobePath: ffprobe(),
        }),
        /no audio|could not read|empty/i
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (process.exitCode) {
    console.error('Media import tests failed');
    process.exit(process.exitCode);
  }
  console.log(`\n${passed} tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
