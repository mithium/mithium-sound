const fs = require('fs');
const path = require('path');
const soundboard = require('./soundboard');
const { buildEditTimeline } = require('../shared/editPlan');
const clipEdit = require('./clipEdit');
const openverse = require('./openverse');

const previewCache = new Map();

function ffmpegPath() {
  return process.env.FFMPEG_BIN || '';
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

module.exports = {
  saveRecording,
  renderEdit,
  probeClip,
  readClip,
  searchOpenverse,
  previewOpenverse,
  importOpenverse,
  mimeForFilename,
};
