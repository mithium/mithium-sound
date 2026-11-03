// Short sound-effect browse. MyInstants needs no key. Freesound is added when a token is set.
// Length is known before the file is saved. Preview and import download one chosen file.

const { assertPublicHttpUrl, formatDurationLabel } = require('./openverse');
const myinstants = require('./myinstants');
const freesound = require('./freesound');

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const USER_AGENT = 'MithiumSound/1.23 (soundboard)';
const catalog = new Map();

function remember(row) {
  if (row && row.id) catalog.set(row.id, row);
}

function rememberAll(rows) {
  for (const row of rows || []) remember(row);
}

async function searchSounds(query, { fetchImpl = fetch, page = 1, freesoundToken = '' } = {}) {
  const found = await myinstants.searchInstants(query, { fetchImpl, page });
  let freesoundError = '';
  let extra = [];
  if (String(freesoundToken || '').trim()) {
    try {
      const more = await freesound.searchFreesound(query, freesoundToken, { fetchImpl, page });
      extra = more && more.results ? more.results : [];
    } catch (err) {
      freesoundError = err.message || 'Freesound search failed';
      extra = [];
    }
  }
  const results = found.results.concat(extra);
  rememberAll(results);
  return {
    results,
    page: found.page,
    pageCount: found.pageCount,
    resultCount: found.resultCount,
    freesoundError,
    source: extra.length ? 'MyInstants + Freesound' : 'MyInstants',
  };
}

async function resolveResult(id, { fetchImpl = fetch, freesoundToken = '' } = {}) {
  const key = String(id || '');
  if (catalog.has(key)) return catalog.get(key);
  if (key.startsWith('mi:')) {
    const loaded = await myinstants.loadInstant(key.slice(3), { fetchImpl });
    remember(loaded);
    return loaded;
  }
  if (key.startsWith('fs:')) {
    const token = String(freesoundToken || '').trim();
    if (!token) throw new myinstants.SoundSearchError('Add a Freesound API key in Settings to use that result.', false);
    const found = await freesound.searchFreesound(key.slice(3), token, { fetchImpl, page: 1 });
    const match = found && found.results.find((row) => row.id === key);
    if (!match) throw new myinstants.SoundSearchError('That Freesound result is no longer available.', false);
    remember(match);
    return match;
  }
  throw new myinstants.SoundSearchError('Unknown sound', false);
}

async function downloadPublic(url, fetchImpl) {
  let current = assertPublicHttpUrl(url);
  for (let hop = 0; hop < 5; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'audio/*,*/*', 'User-Agent': USER_AGENT },
      });
    } catch (err) {
      throw new myinstants.SoundSearchError(
        /fetch failed|network|timed out|enotfound/i.test(String(err && err.message))
          ? 'Could not download that sound. The soundboard still works offline.'
          : (err.message || 'Could not download that sound'),
        true
      );
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new myinstants.SoundSearchError('Audio download redirected nowhere', false);
      current = assertPublicHttpUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new myinstants.SoundSearchError(`Audio download failed (${response.status})`, response.status >= 500);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 64) throw new myinstants.SoundSearchError('Audio file was empty', false);
    if (buffer.length > MAX_AUDIO_BYTES) throw new myinstants.SoundSearchError('Audio file is too large', false);
    return {
      buffer,
      contentType: String(response.headers.get('content-type') || ''),
      finalUrl: current,
    };
  }
  throw new myinstants.SoundSearchError('Audio download redirected too many times', false);
}

function publicResult(row) {
  return {
    id: row.id,
    title: row.title,
    creator: row.creator,
    license: row.license,
    licenseUrl: row.licenseUrl,
    sourceUrl: row.sourceUrl,
    attribution: row.attribution,
    source: row.source,
    durationMs: row.durationMs,
    lengthLabel: row.lengthLabel || formatDurationLabel(row.durationMs),
  };
}

module.exports = {
  searchSounds,
  resolveResult,
  downloadPublic,
  publicResult,
  remember,
  catalog,
};
