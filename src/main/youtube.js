const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { formatClock, isYoutubeUrl } = require('../renderer/timecode');

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

function ytdlpLooksLikeFile(ytdlpPath) {
  return path.isAbsolute(ytdlpPath) || ytdlpPath.includes('/') || ytdlpPath.includes('\\');
}

function missingYtdlpMessage(ytdlpPath) {
  const shown = ytdlpPath || 'yt-dlp';
  return `Couldn't find the YouTube downloader at "${shown}". Reinstall Mithium Sound, or set a yt-dlp path in Settings.`;
}

function ytdlpTimeoutMessage() {
  return "Couldn't reach YouTube in time. Check your internet connection and try again.";
}

function explainYtdlpFailure(stderr) {
  const text = String(stderr || '');
  if (/sign in to confirm|not a bot|aren'?t a bot|are not a bot|captcha|bot check/i.test(text)) {
    return 'YouTube blocked this download because it thinks the app is a bot. Try again later, or set a yt-dlp path in Settings that can use your browser login.';
  }
  if (/timed out|timeout|etimedout|econnreset|econnrefused|enotfound|enetunreach|eai_again|getaddrinfo|unable to download webpage|unable to download api page|urlopen error|network is unreachable|temporary failure in name resolution|name or service not known|nodename nor servname|connection aborted|connection reset|failed to establish a new connection|certificate verify failed/i.test(text)) {
    return "Couldn't reach YouTube. Check your internet connection and try again.";
  }
  if (/http error 403|403:\s*forbidden|http error 429|too many requests/i.test(text)) {
    return 'YouTube refused the download. Try again later.';
  }
  if (/private video|video unavailable|video is unavailable|has been removed|copyright claim|members-only|this video is not available/i.test(text)) {
    return "This video isn't available to download.";
  }
  if (/sign in|age-restricted|age restricted|confirm your age|cookies/i.test(text)) {
    return 'This video needs a YouTube sign-in, and the download still failed. Try a different video, or set a yt-dlp path in Settings.';
  }
  return "Couldn't download that clip from YouTube. Try again in a little while.";
}

function shouldRetryWithCookies(stderr) {
  const text = String(stderr || '');
  // "age" alone also matches the word "page", so keep this to real sign-in failures.
  if (/sign in to confirm|not a bot|captcha|bot check/i.test(text)) return true;
  if (/age[-\s]?restricted|confirm your age|inappropriate for some audiences/i.test(text)) return true;
  if (/\bsign in\b|\blog in\b|--cookies|cookies-from-browser/i.test(text)) return true;
  return false;
}

function throwYtdlpFailure(stderr) {
  const message = explainYtdlpFailure(stderr);
  console.error('yt-dlp failed:', String(stderr || '').slice(-2000));
  const err = new Error(message);
  err.ytdlpStderr = String(stderr || '');
  throw err;
}

function ensureYtdlp(ytdlpPath) {
  const value = String(ytdlpPath || '').trim();
  if (!value || (ytdlpLooksLikeFile(value) && !fs.existsSync(value))) {
    throw new Error(missingYtdlpMessage(value));
  }
  return value;
}

function runYtdlp({ url, start, end, outputPath, ytdlpPath, ffmpegDir, cookiesBrowser, onProgress }) {
  return new Promise((resolve, reject) => {
    let bin;
    try {
      bin = ensureYtdlp(ytdlpPath);
    } catch (err) {
      reject(err);
      return;
    }

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

    console.log('Spawning yt-dlp:', bin, args.join(' '));

    const proc = spawn(bin, args, { windowsHide: true });
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
      console.error('yt-dlp spawn error:', err.message);
      if (err.code === 'ENOENT') {
        reject(new Error(missingYtdlpMessage(bin)));
      } else {
        reject(new Error("The YouTube downloader couldn't start. Reinstall Mithium Sound, or set a yt-dlp path in Settings."));
      }
    });
  });
}

