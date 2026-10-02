#!/usr/bin/env node
// In-memory stand-in for mithium-sound-library (API.md, version 0.1.0).
//
//   node scripts/home-server-stub.js --port 4092 --token lab-secret
//
// Not the live service. The live LAN base URL is http://192.168.0.211:4092.

const http = require('http');
const crypto = require('crypto');

const VERSION = '0.1.0';
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const TOMBSTONE_CAP = 5000;

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendEmpty(res, status) {
  res.writeHead(status);
  res.end();
}

function authorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const apiKey = req.headers['x-api-key'] || '';
  if (bearer && apiKey) return bearer === token;
  return bearer === token || apiKey === token;
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType || '');
  if (!match) {
    const error = new Error('Expected multipart/form-data');
    error.statusCode = 415;
    error.code = 'unsupported_media';
    throw error;
  }
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    let partStart = cursor + boundary.length;
    if (buffer.slice(partStart, partStart + 2).toString() === '--') break;
    if (buffer.slice(partStart, partStart + 2).toString() === '\r\n') partStart += 2;
    const next = buffer.indexOf(boundary, partStart);
    if (next === -1) break;
    const part = buffer.slice(partStart, Math.max(partStart, next - 2));
    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep === -1) break;
    const headerText = part.slice(0, sep).toString('utf8');
    const data = part.slice(sep + 4);
    const name = (/name="([^"]+)"/.exec(headerText) || [])[1];
    const filename = (/filename="([^"]*)"/.exec(headerText) || [])[1];
    parts.push({ name, filename, data });
    cursor = next;
  }
  return parts;
}

function isAllowedAudio(buffer) {
  if (!buffer || !buffer.length) return false;
  const head = buffer.slice(0, 16).toString('binary');
  if (head.startsWith('RIFF') && buffer.slice(8, 12).toString() === 'WAVE') return 'wav';
  if (head.startsWith('ID3') || buffer[0] === 0xff) return 'mp3';
  if (head.startsWith('OggS')) return 'ogg';
  if (head.startsWith('fLaC')) return 'flac';
  if (buffer.slice(4, 8).toString() === 'ftyp') return 'm4a';
  return null;
}

function mimeFor(kind) {
  return {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
  }[kind] || 'application/octet-stream';
}

function extFor(kind) {
  return kind === 'm4a' ? '.m4a' : `.${kind}`;
}

function nowIso() {
  return new Date().toISOString();
}

