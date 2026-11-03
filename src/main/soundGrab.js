// Turn a short request into one YouTube sound-effect bite.
// Works with no API key. An optional LLM key can pick among the same search results.

const { formatClock } = require('../renderer/timecode');
const { formatDurationLabel } = require('./openverse');

const DEFAULT_MAX_SEC = 10;

class GrabError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GrabError';
  }
}

function shapeQuery(input) {
  const query = String(input || '').replace(/\s+/g, ' ').trim();
  if (!query) throw new GrabError('Type a sound to grab');
  if (query.length > 180) throw new GrabError('That request is too long');
  if (/\b(sound effects?|sfx)\b/i.test(query)) return query;
  return `${query} sound effect`;
}

function meaningfulWords(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/\b(sound effects?|sfx)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

function scoreEntry(entry, query) {
  const title = String((entry && entry.title) || '');
  const hay = title.toLowerCase();
  const duration = Number(entry && entry.durationSec);
  let score = 0;
  for (const word of meaningfulWords(query)) {
    if (hay.includes(word)) score += 12;
  }
  if (/\bsound effects?\b|\bsfx\b|\bmeme\b/.test(hay)) score += 8;
  if (/\b(compilation|mashup|full movie|episode|playlist|1\s*hour|10\s*hours|hours)\b/.test(hay)) score -= 30;
  if (!Number.isFinite(duration) || duration <= 0.3) score -= 40;
  else if (duration <= 10) score += 46;
  else if (duration <= 20) score += 28;
  else if (duration <= 45) score += 8;
  else if (duration <= 90) score -= 8;
  else score -= 24;
  return score;
}

function mapSearchEntry(entry) {
  if (!entry || !entry.id) return null;
  const id = String(entry.id);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  const duration = Number(entry.duration != null ? entry.duration : entry.durationSec);
  const url = entry.webpage_url || entry.url || '';
  const page = String(url).startsWith('http') ? String(url) : `https://www.youtube.com/watch?v=${id}`;
  return {
    id,
    title: String(entry.title || 'YouTube sound').replace(/\s+/g, ' ').trim().slice(0, 140),
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    url: page,
  };
}

function parseSearchPayload(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout || ''));
  } catch {
    return [];
  }
  const entries = data && Array.isArray(data.entries) ? data.entries : [];
  const mapped = [];
  for (const entry of entries) {
    const row = mapSearchEntry(entry);
    if (row) mapped.push(row);
  }
  return mapped;
}

function rankEntries(entries, query, skipIds) {
  const skip = new Set((skipIds || []).map((id) => String(id)));
  return (entries || [])
    .filter((entry) => entry && entry.id && !skip.has(String(entry.id)))
    .map((entry) => ({ ...entry, score: scoreEntry(entry, query) }))
    .sort((a, b) => b.score - a.score || (a.durationSec || 9999) - (b.durationSec || 9999));
}

function sectionFor(durationSec, maxSec, startSec) {
  const max = Math.min(30, Math.max(1, Math.round(Number(maxSec) || DEFAULT_MAX_SEC)));
  const duration = Number(durationSec);
  let start = Math.max(0, Math.floor(Number(startSec) || 0));
  if (Number.isFinite(duration) && duration > 0 && start >= duration) start = 0;
  let end;
  const wholeShort = Number.isFinite(duration) && duration > 0 && duration <= max + 0.35 && start === 0;
  if (wholeShort) {
    end = Math.max(start + 1, Math.ceil(duration - 1e-6));
  } else {
    end = start + max;
    if (Number.isFinite(duration) && duration > 0) end = Math.min(end, Math.max(start + 1, Math.ceil(duration)));
    if (end <= start) end = start + 1;
  }
  return {
    startSec: start,
    endSec: end,
    start: formatClock(start),
    end: formatClock(end),
    maxSec: max,
  };
}

function chooseCandidate(entries, query, skipIds, maxSec) {
  const ranked = rankEntries(entries, query, skipIds);
  const best = ranked[0];
  if (!best) return null;
  const section = sectionFor(best.durationSec, maxSec, 0);
  return { ...best, section };
}

function parseLlmPick(text, entries) {
  let data;
  try {
    data = JSON.parse(String(text || ''));
  } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      data = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  const id = String((data && (data.id || data.videoId)) || '');
  const known = (entries || []).find((entry) => entry.id === id);
  if (!known) return null;
  const startSec = Number(data.startSec != null ? data.startSec : data.start);
  return {
    id,
    startSec: Number.isFinite(startSec) && startSec >= 0 ? startSec : 0,
  };
}

function llmRequestBody(query, entries, model) {
  const candidates = (entries || []).slice(0, 8).map((entry) => ({
    id: entry.id,
    title: entry.title,
    durationSec: entry.durationSec,
  }));
  return {
    model: model || 'gpt-4o-mini',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'Pick the best short sound-effect video for a Discord soundboard. Prefer videos under 15 seconds. Reply with JSON only: {"id":"youtube id","startSec":0}. startSec is where the main sound begins.',
      },
      {
        role: 'user',
        content: JSON.stringify({ request: query, candidates }),
      },
    ],
  };
}

function safeLlmBase(value) {
  const raw = String(value || '').trim() || 'https://api.openai.com/v1';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol === 'http:' && local) return url.href.replace(/\/$/, '');
  if (url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  return url.href.replace(/\/$/, '');
}

async function llmPick({ apiKey, baseUrl, model, query, entries, fetchImpl }) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  const root = safeLlmBase(baseUrl);
  if (!root) return null;
  const endpoint = `${root}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(llmRequestBody(query, entries, model)),
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!response || !response.ok) return null;
  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const text = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : '';
  return parseLlmPick(text, entries);
}

async function planGrab({
  request,
  entries,
  skipIds,
  maxSec = DEFAULT_MAX_SEC,
  llm,
}) {
  const shaped = shapeQuery(request);
  const ranked = rankEntries(entries, shaped, skipIds);
  if (!ranked.length) throw new GrabError('No other short match. Try a different request.');
  let chosen = ranked[0];
  let startSec = 0;
  if (llm && llm.apiKey) {
    const picked = await llmPick({
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      query: shaped,
      entries: ranked,
      fetchImpl: llm.fetchImpl || fetch,
    });
    if (picked) {
      const match = ranked.find((entry) => entry.id === picked.id);
      if (match) {
        chosen = match;
        startSec = picked.startSec;
      }
    }
  }
  const section = sectionFor(chosen.durationSec, maxSec, startSec);
  return {
    shapedQuery: shaped,
    videoId: chosen.id,
    title: chosen.title,
    url: chosen.url,
    durationSec: chosen.durationSec,
    lengthLabel: formatDurationLabel(chosen.durationSec ? Math.round(chosen.durationSec * 1000) : 0),
    section,
  };
}

module.exports = {
  DEFAULT_MAX_SEC,
  GrabError,
  shapeQuery,
  scoreEntry,
  mapSearchEntry,
  parseSearchPayload,
  rankEntries,
  sectionFor,
  chooseCandidate,
  parseLlmPick,
  llmRequestBody,
  safeLlmBase,
  llmPick,
  planGrab,
  formatDurationLabel,
};
