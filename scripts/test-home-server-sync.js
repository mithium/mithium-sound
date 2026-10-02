#!/usr/bin/env node
// Home Server sync tests against the mithium-sound-library contract. No Electron required.
//   node scripts/test-home-server-sync.js

const crypto = require('crypto');
const assert = require('assert');
const { incrementalEvents, reconcileDeletes, clipPatchBody, groupWriteBody } = require('../src/main/sync/merge');
const { createClient } = require('../src/main/sync/client');
const { syncLibraries, hashBuffer } = require('../src/main/sync/engine');
const { startStub } = require('./home-server-stub');

let passed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok  ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

function tinyWav(payload) {
  const data = Buffer.from(payload || 'hello');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function clip(overrides) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    groupId: null,
    name: 'Airhorn',
    filename: 'airhorn.wav',
    hash: null,
    remoteHash: null,
    trimStartMs: null,
    trimEndMs: null,
    revision: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    dirty: false,
    synced: true,
    ...overrides,
  };
}

function createMemoryStore(initial = {}) {
  const state = {
    groups: (initial.groups || []).map((group) => ({ ...group })),
    clips: (initial.clips || []).map((item) => ({ ...item })),
    audio: new Map(),
    serverRevision: initial.serverRevision == null ? null : initial.serverRevision,
  };
  if (initial.audio) {
    for (const [id, bytes] of initial.audio.entries()) state.audio.set(id, Buffer.from(bytes));
  }
  function keep(existing, record, baseUpdatedAt) {
    if (!existing || !existing.dirty) return false;
    if (baseUpdatedAt && existing.updatedAt !== baseUpdatedAt) return true;
    if (!baseUpdatedAt && Number(existing.revision || 0) >= Number(record.revision || 0)) return true;
    return false;
  }
  return {
    getServerRevision: () => state.serverRevision,
    setServerRevision: (value) => {
      state.serverRevision = value;
    },
    getSnapshot: () => ({
      groups: state.groups.map((group) => ({ ...group })),
      clips: state.clips.map((item) => ({ ...item })),
    }),
    applyGroup(group, baseUpdatedAt) {
      const index = state.groups.findIndex((item) => item.id === group.id);
      if (index === -1) {
        state.groups.push({ ...group, dirty: false, synced: true });
        return;
      }
      if (keep(state.groups[index], group, baseUpdatedAt)) return;
      state.groups[index] = { ...state.groups[index], ...group, dirty: false, synced: true };
    },
    applyClip(item, baseUpdatedAt) {
      const index = state.clips.findIndex((row) => row.id === item.id);
      if (index === -1) {
        state.clips.push({
          ...item,
          remoteHash: item.hash || null,
          hash: null,
          dirty: false,
          synced: true,
          filename: item.filename || `${item.id}.wav`,
        });
        return;
      }
      if (keep(state.clips[index], item, baseUpdatedAt)) return;
      const existing = state.clips[index];
      state.clips[index] = {
        ...existing,
        ...item,
        filename: existing.filename || item.filename,
        remoteHash: item.hash || existing.remoteHash || null,
        hash: item.deletedAt ? existing.hash : existing.hash,
        dirty: false,
        synced: true,
      };
    },
    audioHash(id) {
      const bytes = state.audio.get(id);
      if (!bytes) return null;
      return hashBuffer(bytes);
    },
    readAudio(id) {
      return state.audio.get(id) || null;
    },
    writeAudio(id, bytes) {
      const buf = Buffer.from(bytes);
      state.audio.set(id, buf);
      const row = state.clips.find((item) => item.id === id);
      if (row) row.hash = hashBuffer(buf);
    },
    discardAudio(id) {
      state.audio.delete(id);
    },
    markSynced(kind, id, baseUpdatedAt) {
      const list = kind === 'group' ? state.groups : state.clips;
      const row = list.find((item) => item.id === id);
      if (!row) return;
      if (baseUpdatedAt && row.updatedAt !== baseUpdatedAt) return;
      row.dirty = false;
      row.synced = true;
    },
  };
}

