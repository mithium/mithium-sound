// Find a smart-grab moment. Quick grab does not use this module.

const fs = require('fs');
const os = require('os');
const path = require('path');
const smartGrab = require('./smartGrab');
const soundGrab = require('./soundGrab');
const youtube = require('./youtube');
const mediaImport = require('./mediaImport');

function isMissingYtdlp(err) {
  return !!(err && /Couldn't find the YouTube downloader|couldn't start/i.test(String(err.message || '')));
}

async function gatherEntries(interpreted, ytdlpPath) {
  if (interpreted.url && !interpreted.searchText) {
    const info = await youtube.probeVideo({ url: interpreted.url, ytdlpPath });
    const mapped = smartGrab.mapVideoInfo(info, interpreted.url);
    mapped.pinned = true;
    return [mapped];
  }
  if (!interpreted.shapedQuery) throw new smartGrab.SmartGrabError('Type a sound to grab');
  const stdout = await youtube.searchVideos({
    query: interpreted.shapedQuery,
    ytdlpPath,
    limit: 8,
  });
  const entries = soundGrab.parseSearchPayload(stdout);
  if (interpreted.url) {
    try {
      const info = await youtube.probeVideo({ url: interpreted.url, ytdlpPath });
      const mapped = smartGrab.mapVideoInfo(info, interpreted.url);
      mapped.pinned = true;
      entries.unshift(mapped);
    } catch (err) {
      if (isMissingYtdlp(err)) throw err;
      console.error('smart grab url:', err.message);
    }
  }
  return entries;
}

async function peaksFor({ url, durationSec, details, interpreted }, deps) {
  if (!deps.ffmpegPath) return [];
  const hints = smartGrab.collectMoments(interpreted, {
    chapters: details.chapters,
    description: details.description,
    cues: [],
    peaks: [],
    useUrlTime: details.useUrlTime,
  }).filter((moment) => moment.kind === 'chapter' || moment.kind === 'description' || moment.kind === 'url');
  const duration = Number(durationSec);
  const strong = hints.some((moment) => (moment.score || 0) >= 24);
  const whole = Number.isFinite(duration) && duration > 12 && duration <= 6 * 60 && !strong;
  const windows = whole
    ? [{ startSec: 0, endSec: duration, whole: true }]
    : smartGrab.sampleWindows(duration, hints);
  const peaks = [];
  for (const window of windows.slice(0, 4)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-scan-'));
    try {
      const file = await youtube.downloadAudioSection({
        url,
        startSec: window.whole ? null : window.startSec,
        endSec: window.whole ? null : window.endSec,
        outputPath: path.join(dir, 'scan.mp3'),
        ytdlpPath: deps.ytdlpPath,
        ffmpegDir: deps.ffmpegDir,
        low: true,
        timeoutMs: window.whole ? 70000 : 45000,
      });
      const text = await mediaImport.readRmsMetadata(deps.ffmpegPath, file);
      const found = smartGrab.loudnessPeaks(smartGrab.parseRmsWindows(text), { count: 2 });
      for (const peak of found) {
        const start = window.whole ? peak.startSec : window.startSec + peak.startSec;
        peaks.push({ ...peak, startSec: Math.max(0, start) });
      }
    } catch (err) {
      if (isMissingYtdlp(err)) throw err;
      console.error('smart grab scan:', err.message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return peaks.sort((a, b) => b.score - a.score).slice(0, 4);
}

async function inspectEntry(entry, interpreted, deps) {
  let description = entry.probed ? (entry.description || '') : '';
  let chapters = entry.probed ? (entry.chapters || []) : [];
  let durationSec = entry.durationSec;
  let title = entry.title;
  if (!entry.probed) {
    const info = await youtube.probeVideo({ url: entry.url, ytdlpPath: deps.ytdlpPath });
    const mapped = smartGrab.mapVideoInfo(info, entry.url);
    description = mapped.description;
    chapters = mapped.chapters;
    durationSec = mapped.durationSec || durationSec;
    title = mapped.title || title;
  }
  const useUrlTime = !!(entry.pinned || (interpreted.url && entry.url === interpreted.url));
  let cues = [];
  const speech = interpreted.kind === 'speech' || !!interpreted.quote;
  if (speech) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-subs-'));
    try {
      const vtt = await youtube.downloadSubtitles({
        url: entry.url,
        ytdlpPath: deps.ytdlpPath,
        outputDir: dir,
        ffmpegDir: deps.ffmpegDir,
      });
      cues = smartGrab.parseCues(vtt);
    } catch (err) {
      if (isMissingYtdlp(err)) throw err;
      console.error('smart grab subtitles:', err.message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const details = {
    title,
    durationSec,
    description,
    chapters,
    cues,
    peaks: [],
    useUrlTime,
  };
  const duration = Number(durationSec);
  const long = !Number.isFinite(duration) || duration > 12;
  if (!speech && long) {
    details.peaks = await peaksFor({ url: entry.url, durationSec: duration, details, interpreted }, deps);
  }
  return details;
}

async function planFromRequest({ query, skipIds, llm, ytdlpPath, ffmpegPath, ffmpegDir }) {
  let interpreted = smartGrab.interpretRequest(query);
  if (llm && llm.apiKey) {
    const refined = await smartGrab.llmInterpret({
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      request: query,
      fetchImpl: llm.fetchImpl,
    });
    interpreted = smartGrab.applyLlmInterpret(interpreted, refined);
  }
  const entries = await gatherEntries(interpreted, ytdlpPath);
  const deps = { ytdlpPath, ffmpegPath, ffmpegDir };
  return smartGrab.planSmart({
    request: query,
    entries,
    skipIds,
    llm,
    interpreted,
    inspect: async (entry) => {
      try {
        return await inspectEntry(entry, interpreted, deps);
      } catch (err) {
        if (isMissingYtdlp(err)) throw err;
        console.error('smart grab inspect:', err.message);
        return null;
      }
    },
  });
}

module.exports = {
  planFromRequest,
};
