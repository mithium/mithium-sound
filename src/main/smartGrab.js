// Smart grab: a separate mode from the quick sound-effect grab.
// Reads a natural-language request, finds a moment in any video, and cuts that length.

const { formatClock, parseClock } = require('../renderer/timecode');
const { safeLlmBase } = require('./soundGrab');

const HARD_CAP_SEC = 30;
const DEFAULT_BITE_SEC = 5;
const MIN_BITE_SEC = 1;

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
};

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'with', 'please', 'me', 'my',
  'that', 'this', 'in', 'on', 'at', 'from',
]);

class SmartGrabError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SmartGrabError';
  }
}

function clampBite(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return DEFAULT_BITE_SEC;
  return Math.min(HARD_CAP_SEC, Math.max(MIN_BITE_SEC, Math.round(value)));
}

function parseShareTime(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const clock = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (clock && (clock[1] || clock[2] || clock[3])) {
    return (Number(clock[1] || 0) * 3600) + (Number(clock[2] || 0) * 60) + Number(clock[3] || 0);
  }
  return null;
}

function startFromUrl(url) {
  const params = url.searchParams;
  let seconds = parseShareTime(params.get('t') || params.get('start') || params.get('time_continue'));
  if (seconds == null && url.hash) {
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    seconds = parseShareTime(hash.get('t') || hash.get('start'));
  }
  if (seconds == null || seconds < 0 || seconds > 86400 * 2) return null;
  return seconds;
}

function findUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const cleaned = match[0].replace(/[),.;]+$/g, '');
  let url;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  return {
    href: url.href,
    token: match[0],
    index: match.index,
    startSec: startFromUrl(url),
  };
}

function extractQuotes(text) {
  const quotes = [];
  const re = /[“"]([^”"]{1,180})[”"]/g;
  let match;
  while ((match = re.exec(text))) {
    const spoken = match[1].replace(/\s+/g, ' ').trim();
    if (spoken) quotes.push({ text: spoken, raw: match[0] });
  }
  return quotes;
}

function parseDuration(text) {
  const source = String(text || '');
  const words = Object.keys(NUMBER_WORDS).join('|');
  const re = new RegExp(
    `(?:^|[\\s,.(])(?:about\\s+|around\\s+|roughly\\s+|for\\s+)?(\\d+(?:\\.\\d+)?|${words})\\s*(?:-\\s*)?(seconds?|secs?|sec|minutes?|mins?|min|s|m)\\b`,
    'gi',
  );
  const found = [];
  let match;
  while ((match = re.exec(source))) {
    const token = match[1].toLowerCase();
    let value = Object.prototype.hasOwnProperty.call(NUMBER_WORDS, token) ? NUMBER_WORDS[token] : Number(token);
    if (!Number.isFinite(value)) continue;
    if (match[2].toLowerCase().charAt(0) === 'm') value *= 60;
    found.push({ seconds: value, index: match.index, length: match[0].length });
  }
  const half = source.match(/\bhalf\s+(?:a\s+)?(?:second|sec)\b/i);
  if (half) found.push({ seconds: 0.5, index: half.index, length: half[0].length });
  if (!found.length) return null;
  found.sort((a, b) => a.index - b.index);
  return found[found.length - 1];
}

function stripSpan(text, index, length) {
  return `${text.slice(0, index)} ${text.slice(index + length)}`;
}

