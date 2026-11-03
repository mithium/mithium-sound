// MyInstants search. Public JSON, no key, direct MP3 links.
// https://www.myinstants.com/api/v1/instants/

const lengthCap = require('../shared/lengthCap');
const { formatDurationLabel } = require('./openverse');
const { durationFromMp3 } = require('./mp3Duration');
const { assertPublicHttpUrl } = require('./openverse');

const API_ROOT = 'https://www.myinstants.com/api/v1/instants/';
const USER_AGENT = 'MithiumSound/1.23 (soundboard)';

class SoundSearchError extends Error {
  constructor(message, offline) {
    super(message);
    this.name = 'SoundSearchError';
    this.offline = !!offline;
  }
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

function searchUrl(query, page) {
  const params = new URLSearchParams();
  params.set('format', 'json');
  params.set('name', String(query || '').trim());
  params.set('page', String(page || 1));
  return `${API_ROOT}?${params.toString()}`;
}

function instantPage(slug) {
  return `https://www.myinstants.com/en/instant/${encodeURIComponent(slug)}/`;
}

function mapInstant(row) {
  if (!row || !row.slug || !row.sound) return null;
  let audioUrl = '';
  try {
    audioUrl = assertPublicHttpUrl(row.sound);
  } catch {
    return null;
  }
  if (!/\.mp3(\?|$)/i.test(new URL(audioUrl).pathname)) return null;
  const title = String(row.name || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
  const slug = String(row.slug);
  return {
    id: `mi:${slug}`,
    slug,
    title,
    creator: 'MyInstants',
    license: 'MyInstants',
    licenseUrl: 'https://www.myinstants.com/',
    sourceUrl: instantPage(slug),
    attribution: `"${title}" from MyInstants. ${instantPage(slug)}`,
    audioUrl,
    source: 'MyInstants',
    durationMs: null,
    lengthLabel: '',
  };
}

function mapSearchPayload(payload) {
  const rows = payload && Array.isArray(payload.results) ? payload.results : [];
  const results = [];
  for (const row of rows) {
    const mapped = mapInstant(row);
    if (mapped) results.push(mapped);
  }
  const count = Number(payload && payload.count) || results.length;
  const pageSize = results.length || 10;
  return {
    results,
    resultCount: count,
    pageCount: Math.max(1, Math.ceil(count / pageSize)),
    next: payload && payload.next ? String(payload.next) : '',
  };
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
    if (err instanceof SoundSearchError) throw err;
    throw new SoundSearchError(
      classifyFetchError(err)
        ? 'MyInstants is unreachable. Recording and the soundboard still work offline.'
        : (err.message || 'MyInstants search failed'),
      classifyFetchError(err)
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 429) throw new SoundSearchError('MyInstants rate limit reached. Try again in a minute.', false);
  if (!response.ok) {
    throw new SoundSearchError(`MyInstants returned HTTP ${response.status}`, response.status >= 500);
  }
  try {
    return await response.json();
  } catch {
    throw new SoundSearchError('MyInstants returned invalid JSON', false);
  }
}

async function readPrefix(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'audio/mpeg,*/*', Range: 'bytes=0-65535', 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    throw new SoundSearchError(
      classifyFetchError(err) ? 'MyInstants is unreachable.' : (err.message || 'Could not read sound length'),
      classifyFetchError(err)
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok && response.status !== 206) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  const range = response.headers.get('content-range') || '';
  const match = range.match(/\/(\d+)\s*$/);
  let total = match ? Number(match[1]) : 0;
  if (!total) {
    const length = Number(response.headers.get('content-length'));
    if (response.status === 200 && Number.isFinite(length)) total = length;
  }
  if (!total) total = buffer.length;
  return { buffer, total };
}

async function attachDuration(result, fetchImpl) {
  try {
    assertPublicHttpUrl(result.audioUrl);
    const prefix = await readPrefix(result.audioUrl, fetchImpl);
    if (!prefix) return null;
    const durationMs = durationFromMp3(prefix.buffer, prefix.total);
    if (!lengthCap.matches(durationMs, lengthCap.MAX_MS)) return null;
    return {
      ...result,
      durationMs,
      lengthLabel: formatDurationLabel(durationMs),
    };
  } catch {
    return null;
  }
}

async function withDurations(results, fetchImpl) {
  const out = [];
  const queue = results.slice();
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      const timed = await attachDuration(row, fetchImpl);
      if (timed) out.push(timed);
    }
  }
  const workers = [];
  for (let i = 0; i < 4; i += 1) workers.push(worker());
  await Promise.all(workers);
  const order = new Map(results.map((row, index) => [row.id, index]));
  out.sort((a, b) => order.get(a.id) - order.get(b.id));
  return out;
}

async function searchInstants(query, { fetchImpl = fetch, page = 1 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new SoundSearchError('Type a search', false);
  if (q.length > 200) throw new SoundSearchError('Search is too long', false);
  const payload = await requestJson(searchUrl(q, page), fetchImpl);
  const mapped = mapSearchPayload(payload);
  const results = await withDurations(mapped.results, fetchImpl);
  return {
    results,
    page: Number(page) || 1,
    pageCount: mapped.pageCount,
    resultCount: mapped.resultCount,
    source: 'MyInstants',
  };
}

async function loadInstant(slug, { fetchImpl = fetch } = {}) {
  const raw = String(slug || '').trim();
  if (!/^[a-z0-9-]{1,160}$/i.test(raw)) throw new SoundSearchError('Unknown MyInstants result', false);
  const detail = await requestJson(`${API_ROOT}${encodeURIComponent(raw)}/?format=json`, fetchImpl);
  const mapped = mapInstant(detail);
  if (!mapped) throw new SoundSearchError('That result has no MP3', false);
  return mapped;
}

module.exports = {
  API_ROOT,
  SoundSearchError,
  mapInstant,
  mapSearchPayload,
  searchInstants,
  loadInstant,
  attachDuration,
};
