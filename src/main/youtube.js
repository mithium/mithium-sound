const { spawn } = require('child_process');
const path = require('path');

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

module.exports = { extractClip, validateTimestamps };