function interpretRequest(input) {
  const raw = String(input || '').replace(/\s+/g, ' ').trim();
  if (!raw) throw new SmartGrabError('Type a sound to grab');
  if (raw.length > 180) throw new SmartGrabError('That request is too long');

  const foundUrl = findUrl(raw);
  let working = foundUrl ? stripSpan(raw, foundUrl.index, foundUrl.token.length) : raw;
  const quotes = extractQuotes(working);
  const quote = quotes.length ? quotes[quotes.length - 1].text : '';
  let bare = working;
  for (const item of quotes) bare = bare.replace(item.raw, ' ');
  const duration = parseDuration(bare);
  if (duration) bare = stripSpan(bare, duration.index, duration.length);

  bare = bare.replace(/^\s*(?:please\s+)?(?:grab|get|gimme|give me)\s+/i, ' ');
  bare = bare.replace(/\b(?:the\s+line|the\s+quote|the\s+sound\s+of|sound\s+of)\b/gi, ' ');
  bare = bare.replace(/\bfrom\s+the\b/gi, ' ');
  bare = bare.replace(/\bof\s+the\b/gi, ' ');
  bare = bare.replace(/\bin\s+the\b/gi, ' ');
  bare = bare.replace(/\bfrom\b/gi, ' ');
  bare = bare.replace(/[^\w\s']/g, ' ');
  const words = bare.split(/\s+/).filter((word) => word && !STOP_WORDS.has(word.toLowerCase()));
  let searchText = words.join(' ');
  if (quote && !searchText.toLowerCase().includes(quote.toLowerCase())) {
    searchText = `${searchText} ${quote}`.trim();
  }
  searchText = searchText.replace(/\s+/g, ' ').trim().slice(0, 160);

  const kind = quote || /\b(?:the\s+line|the\s+quote)\b/i.test(raw) ? 'speech' : 'effect';
  const preferShort = !(
    quote
    || kind === 'speech'
    || foundUrl
    || /\b(?:from|trailer|movie|film|episode|scene)\b/i.test(raw)
  );
  let shapedQuery = searchText;
  if (shapedQuery && preferShort && !/\b(?:sound effects?|sfx)\b/i.test(shapedQuery)) {
    shapedQuery = `${shapedQuery} sound effect`;
  }

  return {
    raw,
    url: foundUrl ? foundUrl.href : '',
    urlStartSec: foundUrl && foundUrl.startSec != null ? foundUrl.startSec : null,
    quote,
    kind,
    preferShort,
    durationSec: clampBite(duration ? duration.seconds : DEFAULT_BITE_SEC),
    durationExplicit: !!duration,
    searchText,
    shapedQuery,
  };
}

function applyLlmInterpret(local, llm) {
  if (!llm || !local || local.preferShort) return local ? { ...local } : local;
  const next = { ...local };
  const quote = !next.quote ? String(llm.quote || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  if (quote) {
    next.quote = quote;
    next.kind = 'speech';
  }
  const kind = String(llm.kind || '').toLowerCase();
  if (!next.quote && (kind === 'speech' || kind === 'effect' || kind === 'moment')) {
    next.kind = kind;
  }
  const search = String(llm.search || '').replace(/\s+/g, ' ').trim();
  if (search && search.length <= 180 && !/https?:/i.test(search)) {
    next.shapedQuery = search.slice(0, 180);
    if (next.quote) {
      const needle = next.quote.toLowerCase().slice(0, 24);
      if (needle && !next.shapedQuery.toLowerCase().includes(needle)) {
        next.shapedQuery = `${next.shapedQuery} ${next.quote}`.replace(/\s+/g, ' ').trim().slice(0, 180);
      }
    }
    next.searchText = next.shapedQuery;
  }
  return next;
}

function vttSeconds(token) {
  const match = String(token || '').trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.](\d{1,3})$/);
  if (!match) return null;
  const hours = match[1] != null && match[1] !== '' ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(String(match[4]).padEnd(3, '0'));
  if (minutes > 59 || seconds > 59) return null;
  return (hours * 3600) + (minutes * 60) + seconds + (millis / 1000);
}

function cleanCueText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVtt(text) {
  const cues = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].trim().split(/\s+-->\s+/);
    if (parts.length < 2) continue;
    const startSec = vttSeconds(parts[0]);
    const endSec = vttSeconds(parts[1].split(/\s+/)[0]);
    if (startSec == null || endSec == null) continue;
    const textLines = [];
    i += 1;
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i].trim());
      i += 1;
    }
    const spoken = cleanCueText(textLines.join(' '));
    if (spoken) cues.push({ startSec, endSec, text: spoken });
  }
  return cues;
}

function parseJson3(text) {
  const data = JSON.parse(text);
  const events = Array.isArray(data) ? data : (data && data.events) || [];
  const cues = [];
  for (const event of events) {
    if (!event || !Array.isArray(event.segs)) continue;
    const spoken = cleanCueText(event.segs.map((seg) => (seg && seg.utf8) || '').join(' '));
    if (!spoken) continue;
    const startSec = Number(event.tStartMs || 0) / 1000;
    const endSec = startSec + (Number(event.dDurationMs || 0) / 1000);
    cues.push({ startSec, endSec, text: spoken });
  }
  return cues;
}

