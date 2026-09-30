// Clip timecodes shared by the YouTube trim slider.
// Loaded as a classic script in the renderer (globals) and require()'d by tests.

function parseClock(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  if (!/^\d{1,4}:\d{1,2}(?::\d{1,2})?$/.test(raw)) return null;
  const parts = raw.split(':').map((part) => Number(part));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (parts.length === 2) {
    const minutes = parts[0];
    const seconds = parts[1];
    if (seconds > 59) return null;
    return minutes * 60 + seconds;
  }
  const hours = parts[0];
  const minutes = parts[1];
  const seconds = parts[2];
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

// Keep start < end inside [0, maxSec]. `prefer` is the handle the user just moved.
function clampRange(start, end, maxSec, prefer) {
  const max = Math.max(1, Math.floor(Number(maxSec)));
  let s = Number.isFinite(Number(start)) ? Math.round(Number(start)) : 0;
  let e = Number.isFinite(Number(end)) ? Math.round(Number(end)) : max;
  s = Math.min(Math.max(s, 0), max);
  e = Math.min(Math.max(e, 0), max);

  if (prefer === 'end') {
    if (e <= s) e = s + 1;
    if (e > max) {
      e = max;
      s = e - 1;
    }
  } else {
    if (s >= e) s = e - 1;
    if (s < 0) {
      s = 0;
      e = Math.max(e, 1);
    }
    if (e > max) e = max;
    if (s >= e) s = e - 1;
  }

  if (s < 0) s = 0;
  if (e > max) e = max;
  if (s >= e) {
    e = Math.min(max, s + 1);
    if (s >= e) {
      e = max;
      s = Math.max(0, max - 1);
    }
  }
  return { start: s, end: e };
}

function isYoutubeUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return host === 'youtube.com'
    || host === 'm.youtube.com'
    || host === 'music.youtube.com'
    || host === 'youtube-nocookie.com'
    || host === 'youtu.be';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseClock, formatClock, clampRange, isYoutubeUrl };
}