async function extractClip({ url, start, end, outputPath, ytdlpPath, ffmpegDir, onProgress }) {
  validateTimestamps(start, end);

  // First attempt without cookies
  const first = await runYtdlp({ url, start, end, outputPath, ytdlpPath, ffmpegDir, onProgress });
  if (first.success) return outputPath;

  // Age gates and YouTube's bot check both ask for a browser login.
  if (!shouldRetryWithCookies(first.stderr)) {
    throwYtdlpFailure(first.stderr);
  }

  console.log('Sign-in required, retrying with Chrome cookies...');
  const retry = await runYtdlp({ url, start, end, outputPath, ytdlpPath, ffmpegDir, cookiesBrowser: 'chrome', onProgress });
  if (retry.success) return outputPath;

  throwYtdlpFailure(`${first.stderr || ''}\n${retry.stderr || ''}`);
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
    let bin;
    try {
      bin = ensureYtdlp(ytdlpPath);
    } catch (err) {
      reject(err);
      return;
    }

    const proc = spawn(bin, args, { windowsHide: true });
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
      console.error('yt-dlp spawn error:', err.message);
      if (err.code === 'ENOENT') {
        finish(reject, new Error(missingYtdlpMessage(bin)));
      } else {
        finish(reject, new Error("The YouTube downloader couldn't start. Reinstall Mithium Sound, or set a yt-dlp path in Settings."));
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

async function probeDuration({ url, ytdlpPath, timeoutMs = 25000 }) {
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
      throw new Error(ytdlpTimeoutMessage());
    }
    return result;
  };

  const first = await attempt();
  if (first.code === 0) {
    const seconds = parseDurationOutput(first.stdout);
    if (seconds == null) throw new Error("Couldn't read the video length from YouTube. Try again.");
    return seconds;
  }

  if (!shouldRetryWithCookies(first.stderr)) {
    throwYtdlpFailure(first.stderr);
  }

  const retry = await attempt('chrome');
  if (retry.code === 0) {
    const seconds = parseDurationOutput(retry.stdout);
    if (seconds == null) throw new Error("Couldn't read the video length from YouTube. Try again.");
    return seconds;
  }

  throwYtdlpFailure(`${first.stderr || ''}\n${retry.stderr || ''}`);
}

function searchArgs(query, limit, cookiesBrowser) {
  const count = Math.min(12, Math.max(1, Number(limit) || 8));
  const args = ['--flat-playlist', '--dump-single-json', '--no-warnings', '--skip-download'];
  if (cookiesBrowser) args.push('--cookies-from-browser', cookiesBrowser);
  args.push(`ytsearch${count}:${query}`);
  return args;
}

async function searchVideos({ query, ytdlpPath, limit = 8, timeoutMs = 40000 }) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Type a sound to grab');
  const attempt = (cookiesBrowser) => runYtdlpCapture(ytdlpPath, searchArgs(q, limit, cookiesBrowser), timeoutMs);
  const first = await attempt();
  let result = first;
  if (result.code !== 0 && !result.timedOut && shouldRetryWithCookies(result.stderr)) {
    result = await attempt('chrome');
  }
  if (result.timedOut) throw new Error(ytdlpTimeoutMessage());
  if (result.code !== 0) throwYtdlpFailure(result.stderr);
  return result.stdout;
}

function isMissingYtdlpError(err) {
  return !!(err && /Couldn't find the YouTube downloader|couldn't start/i.test(String(err.message || '')));
}

async function captureWithCookieRetry(ytdlpPath, buildArgs, timeoutMs) {
  const first = await runYtdlpCapture(ytdlpPath, buildArgs(), timeoutMs);
  if (first.code === 0 && !first.timedOut) return first;
  if (first.timedOut) throw new Error(ytdlpTimeoutMessage());
  if (!shouldRetryWithCookies(first.stderr)) throwYtdlpFailure(first.stderr);
  const retry = await runYtdlpCapture(ytdlpPath, buildArgs('chrome'), timeoutMs);
  if (retry.timedOut) throw new Error(ytdlpTimeoutMessage());
  if (retry.code !== 0) throwYtdlpFailure(`${first.stderr || ''}\n${retry.stderr || ''}`);
  return retry;
}

