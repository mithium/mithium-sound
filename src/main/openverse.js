// Openverse audio search. Public API, no key.
// https://api.openverse.org/v1/audio/
//
// Browse is for short Discord soundboard effects. category=sound_effect is
// not usable here: Freesound (the effect library) leaves category empty, so
// that filter returns nothing and an unfiltered follow-up was filling the
// list with Jamendo songs and other long recordings.
//
// One search uses the API length band `shortest` (under 30 seconds) and
// excludes the Jamendo music catalog. Each row already includes `category`
// and `duration` in milliseconds. Music, podcasts, news, audiobooks,
// pronunciations, and anything that is not a short effect are dropped from
// the list using those fields. Nothing is downloaded just to measure length.
// Preview and import fetch a single chosen file.

const lengthCap = require('../shared/lengthCap');

const AUDIO_ROOT = 'https://api.openverse.org/v1/audio/';
const USER_AGENT = 'MithiumSound/1.11 (soundboard)';
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
// Openverse indexes `shortest` as duration < 30 seconds.
const MAX_SOUND_EFFECT_MS = 30 * 1000;
const SOUND_EFFECT_LENGTH = 'shortest';
const EXCLUDED_MUSIC_SOURCE = 'jamendo';

class OpenverseError extends Error {
  constructor(message, offline) {
    super(message);
    this.name = 'OpenverseError';
    this.offline = !!offline;
  }
}

function decodeEntities(value) {
  return String(value == null ? '' : value)
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function formatLicense(row) {
  const code = String((row && row.license) || '').trim().toLowerCase();
  const version = row && row.license_version ? ` ${String(row.license_version).trim()}` : '';
  if (!code) return '';
  if (code === 'cc0') return `CC0${version}`.trim();
  if (code === 'pdm') return 'Public Domain Mark';
  if (code === 'cc-pdm') return 'Public Domain Mark';
  return `CC ${code.toUpperCase()}${version}`.trim();
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    const a = parts[0];
    const b = parts[1];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  return false;
}

function assertPublicHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new OpenverseError('Audio link is not a usable URL', false);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpenverseError('Audio link is not a usable URL', false);
  }
  if (url.username || url.password) {
    throw new OpenverseError('Audio link is not a usable URL', false);
  }
  if (isPrivateHost(url.hostname)) {
    throw new OpenverseError('Audio link is not a public file', false);
  }
  return url.href;
}

function isDirectFileUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (isPrivateHost(url.hostname)) return false;
    const path = url.pathname.toLowerCase();
    if (path.includes('/apiv2/')) return false;
    if (path.endsWith('/download') || path.endsWith('/download/')) return false;
    return true;
  } catch {
    return false;
  }
}

function publicPageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (isPrivateHost(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function formatDurationLabel(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${String(remain).padStart(2, '0')}`;
}

function isShortSoundEffect(mapped) {
  if (!mapped) return false;
  const category = String(mapped.category || '').trim().toLowerCase();
  if (category && category !== 'sound_effect') return false;
  return lengthCap.matches(mapped.durationMs, lengthCap.MAX_MS);
}

function usableAudioUrl(row) {
  if (!row || typeof row !== 'object') return null;
  if (isDirectFileUrl(row.url)) return String(row.url);
  const alts = Array.isArray(row.alt_files) ? row.alt_files : [];
  for (const alt of alts) {
    if (alt && isDirectFileUrl(alt.url)) return String(alt.url);
  }
  return null;
}

function mapResult(row) {
  const audioUrl = usableAudioUrl(row);
  if (!audioUrl) return null;
  const title = decodeEntities(row.title) || 'Untitled';
  const creator = decodeEntities(row.creator) || 'Unknown creator';
  const license = formatLicense(row);
  const licenseUrl = publicPageUrl(row.license_url);
  const sourceUrl = publicPageUrl(row.foreign_landing_url);
  const attribution = decodeEntities(row.attribution)
    || `"${title}" by ${creator}${license ? ` is licensed under ${license}` : ''}${sourceUrl ? `. ${sourceUrl}` : ''}`;
  const duration = Number(row.duration);
  const durationMs = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null;
  return {
    id: String(row.id || ''),
    title,
    creator,
    license,
    licenseUrl,
    sourceUrl,
    attribution,
    audioUrl,
    category: row.category || null,
    durationMs,
    lengthLabel: formatDurationLabel(durationMs),
  };
}

function mapSearchResults(payload) {
  const results = [];
  const rows = payload && Array.isArray(payload.results) ? payload.results : [];
  for (const row of rows) {
    try {
      const mapped = mapResult(row);
      if (mapped && mapped.id && isShortSoundEffect(mapped)) results.push(mapped);
    } catch {
      // One bad row must not fail the search.
    }
  }
  return {
    results,
    page: Number(payload && payload.page) || 1,
    pageCount: Number(payload && payload.page_count) || 0,
    resultCount: Number(payload && payload.result_count) || results.length,
  };
}

function buildAudioSearchUrl({ q, page = 1, pageSize = 12, category, length, excludedSource } = {}) {
  const params = new URLSearchParams();
  params.set('q', String(q || '').trim());
  params.set('page', String(page || 1));
  params.set('page_size', String(Math.min(20, Math.max(1, pageSize || 12))));
  if (category) params.set('category', category);
  if (length) params.set('length', length);
  if (excludedSource) params.set('excluded_source', excludedSource);
  return `${AUDIO_ROOT}?${params.toString()}`;
}

function classifyFetchError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const code = err.code || (err.cause && err.cause.code);
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) {
    return true;
  }
  return /fetch failed|network|timed out|timeout|enotfound|econnrefused/i.test(String(err.message || ''));
}

async function requestJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof OpenverseError) throw err;
    throw new OpenverseError(
      classifyFetchError(err)
        ? 'Openverse is unreachable. Recording and the soundboard still work offline.'
        : (err.message || 'Openverse search failed'),
      classifyFetchError(err)
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 429) {
    throw new OpenverseError('Openverse rate limit reached. Try again in a minute.', false);
  }
  if (!response.ok) {
    throw new OpenverseError(`Openverse returned HTTP ${response.status}`, response.status >= 500);
  }
  try {
    return await response.json();
  } catch {
    throw new OpenverseError('Openverse returned invalid JSON', false);
  }
}

async function searchAudio(query, { fetchImpl = fetch, page = 1, pageSize = 12 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new OpenverseError('Type a search', false);
  if (q.length > 200) throw new OpenverseError('Search is too long', false);
  const url = buildAudioSearchUrl({
    q,
    page,
    pageSize,
    length: SOUND_EFFECT_LENGTH,
    excludedSource: EXCLUDED_MUSIC_SOURCE,
  });
  const found = mapSearchResults(await requestJson(url, fetchImpl));
  return {
    ...found,
    fellBack: false,
    length: SOUND_EFFECT_LENGTH,
  };
}

async function fetchPublic(url, fetchImpl, timeoutMs) {
  let current = assertPublicHttpUrl(url);
  for (let hop = 0; hop < 5; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'audio/*,*/*', 'User-Agent': USER_AGENT },
      });
    } catch (err) {
      if (err instanceof OpenverseError) throw err;
      throw new OpenverseError(
        classifyFetchError(err)
          ? 'Openverse is unreachable. Recording and the soundboard still work offline.'
          : (err.message || 'Could not download audio'),
        classifyFetchError(err)
      );
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new OpenverseError('Audio download redirected nowhere', false);
      current = assertPublicHttpUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new OpenverseError(`Audio download failed (${response.status})`, response.status >= 500);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 64) throw new OpenverseError('Audio file was empty', false);
    if (buffer.length > MAX_AUDIO_BYTES) throw new OpenverseError('Audio file is too large', false);
    return {
      buffer,
      contentType: String(response.headers.get('content-type') || ''),
      finalUrl: current,
    };
  }
  throw new OpenverseError('Audio download redirected too many times', false);
}

function extensionFor(contentType, audioUrl) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (type.includes('mpeg') || type.includes('mp3')) return '.mp3';
  if (type.includes('wav')) return '.wav';
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('flac')) return '.flac';
  if (type.includes('webm')) return '.webm';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return '.m4a';
  try {
    const path = new URL(audioUrl).pathname.toLowerCase();
    const match = path.match(/\.(mp3|wav|ogg|flac|webm|m4a|aac)$/);
    if (match) return `.${match[1]}`;
  } catch {
    /* keep default */
  }
  return '.mp3';
}

async function loadAudioById(id, { fetchImpl = fetch } = {}) {
  const raw = String(id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(raw)) throw new OpenverseError('Unknown Openverse result', false);
  const detail = await requestJson(`${AUDIO_ROOT}${raw}/`, fetchImpl);
  const mapped = mapResult(detail);
  if (!mapped) throw new OpenverseError('That result has no usable audio file', false);
  const file = await fetchPublic(mapped.audioUrl, fetchImpl, 30000);
  return {
    ...mapped,
    buffer: file.buffer,
    contentType: file.contentType,
    extension: extensionFor(file.contentType, file.finalUrl),
  };
}

function joinAttribution(clips) {
  const texts = [];
  const creators = [];
  const licenses = [];
  let licenseUrl = '';
  let sourceUrl = '';
  for (const clip of clips || []) {
    if (!clip) continue;
    const text = String(clip.attribution_text || '').trim();
    if (text && !texts.includes(text)) texts.push(text);
    const creator = String(clip.attribution_creator || '').trim();
    if (creator && !creators.includes(creator)) creators.push(creator);
    const license = String(clip.attribution_license || '').trim();
    if (license && !licenses.includes(license)) licenses.push(license);
    if (!licenseUrl && clip.attribution_license_url) licenseUrl = String(clip.attribution_license_url);
    if (!sourceUrl && clip.attribution_source_url) sourceUrl = String(clip.attribution_source_url);
  }
  if (!texts.length && !creators.length && !licenses.length) return null;
  return {
    creator: creators.join(', '),
    license: licenses.join('; '),
    licenseUrl,
    sourceUrl,
    text: texts.join('\n') || [creators.join(', '), licenses.join('; '), sourceUrl].filter(Boolean).join(' — '),
  };
}

module.exports = {
  AUDIO_ROOT,
  MAX_AUDIO_BYTES,
  MAX_SOUND_EFFECT_MS,
  OpenverseError,
  decodeEntities,
  formatLicense,
  formatDurationLabel,
  isShortSoundEffect,
  isPrivateHost,
  assertPublicHttpUrl,
  usableAudioUrl,
  mapResult,
  mapSearchResults,
  buildAudioSearchUrl,
  searchAudio,
  loadAudioById,
  extensionFor,
  joinAttribution,
};
