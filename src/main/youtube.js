const { spawn } = require('child_process');
const fs = require('fs');
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

module.exports = {
  extractClip,
  validateTimestamps,
  probeDuration,
  parseDurationOutput,
  isYoutubeUrl,
  explainYtdlpFailure,
  missingYtdlpMessage,
  ytdlpTimeoutMessage,
  shouldRetryWithCookies,
};