async function main() {
  await test('incremental events apply in revision order and deletes come from sync', () => {
    const events = incrementalEvents({
      groups: { upserted: [], deleted: [] },
      clips: {
        upserted: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'A', revision: 3, hash: 'abc', groupId: null }],
        deleted: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 4, deletedAt: '2026-10-02T00:00:00.000Z' }],
      },
    });
    assert.deepStrictEqual(events.map((event) => event.op), ['upsert', 'delete']);
    assert.strictEqual(events[1].revision, 4);
  });

  await test('full-library reconcile drops clean synced rows and keeps dirty local-only rows', () => {
    const local = [
      clip({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 2, synced: true, dirty: false }),
      clip({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: null, synced: false, dirty: true, name: 'Only here' }),
    ];
    const removed = reconcileDeletes(local, []);
    assert.deepStrictEqual(removed.map((item) => item.id), ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  });

  await test('wire bodies omit server timestamps and discord fields', () => {
    const group = groupWriteBody({ id: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC', name: 'Bits', sortOrder: 1 });
    assert.strictEqual(group.id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(group, 'updatedAt'), false);
    const patch = clipPatchBody({ name: 'Airhorn', groupId: 'G', trimStartMs: 0, trimEndMs: 10, updatedAt: 'nope', youtubeUrl: 'https://youtu.be/x' });
    assert.deepStrictEqual(Object.keys(patch).sort(), ['groupId', 'name', 'trimEndMs', 'trimStartMs']);
  });

  await test('pull from stub stores hash, trim, and audio', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const bytes = tinyWav('from-lab');
    const stub = await startStub({
      token: 'lab-secret',
      clips: [{
        id,
        name: 'From Lab',
        groupId: '6c1e0e3a-1e2b-4c5d-8f90-123456789abc',
        trimStartMs: 10,
        trimEndMs: 40,
      }],
      audio: new Map([[id, bytes]]),
    });
    try {
      const store = createMemoryStore();
      const client = createClient({
        baseUrl: stub.baseUrl,
        token: 'lab-secret',
        forbiddenSecrets: ['discord-bot-token-do-not-send'],
      });
      const result = await syncLibraries({ client, store });
      assert.strictEqual(result.status, 'connected');
      const saved = store.getSnapshot().clips.find((item) => item.id === id);
      assert.ok(saved);
      assert.strictEqual(saved.name, 'From Lab');
      assert.strictEqual(saved.trimStartMs, 10);
      assert.strictEqual(saved.remoteHash, hashBuffer(bytes));
      assert.strictEqual(store.audioHash(id), hashBuffer(bytes));
      assert.strictEqual(store.getServerRevision(), stub.revision);
      const library = stub.libraryBody();
      assert.strictEqual(library.clips.some((item) => item.deletedAt), false);
      const leaked = stub.requests.some((req) => JSON.stringify(req.headers).includes('discord-bot-token-do-not-send') || (req.body || '').includes('discord-bot-token-do-not-send'));
      assert.strictEqual(leaked, false);
    } finally {
      await stub.close();
    }
  });

  await test('push uses multipart create and does not send timestamps or the discord token', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const bytes = tinyWav('made-offline');
    const stub = await startStub({ token: 'lab-secret' });
    try {
      const store = createMemoryStore({
        clips: [clip({
          id,
          name: 'Made Offline',
          hash: hashBuffer(bytes),
          dirty: true,
          synced: false,
          revision: null,
          filename: 'offline.wav',
        })],
        audio: new Map([[id, bytes]]),
      });
      const client = createClient({
        baseUrl: stub.baseUrl,
        token: 'lab-secret',
        forbiddenSecrets: ['discord-bot-token-do-not-send'],
      });
      const result = await syncLibraries({ client, store });
      assert.strictEqual(result.status, 'connected', result.message);
      const remote = stub.clips.find((item) => item.id === id);
      assert.ok(remote);
      assert.strictEqual(remote.name, 'Made Offline');
      assert.strictEqual(remote.hash, hashBuffer(bytes));
      const post = stub.requests.find((req) => req.method === 'POST' && req.path === '/api/clips');
      assert.ok(post);
      assert.match(post.headers['content-type'], /multipart\/form-data/);
      assert.strictEqual(post.fields.name, 'Made Offline');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(post.fields, 'updatedAt'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(post.fields, 'createdAt'), false);
      const dumped = JSON.stringify(stub.requests.map((req) => ({ path: req.path, json: req.json, fields: req.fields, auth: req.headers.authorization })));
      assert.strictEqual(dumped.includes('discord-bot-token-do-not-send'), false);
      assert.strictEqual(dumped.includes('botToken'), false);
    } finally {
      await stub.close();
    }
  });

  await test('delete on the stub is a sync tombstone and is absent from the full library', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    const localOnly = '66666666-6666-4666-8666-666666666666';
    const bytes = tinyWav('gone-soon');
    const localBytes = tinyWav('stay-local');
    const stub = await startStub({
      token: 'lab-secret',
      clips: [{ id, name: 'Gone Soon', groupId: '6c1e0e3a-1e2b-4c5d-8f90-123456789abc' }],
      audio: new Map([[id, bytes]]),
    });
    try {
      const store = createMemoryStore({
        clips: [clip({
          id: localOnly,
          name: 'PC Only',
          hash: hashBuffer(localBytes),
          dirty: true,
          synced: false,
          revision: null,
          filename: 'local.wav',
        })],
        audio: new Map([[localOnly, localBytes]]),
      });
      const client = createClient({ baseUrl: stub.baseUrl, token: 'lab-secret' });
      const first = await syncLibraries({ client, store });
      assert.strictEqual(first.status, 'connected', first.message);
      const del = await fetch(`${stub.baseUrl}/api/clips/${id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer lab-secret' },
      });
      assert.strictEqual(del.status, 204);
      const library = await (await fetch(`${stub.baseUrl}/api/library`, {
        headers: { Authorization: 'Bearer lab-secret' },
      })).json();
      assert.strictEqual(library.clips.some((item) => item.id === id), false);
      const sync = await (await fetch(`${stub.baseUrl}/api/sync?sinceRevision=${first.serverRevision}`, {
        headers: { Authorization: 'Bearer lab-secret' },
      })).json();
      assert.ok(sync.clips.deleted.some((item) => item.id === id));
      const second = await syncLibraries({ client, store });
      assert.strictEqual(second.status, 'connected', second.message);
      const names = store.getSnapshot().clips.filter((item) => !item.deletedAt).map((item) => item.name).sort();
      assert.ok(names.includes('PC Only'));
      assert.strictEqual(names.includes('Gone Soon'), false);
    } finally {
      await stub.close();
    }
  });

  await test('unreachable server leaves the local library unchanged', async () => {
    const stub = await startStub({ token: 'lab-secret' });
    const baseUrl = stub.baseUrl;
    await stub.close();
    const store = createMemoryStore({
      clips: [clip({ id: '77777777-7777-4777-8777-777777777777', name: 'Still Here', dirty: true, synced: false, revision: null })],
    });
    const before = JSON.stringify(store.getSnapshot());
    const client = createClient({ baseUrl, token: 'lab-secret' });
    const result = await syncLibraries({ client, store });
    assert.strictEqual(result.status, 'offline');
    assert.strictEqual(JSON.stringify(store.getSnapshot()), before);
  });

  await test('wrong token is an error and does not change local clips', async () => {
    const stub = await startStub({ token: 'lab-secret' });
    try {
      const store = createMemoryStore({ clips: [clip({ name: 'Untouched' })] });
      const before = JSON.stringify(store.getSnapshot());
      const client = createClient({ baseUrl: stub.baseUrl, token: 'nope' });
      const result = await syncLibraries({ client, store });
      assert.strictEqual(result.status, 'error');
      assert.match(result.message, /token/i);
      assert.strictEqual(JSON.stringify(store.getSnapshot()), before);
    } finally {
      await stub.close();
    }
  });

  await test('client refuses a group name that is the discord token before any write', async () => {
    const stub = await startStub({ token: 'lab-secret' });
    try {
      const client = createClient({
        baseUrl: stub.baseUrl,
        token: 'lab-secret',
        forbiddenSecrets: ['discord-bot-token-do-not-send'],
      });
      await assert.rejects(
        () => client.createGroup({ id: crypto.randomUUID(), name: 'discord-bot-token-do-not-send', sortOrder: 0 }),
        /Discord bot token/
      );
      assert.strictEqual(stub.requests.some((req) => req.method === 'POST'), false);
    } finally {
      await stub.close();
    }
  });

  await test('identical home-server token and bot token is refused before any request', async () => {
    const stub = await startStub({ token: 'discord-bot-token-do-not-send' });
    try {
      const before = stub.requests.length;
      const client = createClient({
        baseUrl: stub.baseUrl,
        token: 'discord-bot-token-do-not-send',
        forbiddenSecrets: ['discord-bot-token-do-not-send'],
      });
      await assert.rejects(() => client.health(), /must not be the Discord bot token/);
      assert.strictEqual(stub.requests.length, before);
    } finally {
      await stub.close();
    }
  });

  await test('local database accepts a lab clip and still plays when the server drops', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const Module = require('module');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-hs-'));
    const soundsDir = path.join(userData, 'sounds');
    fs.mkdirSync(soundsDir, { recursive: true });

    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE sounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, filename TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'local', youtube_url TEXT, youtube_start TEXT, youtube_end TEXT,
      position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    legacy.run(`CREATE TABLE groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    legacy.run(`INSERT INTO sounds (name, filename, source_type, position) VALUES ('Old Horn', 'old.mp3', 'local', 0)`);
    fs.writeFileSync(path.join(userData, 'mithium-sound.db'), Buffer.from(legacy.export()));
    fs.writeFileSync(path.join(soundsDir, 'old.mp3'), 'old-bytes');
    legacy.close();

    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return { app: { getPath: () => userData } };
      return originalLoad.call(this, request, parent, isMain);
    };
    const labId = '88888888-8888-4888-8888-888888888888';
    const labBytes = tinyWav('lab-audio');
    const stub = await startStub({
      token: 'lab-secret',
      clips: [{ id: labId, name: 'Lab Clip', groupId: '6c1e0e3a-1e2b-4c5d-8f90-123456789abc', trimStartMs: 5, trimEndMs: 15 }],
      audio: new Map([[labId, labBytes]]),
    });
    try {
      const soundboard = require('../src/main/soundboard');
      await soundboard.init();
      const playable = soundboard.getAllSounds();
      assert.strictEqual(playable[0].name, 'Old Horn');
      soundboard.deleteSound(playable[0].id);
      assert.strictEqual(soundboard.getAllSounds().length, 0);

      const keptId = '99999999-9999-4999-8999-999999999999';
      const keptBytes = tinyWav('kept');
      soundboard.applySyncedClip({
        id: keptId,
        name: 'From Server',
        hash: hashBuffer(keptBytes),
        revision: 1,
        trimStartMs: 0,
        trimEndMs: null,
        updatedAt: '2026-09-01T00:00:00.000Z',
        deletedAt: null,
      });
      soundboard.writeAudioBySyncId(keptId, keptBytes);
      assert.strictEqual(soundboard.getAudioHash(keptId), hashBuffer(keptBytes));

      soundboard.applySyncedClip({
        id: '../../outside',
        name: 'Outside',
        hash: null,
        revision: 1,
        updatedAt: '2026-11-01T00:00:00.000Z',
        deletedAt: null,
      });
      const outside = soundboard.getAllSounds().find((row) => row.name === 'Outside');
      assert.ok(outside);
      assert.strictEqual(outside.filename.includes('..'), false);

      fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
        botToken: 'discord-bot-token-do-not-send',
        homeServerEnabled: true,
        homeServerUrl: stub.baseUrl,
        homeServerToken: 'lab-secret',
      }));
      const homeserver = require('../src/main/homeserver');
      const synced = await homeserver.syncNow();
      assert.strictEqual(synced.status, 'connected', synced.message);
      const names = soundboard.getAllSounds().map((row) => row.name).sort();
      assert.ok(names.includes('Lab Clip'));
      assert.ok(names.includes('From Server'));
      assert.strictEqual(soundboard.getAudioHash(labId), hashBuffer(labBytes));
      const labRow = soundboard.getSyncSnapshot().clips.find((item) => item.id === labId);
      assert.strictEqual(labRow.trimStartMs, 5);
      assert.strictEqual(labRow.trimEndMs, 15);
      assert.strictEqual(
        stub.requests.some((req) => JSON.stringify(req.fields || req.json || {}).includes('discord-bot-token-do-not-send')
          || JSON.stringify(req.headers).includes('discord-bot-token-do-not-send')),
        false
      );
      await stub.close();
      const offline = await homeserver.syncNow();
      assert.strictEqual(offline.status, 'offline');
      assert.ok(soundboard.getAllSounds().some((row) => row.name === 'Lab Clip'));
    } finally {
      if (stub.server.listening) await stub.close();
      Module._load = originalLoad;
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  if (process.exitCode) {
    console.error('Home Server sync tests failed');
    process.exit(process.exitCode);
  }
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
