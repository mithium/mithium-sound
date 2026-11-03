const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const soundboard = require('./soundboard');
const settings = require('./settings');
const { buildEditTimeline } = require('../shared/editPlan');
const clipEdit = require('./clipEdit');
const openverse = require('./openverse');
const myinstants = require('./myinstants');
const soundSearch = require('./soundSearch');
const soundGrab = require('./soundGrab');
const youtube = require('./youtube');
const mediaImport = require('./mediaImport');
const { resolveYtdlpPath } = require('./ytdlpBin');

const previewCache = new Map();
const scratches = new Map();

function ffmpegPath() {
  return process.env.FFMPEG_BIN || '';
}

function ffprobePath() {
  return process.env.FFPROBE_BIN || '';
}

function ytdlpPath() {
  return resolveYtdlpPath({
    customPath: settings.get('ytdlpPath'),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    devPath: path.join(__dirname, '..', '..', 'bin', 'win', 'yt-dlp.exe'),
  });
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function liveGroupId(groupId) {
  if (groupId == null || groupId === '') return null;
  const id = Number(groupId);
  if (!Number.isFinite(id)) return null;
  return soundboard.getAllGroups().some((group) => Number(group.id) === id) ? id : null;
}

function extensionForMime(mime) {
  const type = String(mime || '').toLowerCase().split(';')[0].trim();
  if (type.includes('wav')) return '.wav';
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('mpeg') || type === 'audio/mp3') return '.mp3';
  if (type.includes('flac')) return '.flac';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return '.m4a';
  if (type.includes('webm')) return '.webm';
  return '.webm';
}

function mimeForFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a' || ext === '.aac') return 'audio/mp4';
  if (ext === '.webm') return 'audio/webm';
  return 'application/octet-stream';
}