function parseCues(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
    try {
      return parseJson3(raw);
    } catch {
      return [];
    }
  }
  return parseVtt(raw);
}

function normalizeSpeech(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchTranscriptMoment(cues, needle) {
  const want = normalizeSpeech(needle);
  const words = want.split(' ').filter(Boolean);
  if (!want || !cues || !cues.length || !words.length) return null;
  let best = null;
  for (let i = 0; i < cues.length; i += 1) {
    let blob = '';
    for (let j = i; j < cues.length && j < i + 8; j += 1) {
      blob = `${blob} ${normalizeSpeech(cues[j].text)}`.trim();
      if ((cues[j].endSec - cues[i].startSec) > 20 && j > i) break;
      let score = 0;
      if (blob.includes(want)) score = 100 + Math.max(0, 20 - (j - i));
      else {
        const have = new Set(blob.split(' ').filter(Boolean));
        let hits = 0;
        for (const word of words) if (have.has(word)) hits += 1;
        const ratio = hits / words.length;
        if (ratio >= 0.72) score = Math.round(ratio * 70);
      }
      if (score > 0 && (!best || score > best.score)) {
        best = {
          startSec: Math.max(0, cues[i].startSec),
          endSec: cues[j].endSec,
          text: cues.slice(i, j + 1).map((cue) => cue.text).join(' '),
          score,
          kind: 'transcript',
          label: cues.slice(i, j + 1).map((cue) => cue.text).join(' ').slice(0, 140),
        };
      }
      if (blob.includes(want)) break;
    }
  }
  return best;
}

function contentWords(text) {
  return normalizeSpeech(text)
    .replace(/\b(?:sound effects?|sfx)\b/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function matchChapters(chapters, query) {
  const words = contentWords(query);
  const hits = [];
  for (const chapter of chapters || []) {
    const start = Number(chapter && (chapter.start_time != null ? chapter.start_time : chapter.startSec));
    const title = String((chapter && (chapter.title || chapter.label)) || '').replace(/\s+/g, ' ').trim();
    if (!Number.isFinite(start) || start < 0 || !title) continue;
    const hay = title.toLowerCase();
    let score = 0;
    for (const word of words) if (hay.includes(word)) score += 16;
    if (score <= 0) continue;
    const end = Number(chapter.end_time != null ? chapter.end_time : chapter.endSec);
    hits.push({
      startSec: start,
      endSec: Number.isFinite(end) ? end : 0,
      label: title,
      score,
      kind: 'chapter',
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.startSec - b.startSec);
}

function parseDescriptionMoments(description) {
  const text = String(description || '');
  const re = /(?:^|\s|\()((?:\d{1,2}:)?\d{1,2}:\d{2})\)?/g;
  const moments = [];
  let match;
  while ((match = re.exec(text))) {
    const startSec = parseClock(match[1]);
    if (startSec == null) continue;
    const rest = text.slice(match.index + match[0].length, match.index + match[0].length + 90);
    const label = rest.replace(/^[\s\-–:]+/, '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
    moments.push({ startSec, label, kind: 'description' });
  }
  return moments;
}

function matchDescription(description, query) {
  const words = contentWords(query);
  return parseDescriptionMoments(description).map((moment) => {
    const hay = moment.label.toLowerCase();
    let score = 0;
    for (const word of words) if (hay.includes(word)) score += 16;
    return { ...moment, score };
  }).filter((moment) => moment.score > 0 && moment.label);
}

function parseRmsWindows(text) {
  const windows = [];
  const re = /pts_time:\s*([0-9.]+)[\s\S]{0,240}?RMS_level=\s*(-?(?:inf|[0-9.]+))/gi;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const startSec = Number(match[1]);
    const token = match[2].toLowerCase();
    let rmsDb = -100;
    if (token === 'inf') rmsDb = 0;
    else if (token !== '-inf') rmsDb = Number(token);
    if (!Number.isFinite(startSec) || !Number.isFinite(rmsDb)) continue;
    windows.push({ startSec, rmsDb });
  }
  return windows;
}

function loudnessPeaks(windows, options) {
  const count = Math.max(1, Number(options && options.count) || 4);
  const minGapSec = Number(options && options.minGapSec) || 4;
  const ranked = [];
  const list = windows || [];
  for (let i = 0; i < list.length; i += 1) {
    const rms = Number(list[i].rmsDb);
    const prev = i > 0 ? Number(list[i - 1].rmsDb) : -100;
    if (!Number.isFinite(rms)) continue;
    const onset = rms - (Number.isFinite(prev) ? prev : -100);
    if (rms < -45 && onset < 8) continue;
    const score = Math.round((Math.max(0, Math.min(40, rms + 50)) * 0.5) + (Math.max(0, Math.min(40, onset)) * 0.8));
    if (score < 12) continue;
    ranked.push({
      startSec: Number(list[i].startSec) || 0,
      rmsDb: rms,
      onsetDb: onset,
      score,
      kind: 'loudness',
      label: 'loud moment',
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.startSec - b.startSec);
  const picked = [];
  for (const peak of ranked) {
    if (picked.some((item) => Math.abs(item.startSec - peak.startSec) < minGapSec)) continue;
    picked.push(peak);
    if (picked.length >= count) break;
  }
  return picked;
}

function collectMoments(interpreted, details) {
  const info = details || {};
  const moments = [];
  const cues = (info.cues && info.cues.length) ? info.cues : parseCues(info.cuesText || '');
  const needle = (interpreted && interpreted.quote) || ((interpreted && interpreted.kind === 'speech') ? interpreted.searchText : '');
  if (needle) {
    const hit = matchTranscriptMoment(cues, needle);
    if (hit) moments.push(hit);
  }
  const query = [interpreted && interpreted.searchText, interpreted && interpreted.quote].filter(Boolean).join(' ');
  for (const chapter of matchChapters(info.chapters, query)) moments.push(chapter);
  for (const row of matchDescription(info.description, query)) moments.push(row);
  for (const peak of info.peaks || []) {
    const startSec = Number(peak && peak.startSec);
    if (!Number.isFinite(startSec) || startSec < 0) continue;
    moments.push({
      startSec,
      score: Number(peak.score) || 0,
      kind: 'loudness',
      label: peak.label || 'loud moment',
      rmsDb: peak.rmsDb,
    });
  }
  if (info.useUrlTime && interpreted && interpreted.urlStartSec != null) {
    moments.push({
      startSec: interpreted.urlStartSec,
      score: 90,
      kind: 'url',
      label: 'link time',
    });
  }
  return moments
    .filter((moment) => Number.isFinite(Number(moment.startSec)) && Number(moment.startSec) >= 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.startSec - b.startSec)
    .slice(0, 8);
}

function topMoment(entry) {
  let best = null;
  for (const moment of (entry && entry.moments) || []) {
    const startSec = Number(moment && moment.startSec);
    const score = Number(moment && moment.score) || 0;
    if (!Number.isFinite(startSec) || startSec < 0) continue;
    const minimum = moment.kind === 'loudness' ? 18 : (moment.kind === 'transcript' ? 50 : 12);
    if (score < minimum) continue;
    if (!best || score > best.score) best = moment;
  }
  return best;
}

function scoreVideo(entry, words, interpreted) {
  const hay = String((entry && entry.title) || '').toLowerCase();
  const preferShort = !interpreted || interpreted.preferShort !== false;
  let score = entry && entry.pinned ? 80 : 0;
  for (const word of words) if (hay.includes(word)) score += 14;
  if (/\bsound effects?\b|\bsfx\b|\bmeme\b/.test(hay)) score += 8;
  if (preferShort && /\b(?:compilation|mashup|full movie|episode|playlist|1\s*hour|10\s*hours|hours)\b/.test(hay)) {
    score -= 30;
  }
  const duration = Number(entry && entry.durationSec);
  if (!Number.isFinite(duration) || duration <= 0.3) score -= 40;
  else if (preferShort) {
    if (duration <= 10) score += 46;
    else if (duration <= 20) score += 28;
    else if (duration <= 45) score += 8;
    else if (duration <= 90) score -= 8;
    else score -= 24;
  } else if (duration <= 20) score += 6;
  else if (duration <= 600) score += 12;
  else if (duration <= 3 * 3600) score += 4;
  else score -= 12;
  const momentScore = ((entry && entry.moments) || []).reduce((max, moment) => Math.max(max, Number(moment && moment.score) || 0), 0);
  if (momentScore >= 70) score += 36;
  else if (momentScore >= 24) score += 16;
  return score;
}

function rankVideos(entries, interpreted, skipIds) {
  const skip = new Set((skipIds || []).map((id) => String(id)));
  const words = contentWords((interpreted && (interpreted.shapedQuery || interpreted.searchText)) || '');
  return (entries || [])
    .filter((entry) => entry && entry.id && entry.url && !skip.has(String(entry.id)))
    .map((entry) => ({ ...entry, score: scoreVideo(entry, words, interpreted) }))
    .sort((a, b) => b.score - a.score || (a.durationSec || 9999) - (b.durationSec || 9999));
}

function cutSection(videoDurationSec, lengthSec, startSec) {
  const length = clampBite(lengthSec);
  const duration = Number(videoDurationSec);
  let start = Math.max(0, Math.floor(Number(startSec) || 0));
  if (Number.isFinite(duration) && duration > 0 && start >= duration) {
    start = Math.max(0, Math.floor(duration - length));
  }
  let end;
  const whole = Number.isFinite(duration) && duration > 0 && start === 0 && duration <= length + 0.35;
  if (whole) {
    end = Math.max(start + 1, Math.ceil(duration - 1e-6));
  } else {
    end = start + length;
    if (Number.isFinite(duration) && duration > 0) {
      end = Math.min(end, Math.max(start + 1, Math.ceil(duration - 1e-6)));
    }
    if (end <= start) end = start + 1;
  }
  return {
    startSec: start,
    endSec: end,
    start: formatClock(start),
    end: formatClock(end),
    maxSec: length,
    exactSec: Math.max(1, end - start),
  };
}

function shouldExactCut(videoDurationSec, section) {
  const duration = Number(videoDurationSec);
  if (section && section.startSec > 0) return true;
  if (!Number.isFinite(duration) || duration <= 0) return false;
  return duration > ((section && section.maxSec) || DEFAULT_BITE_SEC) + 0.75;
}

function viaLabel(via) {
  if (via === 'transcript') return 'from the transcript';
  if (via === 'chapter') return 'from a chapter';
  if (via === 'description') return 'from the description';
  if (via === 'loudness') return 'from a loud moment';
  if (via === 'llm') return 'picked by the LLM';
  if (via === 'url') return 'from the link time';
  if (via === 'short') return 'short match';
  return 'from the start';
}

function shouldInspect(interpreted, ranked) {
  if (!ranked.length) return false;
  if (interpreted.quote || interpreted.kind === 'speech' || interpreted.kind === 'moment') return true;
  if (!interpreted.preferShort || interpreted.url) return true;
  const duration = Number(ranked[0].durationSec);
  return !Number.isFinite(duration) || duration > 20;
}

function entryNeedsInspect(interpreted, entry) {
  if (interpreted.quote || interpreted.kind === 'speech' || interpreted.kind === 'moment') return true;
  if (!interpreted.preferShort || interpreted.url || entry.pinned) {
    const duration = Number(entry.durationSec);
    if (interpreted.urlStartSec == null && !interpreted.quote && Number.isFinite(duration) && duration > 0 && duration <= interpreted.durationSec + 0.5) {
      return false;
    }
    return true;
  }
  const duration = Number(entry.durationSec);
  return !Number.isFinite(duration) || duration > 20;
}

function sampleWindows(durationSec, hints) {
  const duration = Number(durationSec) || 0;
  const seeds = [];
  for (const hint of hints || []) {
    const start = Number(hint && hint.startSec);
    if (Number.isFinite(start) && start >= 0) seeds.push(start);
  }
  if (!seeds.length && duration > 12) {
    for (let i = 1; i <= 4; i += 1) seeds.push((duration * i) / 5);
  }
  const windows = [];
  const seen = new Set();
  for (const seed of seeds) {
    if (windows.length >= 4) break;
    const start = Math.max(0, Math.floor(seed));
    let end = start + 12;
    if (duration > 0) end = Math.min(Math.ceil(duration), end);
    if (end - start < 2 || seen.has(start)) continue;
    seen.add(start);
    windows.push({ startSec: start, endSec: end });
  }
  return windows;
}

function buildCandidates(ranked, chosen, startSec, via, length) {
  const list = [];
  const push = (entry, start, how) => {
    if (!entry || !entry.id || !entry.url) return;
    const section = cutSection(entry.durationSec, length, start);
    const key = `${entry.id}:${section.startSec}`;
    if (list.some((item) => item.key === key)) return;
    list.push({
      key,
      videoId: entry.id,
      title: entry.title,
      url: entry.url,
      durationSec: entry.durationSec,
      via: how,
      viaLabel: viaLabel(how),
      section,
      exactCut: shouldExactCut(entry.durationSec, section),
      rangeLabel: `${section.start}–${section.end}`,
    });
  };
  push(chosen, startSec, via);
  const moments = ((chosen && chosen.moments) || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const moment of moments) push(chosen, moment.startSec, moment.kind || 'start');
  for (const entry of ranked) {
    if (String(entry.id) === String(chosen.id)) continue;
    const moment = topMoment(entry);
    const how = moment
      ? (moment.kind || 'start')
      : ((entry.durationSec && entry.durationSec <= length + 0.5) ? 'short' : 'start');
    push(entry, moment ? moment.startSec : 0, how);
  }
  return list.slice(0, 8);
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function postChat({ apiKey, baseUrl, body, fetchImpl }) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  const root = safeLlmBase(baseUrl);
  if (!root) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await (fetchImpl || fetch)(`${root}/chat/completions`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response || !response.ok) return null;
    const payload = await response.json();
    const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
    return message ? message.content : '';
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function llmInterpret({ apiKey, baseUrl, model, request, fetchImpl }) {
  const text = await postChat({
    apiKey,
    baseUrl,
    fetchImpl,
    body: {
      model: model || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'Interpret a request for one short audio moment from a video. Reply with JSON only: {"search":"youtube search text","quote":"","kind":"effect"|"speech"|"moment"}. Use kind speech for a spoken line. Do not invent a URL.',
        },
        { role: 'user', content: String(request || '') },
      ],
    },
  });
  if (!text) return null;
  const data = parseJsonObject(text);
  if (!data || typeof data !== 'object') return null;
  const kind = String(data.kind || '').toLowerCase();
  return {
    search: String(data.search || data.query || '').trim(),
    quote: String(data.quote || '').trim(),
    kind: (kind === 'speech' || kind === 'effect' || kind === 'moment') ? kind : '',
  };
}

function llmPickBody(interpreted, entries, model) {
  const candidates = (entries || []).slice(0, 6).map((entry) => ({
    id: entry.id,
    title: entry.title,
    durationSec: entry.durationSec,
    moments: (entry.moments || []).slice(0, 5).map((moment) => ({
      startSec: Math.round(Number(moment.startSec) * 10) / 10,
      kind: moment.kind,
      label: String(moment.label || moment.text || '').slice(0, 100),
    })).filter((moment) => Number.isFinite(moment.startSec)),
  }));
  return {
    model: model || 'gpt-4o-mini',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'Pick the video and the start time for this bite. Reply with JSON only: {"id":"video id","startSec":0}. startSec is where the bite begins, in seconds. Prefer a transcript moment for a spoken line. Prefer a chapter, description, or loud moment for a sound. A short sound-effect video can start at 0.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          request: interpreted && interpreted.raw,
          durationSec: interpreted && interpreted.durationSec,
          quote: (interpreted && interpreted.quote) || '',
          candidates,
        }),
      },
    ],
  };
}

function parseLlmPick(text, entries) {
  const data = parseJsonObject(text);
  if (!data) return null;
  const id = String(data.id || data.videoId || '');
  const known = (entries || []).find((entry) => String(entry.id) === id);
  if (!known) return null;
  const startSec = Number(data.startSec != null ? data.startSec : data.start);
  return {
    id,
    startSec: Number.isFinite(startSec) && startSec >= 0 ? startSec : 0,
  };
}

async function llmPickMoment({ apiKey, baseUrl, model, interpreted, entries, fetchImpl }) {
  const text = await postChat({
    apiKey,
    baseUrl,
    fetchImpl,
    body: llmPickBody(interpreted, entries, model),
  });
  if (!text) return null;
  return parseLlmPick(text, entries);
}

async function planSmart({ request, entries, skipIds, llm, inspect, interpreted: given }) {
  const interpreted = given || interpretRequest(request);
  let ranked = rankVideos(entries, interpreted, skipIds);
  if (!ranked.length) throw new SmartGrabError('No match for that. Try a different request.');
  if (typeof inspect === 'function' && shouldInspect(interpreted, ranked)) {
    let inspected = 0;
    for (const entry of ranked.slice(0, 4)) {
      if (inspected >= 3) break;
      if (!entryNeedsInspect(interpreted, entry)) continue;
      inspected += 1;
      let details = null;
      try {
        details = await inspect(entry, interpreted);
      } catch (err) {
        if (err && /Couldn't find the YouTube downloader|couldn't start/i.test(String(err.message || ''))) throw err;
        details = null;
      }
      if (!details) continue;
      if (details.durationSec) entry.durationSec = details.durationSec;
      if (details.title) entry.title = details.title;
      if (details.url) entry.url = details.url;
      entry.moments = Array.isArray(details.moments)
        ? details.moments
        : collectMoments(interpreted, details);
    }
    ranked = rankVideos(ranked, interpreted, skipIds);
  }
  if (!ranked.length) throw new SmartGrabError('No match for that. Try a different request.');

  let chosen = ranked[0];
  let startSec = 0;
  let via = (chosen.durationSec && chosen.durationSec <= interpreted.durationSec + 0.5) ? 'short' : 'start';
  const moment = topMoment(chosen);
  if (moment) {
    startSec = moment.startSec;
    via = moment.kind || 'start';
  }
  if (llm && llm.apiKey) {
    const picked = await llmPickMoment({
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      interpreted,
      entries: ranked,
      fetchImpl: llm.fetchImpl,
    });
    if (picked) {
      const match = ranked.find((entry) => String(entry.id) === String(picked.id));
      if (match) {
        chosen = match;
        startSec = picked.startSec;
        via = 'llm';
      }
    }
  }
  const section = cutSection(chosen.durationSec, interpreted.durationSec, startSec);
  const candidates = buildCandidates(ranked, chosen, startSec, via, interpreted.durationSec);
  return {
    shapedQuery: interpreted.shapedQuery,
    videoId: chosen.id,
    title: chosen.title,
    url: chosen.url,
    durationSec: chosen.durationSec,
    section,
    via,
    viaLabel: viaLabel(via),
    exactCut: shouldExactCut(chosen.durationSec, section),
    rangeLabel: `${section.start}–${section.end}`,
    candidates,
    interpreted,
  };
}

function nudgeSection(current, direction) {
  const startDelta = { earlier: -2, later: 2 };
  const lengthDelta = { shorter: -2, longer: 2 };
  if (startDelta[direction] == null && lengthDelta[direction] == null) {
    throw new SmartGrabError('Unknown nudge');
  }
  const state = current || {};
  const start = Math.max(0, (Number(state.startSec) || 0) + (startDelta[direction] || 0));
  const length = clampBite((Number(state.lengthSec) || DEFAULT_BITE_SEC) + (lengthDelta[direction] || 0));
  const section = cutSection(state.videoDurationSec, length, start);
  return {
    startSec: section.startSec,
    lengthSec: section.maxSec,
    section,
    exactCut: shouldExactCut(state.videoDurationSec, section),
    rangeLabel: `${section.start}–${section.end}`,
  };
}

function mapVideoInfo(info, pageUrl) {
  const source = info || {};
  const id = String(source.id || source.display_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'video';
  const duration = Number(source.duration != null ? source.duration : source.durationSec);
  const title = String(source.title || 'Video').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Video';
  return {
    id,
    title,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    url: String(source.webpage_url || pageUrl || ''),
    description: String(source.description || '').slice(0, 12000),
    chapters: Array.isArray(source.chapters) ? source.chapters : [],
    probed: true,
  };
}

module.exports = {
  HARD_CAP_SEC,
  DEFAULT_BITE_SEC,
  SmartGrabError,
  clampBite,
  interpretRequest,
  applyLlmInterpret,
  parseCues,
  matchTranscriptMoment,
  matchChapters,
  matchDescription,
  parseDescriptionMoments,
  parseRmsWindows,
  loudnessPeaks,
  collectMoments,
  cutSection,
  shouldExactCut,
  sampleWindows,
  nudgeSection,
  planSmart,
  llmInterpret,
  mapVideoInfo,
  viaLabel,
};
