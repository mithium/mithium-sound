#!/usr/bin/env node
// Offline-first Home Server sync tests. No Electron required.
//   node scripts/test-home-server-sync.js

const crypto = require('crypto');
const assert = require('assert');
const { pickWinner, planSync, publicClip } = require('../src/main/sync/merge');
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

function clip(overrides) {
  return {
    id: 'clip-1',
    groupId: null,
    name: 'Airhorn',
    filename: 'airhorn.mp3',
    contentHash: 'aaa',
    sourceType: 'local',
    youtubeUrl: null,
    trimStart: null,
    trimEnd: null,
    volume: null,
    hotkey: null,
    position: 0,
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
    since: initial.since || null,
  };
  if (initial.audio) {
    for (const [id, bytes] of initial.audio.entries()) {
      state.audio.set(id, Buffer.from(bytes));
    }
  }
  return {
    getSince: () => state.since,
    getSnapshot: () => ({
      groups: state.groups.map((group) => ({ ...group })),
      clips: state.clips.map((item) => ({ ...item })),
    }),
    applyGroup(group) {
      const index = state.groups.findIndex((item) => item.id === group.id);
      const next = { ...group, dirty: false, synced: true };
      if (index === -1) state.groups.push(next);
      else {
        if (Date.parse(state.groups[index].updatedAt) > Date.parse(group.updatedAt)) return;
        state.groups[index] = { ...state.groups[index], ...next };
      }
    },
    applyClip(item) {
      const index = state.clips.findIndex((row) => row.id === item.id);
      const next = { ...item, dirty: false, synced: true };
      if (index === -1) state.clips.push(next);
      else {
        if (Date.parse(state.clips[index].updatedAt) > Date.parse(item.updatedAt)) return;
        state.clips[index] = { ...state.clips[index], ...next, filename: state.clips[index].filename || item.filename };
      }
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
      if (row) row.contentHash = hashBuffer(buf);
    },
    discardAudio(id) {
      state.audio.delete(id);
    },
    markSynced(kind, id, updatedAt) {
      const list = kind === 'group' ? state.groups : state.clips;
      const row = list.find((item) => item.id === id);
      if (!row) return;
      if (updatedAt && row.updatedAt !== updatedAt) return;
      row.dirty = false;
      row.synced = true;
    },
    snapshot: () => state,
  };
}