function startStub(options = {}) {
  const token = options.token || '';
  const groups = [];
  const clips = [];
  const audio = new Map();
  const groupTombstones = [];
  const clipTombstones = [];
  const requests = [];
  let revision = 0;

  function touch(entity) {
    revision += 1;
    const stamp = nowIso();
    entity.updatedAt = stamp;
    entity.revision = revision;
    return stamp;
  }

  function remember(list) {
    while (list.length > TOMBSTONE_CAP) list.shift();
  }

  function addGroup({ id, name, sortOrder }) {
    const stamp = nowIso();
    revision += 1;
    const group = {
      id,
      name,
      sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : groups.length,
      createdAt: stamp,
      updatedAt: stamp,
      revision,
    };
    groups.push(group);
    return group;
  }

  if (options.seedDefaultGroup !== false && !(options.groups || []).length) {
    addGroup({
      id: options.defaultGroupId || '6c1e0e3a-1e2b-4c5d-8f90-123456789abc',
      name: 'Ungrouped',
      sortOrder: 0,
    });
  }
  for (const group of options.groups || []) addGroup(group);
  for (const clip of options.clips || []) {
    revision += 1;
    const stamp = clip.updatedAt || nowIso();
    clips.push({
      durationMs: 0,
      trimStartMs: 0,
      trimEndMs: null,
      mimeType: 'audio/wav',
      sizeBytes: 0,
      ...clip,
      createdAt: clip.createdAt || stamp,
      updatedAt: stamp,
      revision: clip.revision || revision,
      audioPath: clip.audioPath || `audio/${clip.id}.wav`,
    });
    if (clip.revision && clip.revision > revision) revision = clip.revision;
  }
  if (options.audio) {
    for (const [id, bytes] of options.audio.entries()) {
      const buf = Buffer.from(bytes);
      audio.set(id, buf);
      const clip = clips.find((item) => item.id === id);
      if (clip) {
        clip.hash = hashBuffer(buf);
        clip.sizeBytes = buf.length;
      }
    }
  }

  function libraryBody() {
    return {
      version: VERSION,
      schemaVersion: 1,
      revision,
      updatedAt: nowIso(),
      hashAlgorithm: 'sha256',
      groups: groups.map((group) => ({ ...group })),
      clips: clips.map((clip) => ({ ...clip })),
    };
  }

  function rejectUnknown(body, allowed) {
    for (const key of Object.keys(body || {})) {
      if (!allowed.includes(key)) {
        const error = new Error(`Unknown field ${key}`);
        error.statusCode = 422;
        error.code = 'invalid';
        throw error;
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = Buffer.alloc(0);
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message, code: 'invalid' });
      return;
    }
    const record = {
      method: req.method,
      path: url.pathname,
      search: url.search,
      headers: req.headers,
      body: raw.toString('utf8'),
      json: null,
      fields: null,
    };
    requests.push(record);

    if (!authorized(req, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, { error: 'missing or invalid API key', code: 'unauthorized' });
      return;
    }

    try {
      await route(req, res, url, raw, record);
    } catch (err) {
      const status = err.statusCode || 500;
      sendJson(res, status, { error: err.message, code: err.code || 'invalid' });
    }
  });

  async function route(req, res, url, raw, record) {
    const contentType = req.headers['content-type'] || '';

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, version: VERSION });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/library') {
      sendJson(res, 200, libraryBody());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sync') {
      const sinceRevision = url.searchParams.get('sinceRevision');
      const since = url.searchParams.get('since');
      if (sinceRevision == null && since && Number.isNaN(Date.parse(since))) {
        sendJson(res, 400, { error: 'since is not ISO-8601', code: 'invalid_since' });
        return;
      }
      const cursor = sinceRevision == null ? null : Number(sinceRevision);
      const newer = (entity) => cursor == null || Number(entity.revision) > cursor;
      sendJson(res, 200, {
        version: VERSION,
        schemaVersion: 1,
        mode: sinceRevision == null && !since ? 'snapshot' : 'incremental',
        since: since || null,
        sinceRevision: cursor,
        serverTime: nowIso(),
        serverRevision: revision,
        hashAlgorithm: 'sha256',
        groups: {
          upserted: groups.filter(newer),
          deleted: groupTombstones.filter(newer),
        },
        clips: {
          upserted: clips.filter(newer),
          deleted: clipTombstones.filter(newer),
        },
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/groups') {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      record.json = body;
      rejectUnknown(body, ['name', 'sortOrder', 'id']);
      if (!body.name || !String(body.name).trim()) {
        sendJson(res, 422, { error: 'name is required', code: 'invalid' });
        return;
      }
      const id = body.id || crypto.randomUUID();
      if (groups.some((group) => group.id === id) || groupTombstones.some((group) => group.id === id)) {
        sendJson(res, 409, { error: 'id already used', code: 'conflict' });
        return;
      }
      const group = addGroup({ id, name: String(body.name).trim(), sortOrder: body.sortOrder });
      sendJson(res, 201, group);
      return;
    }

    const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      const id = decodeURIComponent(groupMatch[1]);
      const group = groups.find((item) => item.id === id);
      if (req.method === 'PATCH') {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        record.json = body;
        rejectUnknown(body, ['name', 'sortOrder']);
        if (!group) {
          sendJson(res, 404, { error: 'unknown id', code: 'not_found' });
          return;
        }
        if (body.name != null) group.name = String(body.name).trim();
        if (body.sortOrder != null) group.sortOrder = Number(body.sortOrder);
        touch(group);
        sendJson(res, 200, group);
        return;
      }
      if (req.method === 'DELETE') {
        if (!group) {
          sendJson(res, 404, { error: 'unknown id', code: 'not_found' });
          return;
        }
        if (clips.some((clip) => clip.groupId === id)) {
          sendJson(res, 409, { error: 'group still has clips', code: 'group_not_empty' });
          return;
        }
        groups.splice(groups.indexOf(group), 1);
        revision += 1;
        const tombstone = { id, revision, deletedAt: nowIso() };
        groupTombstones.push(tombstone);
        remember(groupTombstones);
        sendEmpty(res, 204);
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/clips') {
      let fields = {};
      let file = null;
      let filename = 'clip.wav';
      if (contentType.includes('multipart/form-data')) {
        const parts = parseMultipart(raw, contentType);
        fields = {};
        for (const part of parts) {
          if (part.filename != null && part.name === 'file') {
            file = part.data;
            filename = part.filename || filename;
          } else if (part.name) {
            fields[part.name] = part.data.toString('utf8');
          }
        }
        record.fields = { ...fields };
      } else {
        fields = JSON.parse(raw.toString('utf8') || '{}');
        record.json = fields;
        rejectUnknown(fields, ['id', 'name', 'groupId', 'audioBase64', 'mimeType', 'filename', 'durationMs', 'trimStartMs', 'trimEndMs']);
        if (!fields.audioBase64) {
          sendJson(res, 400, { error: 'audioBase64 is required', code: 'empty_audio' });
          return;
        }
        file = Buffer.from(String(fields.audioBase64), 'base64');
        filename = fields.filename || filename;
      }
      rejectUnknown(fields, ['id', 'name', 'groupId', 'durationMs', 'trimStartMs', 'trimEndMs', 'audioBase64', 'mimeType', 'filename']);
      const kind = isAllowedAudio(file);
      if (!kind) {
        sendJson(res, 415, { error: 'audio magic is not allowed', code: 'unsupported_media' });
        return;
      }
      if (file.length > MAX_AUDIO_BYTES) {
        sendJson(res, 413, { error: 'file exceeds MAX_UPLOAD_BYTES', code: 'too_large' });
        return;
      }
      const id = fields.id || crypto.randomUUID();
      if (clips.some((clip) => clip.id === id) || clipTombstones.some((clip) => clip.id === id)) {
        sendJson(res, 409, { error: 'id already used', code: 'conflict' });
        return;
      }
      const groupId = fields.groupId || (groups[0] && groups[0].id);
      if (!groupId || !groups.some((group) => group.id === groupId)) {
        sendJson(res, 400, { error: 'group is required', code: 'group_required' });
        return;
      }
      revision += 1;
      const stamp = nowIso();
      const clip = {
        id,
        name: fields.name || filename.replace(/\.[^.]+$/, '') || 'Untitled',
        groupId,
        durationMs: fields.durationMs == null ? 0 : Number(fields.durationMs),
        trimStartMs: fields.trimStartMs == null ? 0 : Number(fields.trimStartMs),
        trimEndMs: fields.trimEndMs == null ? null : Number(fields.trimEndMs),
        createdAt: stamp,
        updatedAt: stamp,
        audioPath: `audio/${id}${extFor(kind)}`,
        hash: hashBuffer(file),
        mimeType: mimeFor(kind),
        sizeBytes: file.length,
        revision,
      };
      clips.push(clip);
      audio.set(id, file);
      sendJson(res, 201, clip);
      return;
    }

    const audioMatch = url.pathname.match(/^\/api\/clips\/([^/]+)\/audio$/);
    if (audioMatch) {
      const id = decodeURIComponent(audioMatch[1]);
      const clip = clips.find((item) => item.id === id);
      if (req.method === 'GET') {
        const bytes = audio.get(id);
        if (!clip || !bytes) {
          sendJson(res, 404, { error: 'Audio not found', code: clip ? 'audio_missing' : 'not_found' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': clip.mimeType || 'application/octet-stream',
          'Content-Length': bytes.length,
          ETag: `"${clip.hash}"`,
          'Accept-Ranges': 'bytes',
        });
        res.end(bytes);
        return;
      }
      if (req.method === 'PUT') {
        if (!clip) {
          sendJson(res, 404, { error: 'unknown id', code: 'not_found' });
          return;
        }
        const parts = parseMultipart(raw, contentType);
        const filePart = parts.find((part) => part.name === 'file');
        const file = filePart && filePart.data;
        const kind = isAllowedAudio(file);
        if (!kind) {
          sendJson(res, 415, { error: 'audio magic is not allowed', code: 'unsupported_media' });
          return;
        }
        audio.set(id, file);
        clip.hash = hashBuffer(file);
        clip.mimeType = mimeFor(kind);
        clip.sizeBytes = file.length;
        clip.audioPath = `audio/${id}${extFor(kind)}`;
        clip.trimStartMs = 0;
        clip.trimEndMs = null;
        touch(clip);
        sendJson(res, 200, clip);
        return;
      }
    }

    const clipMatch = url.pathname.match(/^\/api\/clips\/([^/]+)$/);
    if (clipMatch) {
      const id = decodeURIComponent(clipMatch[1]);
      const clip = clips.find((item) => item.id === id);
      if (req.method === 'PATCH') {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        record.json = body;
        rejectUnknown(body, ['name', 'groupId', 'durationMs', 'trimStartMs', 'trimEndMs']);
        if (!clip) {
          sendJson(res, 404, { error: 'unknown id', code: 'not_found' });
          return;
        }
        if (body.name != null) clip.name = String(body.name);
        if (body.groupId != null) clip.groupId = body.groupId;
        if (body.trimStartMs != null) clip.trimStartMs = Number(body.trimStartMs);
        if (body.trimEndMs != null) clip.trimEndMs = Number(body.trimEndMs);
        if (body.durationMs != null) clip.durationMs = Number(body.durationMs);
        touch(clip);
        sendJson(res, 200, clip);
        return;
      }
      if (req.method === 'DELETE') {
        if (!clip) {
          sendJson(res, 404, { error: 'unknown id', code: 'not_found' });
          return;
        }
        clips.splice(clips.indexOf(clip), 1);
        audio.delete(id);
        revision += 1;
        clipTombstones.push({ id, revision, deletedAt: nowIso() });
        remember(clipTombstones);
        sendEmpty(res, 204);
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found', code: 'not_found' });
  }

  const port = options.port || 0;
  const host = options.host || '127.0.0.1';
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        baseUrl: `http://${host}:${address.port}`,
        groups,
        clips,
        audio,
        requests,
        get revision() {
          return revision;
        },
        libraryBody,
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

if (require.main === module) {
  const args = { port: 4092, token: '', host: '127.0.0.1' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--token') args.token = argv[++i] || '';
    else if (argv[i] === '--host') args.host = argv[++i] || '127.0.0.1';
  }
  startStub(args).then((stub) => {
    console.log(`mithium-sound-library stub listening on ${stub.baseUrl}`);
    console.log('Live LAN service, when used instead: http://192.168.0.211:4092');
  });
}

module.exports = { startStub, hashBuffer };
