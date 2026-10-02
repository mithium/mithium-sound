#!/usr/bin/env node
// Minimal Home Server stub for Mithium Sound.
//
//   node scripts/home-server-stub.js --port 8787 --token lab-secret
//
// Implements the contract in docs/HOME_SERVER.md. State is in memory.

const http = require('http');
const crypto = require('crypto');

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

function authorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const apiKey = req.headers['x-api-key'] || '';
  return bearer === token || apiKey === token;
}

function upsert(list, record) {
  const index = list.findIndex((item) => item.id === record.id);
  if (index === -1) list.push(record);
  else list[index] = { ...list[index], ...record };
}

function lwwUpsert(list, incoming) {
  const index = list.findIndex((item) => item.id === incoming.id);
  if (index === -1) {
    list.push(incoming);
    return;
  }
  const current = list[index];
  const currentTime = Date.parse(current.updatedAt || '') || 0;
  const nextTime = Date.parse(incoming.updatedAt || '') || 0;
  if (nextTime >= currentTime) list[index] = { ...current, ...incoming };
}

function startStub(options = {}) {
  const token = options.token || '';
  const library = {
    revisedAt: new Date().toISOString(),
    groups: [...(options.groups || [])],
    clips: [...(options.clips || [])],
  };
  const audio = new Map();
  if (options.audio) {
    for (const [id, bytes] of options.audio.entries()) {
      audio.set(id, Buffer.from(bytes));
    }
  }
  const requests = [];

  function touch() {
    library.revisedAt = new Date().toISOString();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = Buffer.alloc(0);
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      headers: req.headers,
      body: raw.toString('utf8'),
    });

    if (!authorized(req, token)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      await route(req, res, url, raw);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  async function route(req, res, url, raw) {
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/library') {
      sendJson(res, 200, library);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sync') {
      const since = Date.parse(url.searchParams.get('since') || '') || 0;
      const newer = (row) => (Date.parse(row.updatedAt || '') || 0) > since;
      sendJson(res, 200, {
        revisedAt: library.revisedAt,
        groups: library.groups.filter(newer),
        clips: library.clips.filter(newer),
      });
      return;
    }

    if (req.method === 'PUT' && pathname === '/api/library') {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      for (const group of body.groups || []) lwwUpsert(library.groups, group);
      for (const clip of body.clips || []) lwwUpsert(library.clips, clip);
      touch();
      sendJson(res, 200, { revisedAt: library.revisedAt });
      return;
    }

    const groupMatch = pathname.match(/^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      const id = decodeURIComponent(groupMatch[1]);
      if (req.method === 'PUT') {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const group = {
          id,
          name: body.name || '',
          position: body.position || 0,
          updatedAt: body.updatedAt || new Date().toISOString(),
          deletedAt: body.deletedAt || null,
        };
        upsert(library.groups, group);
        touch();
        sendJson(res, 200, { group });
        return;
      }
      if (req.method === 'DELETE') {
        const now = new Date().toISOString();
        const existing = library.groups.find((group) => group.id === id);
        const group = {
          ...(existing || { id, name: '', position: 0 }),
          id,
          deletedAt: now,
          updatedAt: now,
        };
        upsert(library.groups, group);
        touch();
        sendJson(res, 200, { group });
        return;
      }
    }

    const audioMatch = pathname.match(/^\/api\/clips\/([^/]+)\/audio$/);
    if (audioMatch) {
      const id = decodeURIComponent(audioMatch[1]);
      if (req.method === 'GET') {
        const bytes = audio.get(id);
        const clip = library.clips.find((item) => item.id === id);
        if (!bytes || (clip && clip.deletedAt)) {
          sendJson(res, 404, { error: 'Audio not found' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes.length,
          'X-Content-Hash': hashBuffer(bytes),
        });
        res.end(bytes);
        return;
      }
      if (req.method === 'PUT') {
        const declared = req.headers['x-content-hash'] || '';
        const actual = hashBuffer(raw);
        if (declared && declared !== actual) {
          sendJson(res, 400, { error: 'Content hash mismatch' });
          return;
        }
        audio.set(id, raw);
        const clip = library.clips.find((item) => item.id === id);
        if (clip) clip.contentHash = actual;
        touch();
        sendJson(res, 200, { contentHash: actual });
        return;
      }
    }

    const clipMatch = pathname.match(/^\/api\/clips\/([^/]+)$/);
    if (clipMatch) {
      const id = decodeURIComponent(clipMatch[1]);
      if (req.method === 'PUT') {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const existing = library.clips.find((item) => item.id === id) || {};
        const clip = {
          ...existing,
          ...body,
          id,
          deletedAt: body.deletedAt || null,
          updatedAt: body.updatedAt || new Date().toISOString(),
        };
        upsert(library.clips, clip);
        touch();
        sendJson(res, 200, { clip });
        return;
      }
      if (req.method === 'DELETE') {
        const now = new Date().toISOString();
        const existing = library.clips.find((item) => item.id === id);
        const clip = {
          ...(existing || { id, name: '' }),
          id,
          deletedAt: now,
          updatedAt: now,
        };
        upsert(library.clips, clip);
        touch();
        sendJson(res, 200, { clip });
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
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
        library,
        audio,
        requests,
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function parseArgs(argv) {
  const out = { port: 8787, token: '', host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--token') out.token = argv[++i] || '';
    else if (argv[i] === '--host') out.host = argv[++i] || '127.0.0.1';
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  startStub(args).then((stub) => {
    console.log(`Home Server stub listening on ${stub.baseUrl}`);
    if (args.token) console.log('Auth: Bearer or X-Api-Key');
  });
}

module.exports = { startStub };
