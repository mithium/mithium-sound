// Optional Freesound text search. Used only when a token is saved in Settings.

const lengthCap = require('../shared/lengthCap');
const { formatDurationLabel, assertPublicHttpUrl } = require('./openverse');
const { SoundSearchError } = require('./myinstants');

const API_ROOT = 'https://freesound.org/apiv2/search/text/';
const USER_AGENT = 'MithiumSound/1.23 (soundboard)';

function searchUrl(query, token, page) {
  const params = new URLSearchParams();
  params.set('query', String(query || '').trim());
  params.set('token', String(token || '').trim());
  params.set('page', String(page || 1));
  params.set('page_size', '12');
  params.set('filter', 'duration:[0 TO 29.9]');
  params.set('fields', 'id,name,duration,previews,license,username,url');
  return `${API_ROOT}?${params.toString()}`;
}

function mapSound(row) {
  if (!row || row.id == null) return null;
  const previews = row.previews || {};
  const audioUrl = previews['preview-hq-mp3'] || previews['preview-lq-mp3'] || '';
  let safeUrl = '';
  try {
    safeUrl = assertPublicHttpUrl(audioUrl);
  } catch {
    return null;
  }
  const seconds = Number(row.duration);
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  if (!lengthCap.matches(durationMs, lengthCap.MAX_MS)) return null;
  const title = String(row.name || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
  const creator = String(row.username || 'Freesound').trim() || 'Freesound';
  const license = String(row.license || 'Freesound').trim();
  let sourceUrl = '';
  try {
    sourceUrl = row.url ? assertPublicHttpUrl(row.url) : `https://freesound.org/s/${row.id}/`;
  } catch {
    sourceUrl = `https://freesound.org/s/${row.id}/`;
  }
  return {
    id: `fs:${row.id}`,
    freesoundId: String(row.id),
    title,
    creator,
    license,
    licenseUrl: '',
    sourceUrl,
    attribution: `"${title}" by ${creator}${license ? ` (${license})` : ''}. ${sourceUrl}`,
    audioUrl: safeUrl,
    source: 'Freesound',
    durationMs,
    lengthLabel: formatDurationLabel(durationMs),
  };
}

function mapSearchPayload(payload) {
  const rows = payload && Array.isArray(payload.results) ? payload.results : [];
  const results = [];
  for (const row of rows) {
    const mapped = mapSound(row);
    if (mapped) results.push(mapped);
  }
  const count = Number(payload && payload.count) || results.length;
  return {
    results,
    page: Number(payload && payload.page) || 1,
    pageCount: Math.max(1, Math.ceil(count / 12) || 1),
    resultCount: count,
    source: 'Freesound',
  };
}

async function searchFreesound(query, token, { fetchImpl = fetch, page = 1 } = {}) {
  const key = String(token || '').trim();
  if (!key) return null;
  const q = String(query || '').trim();
  if (!q) throw new SoundSearchError('Type a search', false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetchImpl(searchUrl(q, key, page), {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
  } catch (err) {
    throw new SoundSearchError(
      /fetch failed|network|timed out|enotfound/i.test(String(err && err.message))
        ? 'Freesound is unreachable. MyInstants results are unchanged.'
        : (err.message || 'Freesound search failed'),
      true
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw new SoundSearchError('Freesound rejected the API key in Settings.', false);
  }
  if (!response.ok) throw new SoundSearchError(`Freesound returned HTTP ${response.status}`, response.status >= 500);
  try {
    return mapSearchPayload(await response.json());
  } catch {
    throw new SoundSearchError('Freesound returned invalid JSON', false);
  }
}

module.exports = {
  API_ROOT,
  mapSound,
  mapSearchPayload,
  searchFreesound,
  searchUrl,
};