async function main() {
  await test('newer updatedAt wins', () => {
    const local = clip({ updatedAt: '2026-02-01T00:00:00.000Z', name: 'Local' });
    const remote = clip({ updatedAt: '2026-03-01T00:00:00.000Z', name: 'Remote' });
    assert.strictEqual(pickWinner(local, remote), 'remote');
    assert.strictEqual(pickWinner(remote, local), 'local');
  });

  await test('tied timestamp uses greater content hash', () => {
    const local = clip({ contentHash: 'abc', updatedAt: '2026-02-01T00:00:00.000Z' });
    const remote = clip({ contentHash: 'zzz', updatedAt: '2026-02-01T00:00:00.000Z' });
    assert.strictEqual(pickWinner(local, remote), 'remote');
  });

  await test('full tie keeps local and does not transfer a clean row', () => {
    const local = clip();
    const remote = clip();
    assert.strictEqual(pickWinner(local, remote), 'equal');
    const plan = planSync([local], [remote], 'clip');
    assert.strictEqual(plan.pulls.length, 0);
    assert.strictEqual(plan.pushes.length, 0);
  });

  await test('local-only dirty clip is pushed and clean synced omission is kept', () => {
    const dirty = clip({ id: 'local-new', dirty: true, synced: false, name: 'New' });
    const kept = clip({ id: 'already', dirty: false, synced: true, name: 'Kept' });
    const plan = planSync([dirty, kept], [], 'clip');
    assert.deepStrictEqual(plan.pushes.map((item) => item.id), ['local-new']);
    assert.strictEqual(plan.pulls.length, 0);
  });

  await test('remote tombstone newer than local is pulled; older tombstone is not', () => {
    const live = clip({ updatedAt: '2026-02-01T00:00:00.000Z' });
    const newerDelete = clip({
      updatedAt: '2026-04-01T00:00:00.000Z',
      deletedAt: '2026-04-01T00:00:00.000Z',
    });
    const olderDelete = clip({
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.strictEqual(planSync([live], [newerDelete], 'clip').pulls.length, 1);
    const older = planSync(
      [clip({ updatedAt: '2026-03-01T00:00:00.000Z', name: 'Edited offline' })],
      [olderDelete],
      'clip'
    );
    assert.strictEqual(older.pulls.length, 0);
    assert.strictEqual(older.pushes.length, 1);
  });

  await test('public clip payload has no bot token field', () => {
    const payload = publicClip(clip({ botToken: 'should-not-copy' }));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'botToken'), false);
    assert.strictEqual(JSON.stringify(payload).includes('should-not-copy'), false);
  });

  await test('pull from stub updates the local library and audio', async () => {
    const id = crypto.randomUUID();
    const bytes = Buffer.from('RIFF-fake-airhorn');
    const contentHash = hashBuffer(bytes);
    const stub = await startStub({
      token: 'lab-secret',
      clips: [
        clip({
          id,
          name: 'From Lab',
          contentHash,
          filename: 'from-lab.mp3',
          updatedAt: '2026-05-01T00:00:00.000Z',
          dirty: false,
          synced: true,
        }),
      ],
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
      assert.strictEqual(result.libraryChanged, true);
      const saved = store.getSnapshot().clips.find((item) => item.id === id);
      assert.ok(saved, 'clip was pulled');
      assert.strictEqual(saved.name, 'From Lab');
      assert.strictEqual(store.audioHash(id), contentHash);
      const leaked = stub.requests.some((req) => JSON.stringify(req).includes('discord-bot-token-do-not-send'));
      assert.strictEqual(leaked, false);
    } finally {
      await stub.close();
    }
  });

  await test('push sends local offline edits and not the discord token', async () => {
    const id = crypto.randomUUID();
    const bytes = Buffer.from('local-clip-bytes');
    const contentHash = hashBuffer(bytes);
    const stub = await startStub({ token: 'lab-secret' });
    try {
      const store = createMemoryStore({
        clips: [
          clip({
            id,
            name: 'Made Offline',
            contentHash,
            dirty: true,
            synced: false,
            updatedAt: '2026-06-01T00:00:00.000Z',
          }),
        ],
        audio: new Map([[id, bytes]]),
      });
      const client = createClient({
        baseUrl: stub.baseUrl,
        token: 'lab-secret',
        forbiddenSecrets: ['discord-bot-token-do-not-send'],
      });
      const result = await syncLibraries({ client, store });
      assert.strictEqual(result.status, 'connected');
      assert.strictEqual(result.pushed, 1);
      const remote = stub.library.clips.find((item) => item.id === id);
      assert.ok(remote);
      assert.strictEqual(remote.name, 'Made Offline');
      assert.strictEqual(hashBuffer(stub.audio.get(id)), contentHash);
      const dumped = JSON.stringify(stub.requests);
      assert.strictEqual(dumped.includes('discord-bot-token-do-not-send'), false);
      assert.strictEqual(dumped.includes('botToken'), false);
      const row = store.getSnapshot().clips.find((item) => item.id === id);
      assert.strictEqual(row.dirty, false);
      assert.strictEqual(row.synced, true);
    } finally {
      await stub.close();
    }
  });

  await test('unreachable server leaves the local library unchanged and reports offline', async () => {
    const stub = await startStub({ token: 'lab-secret' });
    const baseUrl = stub.baseUrl;
    await stub.close();
    const store = createMemoryStore({
      clips: [clip({ id: 'stay', name: 'Still Here', dirty: true, synced: false })],
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
      const store = createMemoryStore({
        clips: [clip({ name: 'Untouched' })],
      });
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

  await test('client refuses to put a payload that contains the discord token', async () => {
    const stub = await startStub({ token: 'lab-secret' });
    try {
      const client = createClient({
        baseUrl: stub.baseUrl,
        token: 'lab-secret',
        forbiddenSecrets: ['discord-bot-token-do-not-send'],
      });
      await assert.rejects(
        () => client.putClip(publicClip(clip({ name: 'discord-bot-token-do-not-send' }))),
        /Discord bot token/
      );
      const puts = stub.requests.filter((req) => req.method === 'PUT');
      assert.strictEqual(puts.length, 0);
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

  await test('local database keeps playback rows offline and accepts a pulled clip', async () => {
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
    legacy.run(`
      CREATE TABLE sounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        filename TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'local',
        youtube_url TEXT,
        youtube_start TEXT,
        youtube_end TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    legacy.run(`
      CREATE TABLE groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    legacy.run(`INSERT INTO sounds (name, filename, source_type, position) VALUES ('Old Horn', 'old.mp3', 'local', 0)`);
    fs.writeFileSync(path.join(userData, 'mithium-sound.db'), Buffer.from(legacy.export()));
    fs.writeFileSync(path.join(soundsDir, 'old.mp3'), 'old-bytes');
    legacy.close();

    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') {
        return { app: { getPath: () => userData } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      const soundboardPath = require.resolve('../src/main/soundboard');
      delete require.cache[soundboardPath];
      const soundboard = require('../src/main/soundboard');
      await soundboard.init();

      const playable = soundboard.getAllSounds();
      assert.strictEqual(playable.length, 1);
      assert.strictEqual(playable[0].name, 'Old Horn');
      assert.ok(playable[0].sync_id, 'legacy clip received a sync id');

      const snap = soundboard.getSyncSnapshot();
      assert.strictEqual(snap.clips.length, 1);
      assert.strictEqual(snap.clips[0].dirty, true);
      assert.ok(snap.clips[0].contentHash);

      soundboard.deleteSound(playable[0].id);
      assert.strictEqual(soundboard.getAllSounds().length, 0, 'deleted clip is hidden from playback');
      const tombstone = soundboard.getSyncSnapshot().clips.find((item) => item.name === 'Old Horn');
      assert.ok(tombstone.deletedAt);

      const remoteId = '33333333-3333-4333-8333-333333333333';
      soundboard.applySyncedClip({
        id: remoteId,
        groupId: null,
        name: 'From Server',
        filename: 'remote.mp3',
        contentHash: hashBuffer(Buffer.from('remote-bytes')),
        sourceType: 'local',
        updatedAt: '2026-09-01T00:00:00.000Z',
        deletedAt: null,
        position: 1,
        volume: null,
        hotkey: null,
        trimStart: null,
        trimEnd: null,
      });
      assert.strictEqual(soundboard.getAllSounds().length, 1);
      assert.strictEqual(soundboard.getAllSounds()[0].name, 'From Server');
      soundboard.writeAudioBySyncId(remoteId, Buffer.from('remote-bytes'));
      assert.strictEqual(soundboard.getAudioHash(remoteId), hashBuffer(Buffer.from('remote-bytes')));
      assert.strictEqual(soundboard.getSyncSnapshot().clips.find((item) => item.id === remoteId).dirty, false);

      soundboard.applySyncedClip({
        id: '../../outside',
        groupId: null,
        name: 'Outside',
        filename: '../../outside.mp3',
        contentHash: null,
        sourceType: 'local',
        updatedAt: '2026-11-01T00:00:00.000Z',
        deletedAt: null,
        position: 2,
      });
      const outside = soundboard.getAllSounds().find((row) => row.name === 'Outside');
      assert.ok(outside);
      assert.strictEqual(outside.filename.includes('..'), false);
      assert.strictEqual(path.dirname(soundboard.getFilePath(outside.filename)), soundsDir);

      const labId = '44444444-4444-4444-8444-444444444444';
      const labBytes = Buffer.from('lab-audio-bytes');
      const stub = await startStub({
        token: 'lab-secret',
        clips: [
          clip({
            id: labId,
            name: 'Lab Clip',
            contentHash: hashBuffer(labBytes),
            filename: 'lab.mp3',
            updatedAt: '2026-10-01T00:00:00.000Z',
          }),
        ],
        audio: new Map([[labId, labBytes]]),
      });
      try {
        fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
          botToken: 'discord-bot-token-do-not-send',
          homeServerEnabled: true,
          homeServerUrl: stub.baseUrl,
          homeServerToken: 'lab-secret',
        }));
        const homeserver = require('../src/main/homeserver');
        const synced = await homeserver.syncNow();
        assert.strictEqual(synced.status, 'connected');
        const names = soundboard.getAllSounds().map((row) => row.name).sort();
        assert.deepStrictEqual(names, ['From Server', 'Lab Clip', 'Outside']);
        assert.strictEqual(soundboard.getAudioHash(labId), hashBuffer(labBytes));
        assert.strictEqual(
          stub.requests.some((req) => JSON.stringify(req).includes('discord-bot-token-do-not-send')),
          false
        );
        await stub.close();
        const offline = await homeserver.syncNow();
        assert.strictEqual(offline.status, 'offline');
        assert.deepStrictEqual(
          soundboard.getAllSounds().map((row) => row.name).sort(),
          ['From Server', 'Lab Clip', 'Outside']
        );
      } finally {
        if (stub.server.listening) await stub.close();
      }
    } finally {
      Module._load = originalLoad;
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  await test('remote edit wins and local-only clip is not deleted', async () => {
    const shared = crypto.randomUUID();
    const localOnly = crypto.randomUUID();
    const stub = await startStub({
      token: 'lab-secret',
      clips: [
        clip({
          id: shared,
          name: 'Server Name',
          contentHash: null,
          updatedAt: '2026-08-01T00:00:00.000Z',
        }),
      ],
    });
    try {
      const store = createMemoryStore({
        clips: [
          clip({
            id: shared,
            name: 'Old Local',
            contentHash: null,
            updatedAt: '2026-01-01T00:00:00.000Z',
            dirty: false,
            synced: true,
          }),
          clip({
            id: localOnly,
            name: 'PC Only',
            contentHash: null,
            dirty: false,
            synced: true,
            updatedAt: '2026-07-01T00:00:00.000Z',
          }),
        ],
      });
      const client = createClient({ baseUrl: stub.baseUrl, token: 'lab-secret' });
      const result = await syncLibraries({ client, store });
      assert.strictEqual(result.status, 'connected');
      const clips = store.getSnapshot().clips;
      assert.strictEqual(clips.find((item) => item.id === shared).name, 'Server Name');
      assert.ok(clips.find((item) => item.id === localOnly), 'local-only clip remains');
      assert.strictEqual(stub.library.clips.some((item) => item.id === localOnly), false);
    } finally {
      await stub.close();
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
