const { spawn } = require('child_process');
const path = require('path');
const { isYoutubeUrl } = require('../renderer/timecode');

function parseTimestamp(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function validateTimestamps(start, end) {
  const s = parseTimestamp(start);
  const e = parseTimestamp(end);
  if (s === null || e === null) throw new Error('Invalid timestamp format. Use MM:SS or HH:MM:SS');
  if (s >= e) throw new Error('Start time must be before end time');
  return { startSec: s, endSec: e };
}

function runYtdlp({ url, start, end, outputPath, ytdlpPath, ffmpegDir, cookiesBrowser, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--download-sections', `*${start}-${end}`,
      '--force-keyframes-at-cuts',
      '-o', outputPath,
      '--no-playlist',
    ];

    if (cookiesBrowser) {
      args.push('--cookies-from-browser', cookiesBrowser);
    }

    if (ffmpegDir) {
      args.push('--ffmpeg-location', ffmpegDir);
    }

    args.push(url);

    console.log('Spawning yt-dlp:', ytdlpPath, args.join(' '));

    const proc = spawn(ytdlpPath, args, { windowsHide: true });
    let stderr = '';

    proc.stderr.on('data', (data) => {
      const line = data.toString();
      stderr += line;
      console.log('yt-dlp stderr:', line.trim());
      const match = line.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        onProgress(parseFloat(match[1]));
      }
    });

    proc.stdout.on('data', (data) => {
      const line = data.toString();
      console.log('yt-dlp stdout:', line.trim());
      const match = line.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        onProgress(parseFloat(match[1]));
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, stderr });
      }
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`yt-dlp not found at "${ytdlpPath}". Install it or set the path in settings.`));
      } else {
        reject(err);
      }
    });
  });
}

async function extractClip({ url, start, end, outputPath, ytdlpPath = 'yt-dlp', ffmpegDir, onProgress }) {
  validateTimestamps(start, end);

  // First attempt without cookies
  const first = await runYtdlp({ url, start, end, outputPath, ytdlpPath, ffmpegDir, onProgress });
  if (first.success) return outputPath;

  // Check if it's an age-restriction / sign-in error
  const needsCookies = /sign in|age|cookies/i.test(first.stderr);
  if (!needsCookies) {
    throw new Error(`yt-dlp exited with code 1: ${first.stderr.slice(-500)}`);
  }

  // Retry with Chrome cookies
  console.log('Age-restricted video detected, retrying with Chrome cookies...');
  const retry = await runYtdlp({ url, start, end, outputPath, ytdlpPath, ffmpegDir, cookiesBrowser: 'chrome', onProgress });
  if (retry.success) return outputPath;

  throw new Error(`yt-dlp exited with code 1: ${retry.stderr.slice(-500)}`);
}

function parseDurationOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const seconds = Number(lines[i]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return null;
}

let probeSerial = 0;
let activeProbe = null;

function runYtdlpCapture(ytdlpPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytdlpPath, args, { windowsHide: true });
    activeProbe = proc;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* already gone */ }
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeProbe === proc) activeProbe = null;
      fn(value);
    };

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        finish(reject, new Error(`yt-dlp not found at "${ytdlpPath}". Install it or set the path in settings.`));
      } else {
        finish(reject, err);
      }
    });
    proc.on('close', (code, signal) => {
      finish(resolve, { code, signal, stdout, stderr, timedOut });
    });
  });
}

function durationArgs(url, cookiesBrowser) {
  const args = ['--no-playlist', '--no-warnings', '--skip-download', '--print', 'duration'];
  if (cookiesBrowser) args.push('--cookies-from-browser', cookiesBrowser);
  args.push(url);
  return args;
}

async function probeDuration({ url, ytdlpPath = 'yt-dlp', timeoutMs = 25000 }) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('Missing YouTube URL');
  }
  if (!isYoutubeUrl(url)) {
    throw new Error('Enter a YouTube URL to read duration');
  }

  const serial = ++probeSerial;
  if (activeProbe) {
    try { activeProbe.kill(); } catch { /* already gone */ }
    activeProbe = null;
  }

  const attempt = async (cookiesBrowser) => {
    if (serial !== probeSerial) {
      const err = new Error('superseded');
      err.code = 'SUPERSEDED';
      throw err;
    }
    const result = await runYtdlpCapture(ytdlpPath, durationArgs(url.trim(), cookiesBrowser), timeoutMs);
    if (serial !== probeSerial) {
      const err = new Error('superseded');
      err.code = 'SUPERSEDED';
      throw err;
    }
    if (result.timedOut) {
      throw new Error('yt-dlp timed out while reading duration');
    }
    return result;
  };

  const first = await attempt();
  if (first.code === 0) {
    const seconds = parseDurationOutput(first.stdout);
    if (seconds == null) throw new Error('Could not read video duration');
    return seconds;
  }

  const needsCookies = /sign in|age|cookies/i.test(first.stderr || '');
  if (!needsCookies) {
    throw new Error(`yt-dlp exited with code ${first.code}: ${(first.stderr || '').slice(-500)}`);
  }

  const retry = await attempt('chrome');
  if (retry.code === 0) {
    const seconds = parseDurationOutput(retry.stdout);
    if (seconds == null) throw new Error('Could not read video duration');
    return seconds;
  }

  throw new Error(`yt-dlp exited with code ${retry.code}: ${(retry.stderr || '').slice(-500)}`);
}

module.exports = {
  extractClip,
  validateTimestamps,
  probeDuration,
  parseDurationOutput,
  isYoutubeUrl,
};