function clipName(name, fallback) {
  const text = String(name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  return text || fallback;
}

async function saveRecording({ name, groupId, mime, bytes, durationMs }) {
  const buffer = Buffer.from(bytes || []);
  if (!buffer.length) throw httpError('Recording was empty', 400);
  const duration = Number(durationMs);
  const sound = soundboard.addAudioClip({
    name: clipName(name, 'Voice take'),
    bytes: buffer,
    extension: extensionForMime(mime),
    sourceType: 'recording',
    groupId: liveGroupId(groupId),
    durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
    mimeType: mime ? String(mime).split(';')[0] : null,
  });
  return sound;
}

function filesForTimeline(timeline) {
  const files = {};
  for (const piece of timeline) {
    if (Object.prototype.hasOwnProperty.call(files, piece.clipId)) continue;
    const sound = soundboard.getSoundById(piece.clipId);
    if (!sound) throw httpError('A clip in this edit is missing', 404);
    const filePath = soundboard.getFilePath(sound.filename);
    if (!fs.existsSync(filePath)) throw httpError(`Missing audio for ${sound.name}`, 404);
    files[piece.clipId] = filePath;
  }
  return files;
}

async function renderEdit({ name, groupId, baseId, inserts }) {
  const base = soundboard.getSoundById(Number(baseId));
  if (!base) throw httpError('Clip not found', 404);
  if (!Array.isArray(inserts) || !inserts.length) throw httpError('Add at least one clip to insert', 400);
  const basePath = soundboard.getFilePath(base.filename);
  if (!fs.existsSync(basePath)) throw httpError('The clip audio is missing', 404);
  const durationMs = await clipEdit.probeDurationMs(ffmpegPath(), basePath);
  const normalized = inserts.map((item) => ({
    clipId: Number(item.clipId),
    placement: item.placement,
    atMs: item.atMs == null ? null : Number(item.atMs),
  }));
  const timeline = buildEditTimeline({
    baseId: base.id,
    baseDurationMs: durationMs,
    inserts: normalized,
  });
  const files = filesForTimeline(timeline);
  const filename = `edit-${Date.now()}.wav`;
  const outputPath = path.join(soundboard.getSoundsDir(), filename);
  try {
    await clipEdit.renderTimeline({
      ffmpegPath: ffmpegPath(),
      timeline,
      filesByClipId: files,
      outputPath,
    });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    throw err;
  }
  let renderedDuration = null;
  try {
    renderedDuration = await clipEdit.probeDurationMs(ffmpegPath(), outputPath);
  } catch {
    renderedDuration = null;
  }
  const involved = [base];
  for (const item of normalized) involved.push(soundboard.getSoundById(item.clipId));
  const sound = soundboard.addSound({
    name: clipName(name, `${base.name} edit`),
    filename,
    sourceType: 'edit',
    groupId: liveGroupId(groupId),
    durationMs: renderedDuration,
    mimeType: 'audio/wav',
    attribution: openverse.joinAttribution(involved),
  });
  return sound;
}

async function probeClip(id) {
  const sound = soundboard.getSoundById(Number(id));
  if (!sound) throw httpError('Clip not found', 404);
  const filePath = soundboard.getFilePath(sound.filename);
  if (!fs.existsSync(filePath)) throw httpError('The clip audio is missing', 404);
  const durationMs = await clipEdit.probeDurationMs(ffmpegPath(), filePath);
  return { id: sound.id, durationMs, name: sound.name };
}

function readClip(id) {
  const found = soundboard.readSoundBytes(Number(id));
  if (!found) throw httpError('Clip not found', 404);
  return {
    mime: found.sound.mime_type || mimeForFilename(found.sound.filename),
    bytes: found.bytes,
    filename: found.sound.filename,
  };
}

function rememberPreview(id, loaded) {
  previewCache.set(String(id), { at: Date.now(), loaded });
  while (previewCache.size > 8) {
    const oldest = previewCache.keys().next().value;
    previewCache.delete(oldest);
  }
}

async function loadOpenverse(id) {
  const key = String(id || '');
  const hit = previewCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.loaded;
  const loaded = await openverse.loadAudioById(key);
  rememberPreview(key, loaded);
  return loaded;
}

function publicResult(loaded) {
  return {
    id: loaded.id,
    title: loaded.title,
    creator: loaded.creator,
    license: loaded.license,
    licenseUrl: loaded.licenseUrl,
    sourceUrl: loaded.sourceUrl,
    attribution: loaded.attribution,
    category: loaded.category,
    durationMs: loaded.durationMs,
  };
}

async function searchOpenverse(query, page) {
  try {
    return await openverse.searchAudio(query, { page: Number(page) || 1 });
  } catch (err) {
    if (err instanceof openverse.OpenverseError && !err.status) {
      err.status = err.offline ? 503 : 400;
    }
    throw err;
  }
}

async function previewOpenverse(id) {
  try {
    const loaded = await loadOpenverse(id);
    return {
      result: publicResult(loaded),
      mime: loaded.contentType || 'audio/mpeg',
      bytes: loaded.buffer,
    };
  } catch (err) {
    if (err instanceof openverse.OpenverseError && !err.status) {
      err.status = err.offline ? 503 : 400;
    }
    throw err;
  }
}

async function importOpenverse({ id, name, groupId }) {
  try {
    const loaded = await loadOpenverse(id);
    return soundboard.addAudioClip({
      name: clipName(name, loaded.title),
      bytes: loaded.buffer,
      extension: loaded.extension,
      sourceType: 'openverse',
      groupId: liveGroupId(groupId),
      durationMs: loaded.durationMs,
      mimeType: loaded.contentType || null,
      attribution: {
        creator: loaded.creator,
        license: loaded.license,
        licenseUrl: loaded.licenseUrl,
        sourceUrl: loaded.sourceUrl,
        text: loaded.attribution,
      },
    });
  } catch (err) {
    if (err instanceof openverse.OpenverseError && !err.status) {
      err.status = err.offline ? 503 : 400;
    }
    throw err;
  }
}

function saveScratch(bytes, mime) {
  const buffer = Buffer.from(bytes || []);
  if (!buffer.length) throw httpError('Recording was empty', 400);
  if (buffer.length > 40 * 1024 * 1024) throw httpError('Recording is too large', 413);
  const id = crypto.randomBytes(8).toString('hex');
  const filePath = path.join(os.tmpdir(), `mithium-scratch-${id}${extensionForMime(mime)}`);
  fs.writeFileSync(filePath, buffer);
  scratches.set(id, filePath);
  while (scratches.size > 24) {
    const oldest = scratches.keys().next().value;
    const oldPath = scratches.get(oldest);
    scratches.delete(oldest);
    if (oldPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  return { id, filePath };
}

function filesForMix(sources) {
  const files = {};
  const list = Array.isArray(sources) ? sources : [];
  for (const source of list) {
    if (!source || !source.key) throw httpError('A track is missing its audio', 400);
    if (source.clipId != null && source.clipId !== '') {
      const sound = soundboard.getSoundById(Number(source.clipId));
      if (!sound) throw httpError('A clip in this mix is missing', 404);
      const filePath = soundboard.getFilePath(sound.filename);
      if (!fs.existsSync(filePath)) throw httpError(`Missing audio for ${sound.name}`, 404);
      files[source.key] = filePath;
    } else if (source.scratchId) {
      const filePath = scratches.get(String(source.scratchId));
      if (!filePath || !fs.existsSync(filePath)) throw httpError('That recording expired. Record it again.', 400);
      files[source.key] = filePath;
    } else if (source.bytes) {
      files[source.key] = saveScratch(source.bytes, source.mime).filePath;
    } else {
      throw httpError('A track is missing its audio', 400);
    }
  }
  return files;
}

async function renderMix({ name, groupId, clips, sources, save }) {
  const list = Array.isArray(clips) ? clips : [];
  const trackIds = new Set(list.map((clip) => clip.trackId).filter(Boolean));
  if (trackIds.size > 10) throw httpError('Ten tracks is the limit', 400);
  if (list.some((clip) => clip.trackKind === 'voice' && clip.clipId != null && clip.sourceKey && String(clip.sourceKey).startsWith('clip:') && clip.trackKind === 'effects')) {
    throw httpError('Sound effects sit on their own track', 400);
  }
  const files = filesForMix(sources);
  const filename = `mix-${Date.now()}.wav`;
  const outputPath = save
    ? path.join(soundboard.getSoundsDir(), filename)
    : path.join(os.tmpdir(), filename);
  try {
    await clipEdit.renderMix({
      ffmpegPath: ffmpegPath(),
      clips: list,
      filesBySource: files,
      outputPath,
    });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    throw err;
  }
  if (!save) {
    return { filePath: outputPath, bytes: fs.readFileSync(outputPath) };
  }
  let renderedDuration = null;
  try {
    renderedDuration = await clipEdit.probeDurationMs(ffmpegPath(), outputPath);
  } catch {
    renderedDuration = null;
  }
  const involved = [];
  for (const clip of list) {
    if (clip.clipId == null) continue;
    involved.push(soundboard.getSoundById(Number(clip.clipId)));
  }
  const sound = soundboard.addSound({
    name: clipName(name, 'Voice mix'),
    filename,
    sourceType: 'edit',
    groupId: liveGroupId(groupId),
    durationMs: renderedDuration,
    mimeType: 'audio/wav',
    attribution: openverse.joinAttribution(involved),
  });
  return { sound, filePath: outputPath };
}

async function searchLibrary(query, page) {
  try {
    return await soundSearch.searchSounds(query, {
      page: Number(page) || 1,
      freesoundToken: settings.get('freesoundApiKey'),
    });
  } catch (err) {
    if (err instanceof myinstants.SoundSearchError && !err.status) {
      err.status = err.offline ? 503 : 400;
    }
    throw err;
  }
}

async function bytesToMp3(bytes, stem) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-import-'));
  const sourcePath = path.join(dir, `${stem || 'sound'}.bin`);
  const outputPath = path.join(dir, 'sound.mp3');
  fs.writeFileSync(sourcePath, Buffer.from(bytes));
  try {
    const converted = await mediaImport.convertFileToMp3({
      sourcePath,
      outputPath,
      ffmpegPath: ffmpegPath(),
      ffprobePath: ffprobePath(),
    });
    return {
      bytes: fs.readFileSync(outputPath),
      durationMs: converted.output.durationMs,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function previewLibrary(id) {
  try {
    const row = await soundSearch.resolveResult(id, { freesoundToken: settings.get('freesoundApiKey') });
    const file = await soundSearch.downloadPublic(row.audioUrl, fetch);
    const mp3 = await bytesToMp3(file.buffer, 'preview');
    const loaded = { ...row, durationMs: row.durationMs || mp3.durationMs };
    return {
      result: soundSearch.publicResult(loaded),
      mime: 'audio/mpeg',
      bytes: mp3.bytes,
    };
  } catch (err) {
    if (err instanceof myinstants.SoundSearchError && !err.status) {
      err.status = err.offline ? 503 : 400;
    }
    throw err;
  }
}

async function importLibrary({ id, name, groupId }) {
  try {
    const preview = await previewLibrary(id);
    return soundboard.addAudioClip({
      name: clipName(name, preview.result.title),
      bytes: preview.bytes,
      extension: '.mp3',
      sourceType: preview.result.source === 'Freesound' ? 'freesound' : 'myinstants',
      groupId: liveGroupId(groupId),
      durationMs: preview.result.durationMs,
      mimeType: 'audio/mpeg',
      attribution: {
        creator: preview.result.creator,
        license: preview.result.license,
        licenseUrl: preview.result.licenseUrl,
        sourceUrl: preview.result.sourceUrl,
        text: preview.result.attribution,
      },
    });
  } catch (err) {
    if (err instanceof myinstants.SoundSearchError && !err.status) {
      err.status = err.offline ? 503 : 400;
    }
    throw err;
  }
}

const grabs = new Map();

function rememberGrab(record) {
  grabs.set(record.grabId, record);
  while (grabs.size > 8) {
    const oldest = grabs.keys().next().value;
    const old = grabs.get(oldest);
    grabs.delete(oldest);
    if (old && old.filePath && fs.existsSync(old.filePath)) fs.unlinkSync(old.filePath);
  }
}

async function previewGrab({ query, skipIds }) {
  const shaped = soundGrab.shapeQuery(query);
  let stdout;
  try {
    stdout = await youtube.searchVideos({ query: shaped, ytdlpPath: ytdlpPath(), limit: 8 });
  } catch (err) {
    throw httpError(err.message || 'YouTube search failed', 502);
  }
  const entries = soundGrab.parseSearchPayload(stdout);
  let plan;
  try {
    plan = await soundGrab.planGrab({
      request: query,
      entries,
      skipIds,
      llm: {
        apiKey: settings.get('llmApiKey'),
        baseUrl: settings.get('llmBaseUrl'),
        model: settings.get('llmModel'),
      },
    });
  } catch (err) {
    throw httpError(err.message || 'No short match', 404);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-grab-'));
  const rough = path.join(dir, 'rough.mp3');
  const trimmed = path.join(dir, 'bite.mp3');
  try {
    await youtube.extractClip({
      url: plan.url,
      start: plan.section.start,
      end: plan.section.end,
      outputPath: rough,
      ytdlpPath: ytdlpPath(),
      ffmpegDir: ffmpegPath() ? path.dirname(ffmpegPath()) : '',
    });
    const trimmedProbe = await mediaImport.trimMainSound({
      ffmpegPath: ffmpegPath(),
      ffprobePath: ffprobePath(),
      inputPath: rough,
      outputPath: trimmed,
      maxSec: plan.section.maxSec,
    });
    if (fs.existsSync(rough)) fs.unlinkSync(rough);
    const bytes = fs.readFileSync(trimmed);
    const grabId = crypto.randomBytes(8).toString('hex');
    rememberGrab({
      grabId,
      filePath: trimmed,
      dir,
      title: plan.title,
      name: clipName(query, plan.title),
      sourceUrl: plan.url,
      videoId: plan.videoId,
      durationMs: trimmedProbe.durationMs,
    });
    return {
      grabId,
      videoId: plan.videoId,
      title: plan.title,
      shapedQuery: plan.shapedQuery,
      sourceUrl: plan.url,
      durationMs: trimmedProbe.durationMs,
      lengthLabel: openverse.formatDurationLabel(trimmedProbe.durationMs),
      mime: 'audio/mpeg',
      bytes,
    };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (err.status) throw err;
    throw httpError(err.message || 'Could not grab that sound', 502);
  }
}

async function saveGrab({ grabId, name, groupId }) {
  const grab = grabs.get(String(grabId || ''));
  if (!grab || !grab.filePath || !fs.existsSync(grab.filePath)) {
    throw httpError('That preview expired. Grab it again.', 404);
  }
  const filename = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp3`;
  const dest = path.join(soundboard.getSoundsDir(), filename);
  fs.copyFileSync(grab.filePath, dest);
  const { id } = soundboard.addSound({
    name: clipName(name, grab.name || grab.title),
    filename,
    sourceType: 'youtube',
    youtubeUrl: grab.sourceUrl,
    durationMs: grab.durationMs,
    mimeType: 'audio/mpeg',
    attribution: {
      creator: 'YouTube',
      license: '',
      sourceUrl: grab.sourceUrl,
      text: [grab.title, grab.sourceUrl].filter(Boolean).join(' '),
    },
  });
  return soundboard.getSoundById(id);
}

function readGrab(grabId) {
  const grab = grabs.get(String(grabId || ''));
  if (!grab || !grab.filePath || !fs.existsSync(grab.filePath)) {
    throw httpError('That preview expired. Grab it again.', 404);
  }
  return {
    grab,
    bytes: fs.readFileSync(grab.filePath),
    mime: 'audio/mpeg',
  };
}

module.exports = {
  saveRecording,
  renderEdit,
  renderMix,
  saveScratch,
  probeClip,
  readClip,
  searchOpenverse,
  previewOpenverse,
  importOpenverse,
  searchLibrary,
  previewLibrary,
  importLibrary,
  previewGrab,
  saveGrab,
  readGrab,
  mimeForFilename,
};