function parseJsonLoose(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

async function probeVideo({ url, ytdlpPath, timeoutMs = 25000 }) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('Paste a video link to grab from.');
  const result = await captureWithCookieRetry(ytdlpPath, (cookies) => {
    const args = ['--skip-download', '--no-warnings', '--no-playlist', '-J'];
    if (cookies) args.push('--cookies-from-browser', cookies);
    args.push(target);
    return args;
  }, timeoutMs);
  const data = parseJsonLoose(result.stdout);
  if (!data || (!data.id && !data.title)) throw new Error("Couldn't read that video.");
  return data;
}

function readSubtitleFile(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) return '';
  const files = fs.readdirSync(outputDir).filter((name) => name.toLowerCase().endsWith('.vtt'));
  if (!files.length) return '';
  files.sort((a, b) => fs.statSync(path.join(outputDir, b)).size - fs.statSync(path.join(outputDir, a)).size);
  return fs.readFileSync(path.join(outputDir, files[0]), 'utf8');
}

async function downloadSubtitles({ url, ytdlpPath, outputDir, ffmpegDir, timeoutMs = 30000 }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const template = path.join(outputDir, 'sub');
  try {
    await captureWithCookieRetry(ytdlpPath, (cookies) => {
      const args = [
        '--skip-download', '--no-playlist', '--no-warnings',
        '--write-subs', '--write-auto-subs',
        '--sub-langs', 'en.*,en',
        '--convert-subs', 'vtt',
        '-o', template,
      ];
      if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);
      if (cookies) args.push('--cookies-from-browser', cookies);
      args.push(url);
      return args;
    }, timeoutMs);
  } catch (err) {
    if (isMissingYtdlpError(err)) throw err;
  }
  return readSubtitleFile(outputDir);
}

function resolveDownloaded(outputPath) {
  if (outputPath && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 128) return outputPath;
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath, path.extname(outputPath));
  if (!fs.existsSync(dir)) return '';
  const found = fs.readdirSync(dir)
    .filter((name) => name.startsWith(base) && /\.(mp3|m4a|webm|opus|ogg)$/i.test(name))
    .sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0];
  return found ? path.join(dir, found) : '';
}

async function downloadAudioSection({
  url,
  startSec,
  endSec,
  outputPath,
  ytdlpPath,
  ffmpegDir,
  low = true,
  timeoutMs = 50000,
}) {
  const start = Math.max(0, Math.floor(Number(startSec) || 0));
  const end = Math.ceil(Number(endSec));
  const useSection = Number.isFinite(end) && end > start;
  const build = (cookies, format) => {
    const args = [
      '-x', '--audio-format', 'mp3',
      '--audio-quality', low ? '9' : '0',
      '--no-playlist', '--no-warnings',
      '-o', outputPath,
    ];
    if (useSection) {
      args.push('--download-sections', `*${formatClock(start)}-${formatClock(end)}`, '--force-keyframes-at-cuts');
    }
    if (format) args.push('-f', format);
    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);
    if (cookies) args.push('--cookies-from-browser', cookies);
    args.push(url);
    return args;
  };
  const attempt = async (format) => {
    try {
      await captureWithCookieRetry(ytdlpPath, (cookies) => build(cookies, format), timeoutMs);
      return resolveDownloaded(outputPath);
    } catch (err) {
      if (isMissingYtdlpError(err)) throw err;
      return '';
    }
  };
  let found = '';
  if (low) found = await attempt('worstaudio/bestaudio/worst');
  if (!found) found = await attempt('');
  if (!found) throw new Error("Couldn't scan that video's audio.");
  return found;
}

module.exports = {
  extractClip,
  validateTimestamps,
  probeDuration,
  parseDurationOutput,
  searchVideos,
  probeVideo,
  downloadSubtitles,
  downloadAudioSection,
  isYoutubeUrl,
  explainYtdlpFailure,
  missingYtdlpMessage,
  ytdlpTimeoutMessage,
  shouldRetryWithCookies,
};
