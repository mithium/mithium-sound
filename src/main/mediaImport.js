// Import any common audio or video file as MP3.
// The container and codec come from ffprobe. The extension is not used.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PICKER_EXTENSIONS = [
  'mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'mp4', 'mov', 'm4v',
  'webm', '3gp', '3gpp', 'amr', 'mkv', 'avi', 'aiff', 'aif', 'wma', 'caf', 'mpeg', 'mpg', 'mpga',
];

function importDialogFilters() {
  return [
    { name: 'All files', extensions: ['*'] },
    { name: 'Audio and video', extensions: PICKER_EXTENSIONS.slice() },
  ];
}

function displayNameFromPath(filePath) {
  const base = path.basename(String(filePath || ''));
  const ext = path.extname(base);
  const name = (ext ? base.slice(0, -ext.length) : base).replace(/[\r\n]+/g, ' ').trim();
  return name.slice(0, 80) || 'Clip';
}

function run(bin, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) {
      reject(new Error('FFmpeg was not found. Import needs the bundled FFmpeg.'));
      return;
    }
    const proc = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
    });
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        finish(reject, new Error('FFmpeg was not found. Import needs the bundled FFmpeg.'));
      } else {
        finish(reject, err);
      }
    });
    proc.on('close', (code) => finish(resolve, { code, stdout, stderr }));
  });
}

function parseProbe(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout || ''));
  } catch {
    return null;
  }
  const streams = data && Array.isArray(data.streams) ? data.streams : [];
  const audio = streams.find((stream) => stream && stream.codec_type === 'audio') || null;
  const format = data && data.format ? data.format : {};
  const duration = Number(audio && audio.duration) || Number(format.duration) || 0;
  return {
    hasAudio: !!audio,
    codec: audio ? String(audio.codec_name || '') : '',
    formatName: String(format.format_name || ''),
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0,
    sizeBytes: Number(format.size) || 0,
  };
}

async function probeFile(ffprobePath, filePath) {
  if (!ffprobePath) throw new Error('ffprobe was not found. Import needs the bundled ffprobe.');
  const result = await run(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { timeoutMs: 20000 });
  const probe = result.code === 0 ? parseProbe(result.stdout) : null;
  if (!probe) {
    throw new Error('Could not read that file. It may not be audio or video.');
  }
  return probe;
}

async function convertToMp3(ffmpegPath, sourcePath, outputPath) {
  const result = await run(ffmpegPath, [
    '-y', '-hide_banner',
    '-i', sourcePath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-q:a', '4',
    outputPath,
  ]);
  if (result.code !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 128) {
    throw new Error('Could not convert that file to MP3.');
  }
}

function parseVolumeDetect(stderr) {
  const text = String(stderr || '');
  const max = text.match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  const mean = text.match(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  const read = (match) => {
    if (!match) return null;
    const value = match[1].toLowerCase();
    if (value === 'inf' || value === '-inf') return value === 'inf' ? Infinity : -Infinity;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  return { maxDb: read(max), meanDb: read(mean) };
}

function isAudible(volume) {
  return !!(volume && Number.isFinite(volume.maxDb) && volume.maxDb > -70);
}

async function measureVolume(ffmpegPath, filePath) {
  const result = await run(ffmpegPath, [
    '-hide_banner',
    '-i', filePath,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ], { timeoutMs: 60000 });
  return parseVolumeDetect(result.stderr);
}

async function convertFileToMp3({ sourcePath, outputPath, ffmpegPath, ffprobePath }) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('That file is missing.');
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error('That is not a file.');
  if (stat.size < 32) throw new Error('That file is empty.');
  if (stat.size > 200 * 1024 * 1024) throw new Error('That file is too large.');
  const source = await probeFile(ffprobePath, sourcePath);
  if (!source.hasAudio) throw new Error('That file has no audio track.');
  await convertToMp3(ffmpegPath, sourcePath, outputPath);
  const output = await probeFile(ffprobePath, outputPath);
  if (!output.hasAudio || output.codec !== 'mp3' || !(output.durationMs > 0) || fs.statSync(outputPath).size < 128) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    throw new Error('Converted audio was empty.');
  }
  return { source, output, name: displayNameFromPath(sourcePath) };
}

const SILENCE_FILTER = 'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,areverse';

async function trimMainSound({ ffmpegPath, ffprobePath, inputPath, outputPath, maxSec = 10 }) {
  const max = Math.min(30, Math.max(1, Math.round(Number(maxSec) || 10)));
  const attempt = async (filter) => {
    const args = ['-y', '-hide_banner', '-i', inputPath];
    if (filter) args.push('-af', filter);
    args.push('-t', String(max), '-c:a', 'libmp3lame', '-q:a', '4', outputPath);
    const result = await run(ffmpegPath, args);
    if (result.code !== 0 || !fs.existsSync(outputPath)) {
      throw new Error('Could not trim that sound.');
    }
  };
  await attempt(SILENCE_FILTER);
  let probe = await probeFile(ffprobePath, outputPath);
  if (!probe.hasAudio || probe.durationMs < 150) {
    await attempt(null);
    probe = await probeFile(ffprobePath, outputPath);
  }
  if (!probe.hasAudio || !(probe.durationMs > 0)) {
    throw new Error('Trimmed sound was empty.');
  }
  return probe;
}

module.exports = {
  PICKER_EXTENSIONS,
  importDialogFilters,
  displayNameFromPath,
  parseProbe,
  parseVolumeDetect,
  isAudible,
  probeFile,
  convertToMp3,
  measureVolume,
  convertFileToMp3,
  trimMainSound,
};
