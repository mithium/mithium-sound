#!/usr/bin/env node
// Renames of clips whose names contain spaces, parentheses, and underscores
// must stick in the database and survive a Home Server sync.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
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

function readRow(sql, dbPath, id) {
  const db = new sql.Database(fs.readFileSync(dbPath));
  const stmt = db.prepare('SELECT name, filename, sync_id, dirty FROM sounds WHERE id = ?');
  stmt.bind([id]);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  db.close();
  return row;
}

async function main() {
  await test('the rename dialog keeps the clip id before the dialog closes', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
    const start = source.indexOf("data-action=\"rename\"");
    const end = source.indexOf("data-action=\"delete\"");
    const block = source.slice(start, end);
    const idAt = block.indexOf('const id = contextTarget');
    const waitAt = block.indexOf('await showModal');
    assert.ok(idAt !== -1 && waitAt !== -1 && idAt < waitAt);
    assert.ok(block.includes('soundRename(id,'));
    assert.strictEqual(block.includes('soundRename(contextTarget'), false);
  });

  await test('names with spaces, parentheses, and underscores survive rename and sync', async () => {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mithium-rename-'));
    const soundsDir = path.join(userData, 'sounds');
    fs.mkdirSync(soundsDir, { recursive: true });
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return { app: { getPath: () => userData } };
      return originalLoad.call(this, request, parent, isMain);
    };
    const stub = await startStub({ token: 'lab-secret' });
    try {
      fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
        botToken: '',
        homeServerEnabled: true,
        homeServerUrl: stub.baseUrl,
        homeServerToken: 'lab-secret',
      }));
      const soundboard = require('../src/main/soundboard');
      const homeserver = require('../src/main/homeserver');
      await soundboard.init();

      const clips = [
        { name: 'Voice 261011_184715', filename: 'Voice 261011_184715.mp3', next: 'Mario coin' },
        { name: 'Voice (note)_184715', filename: 'Voice (note)_184715.mp3', next: 'Door (slam)' },
        { name: 'bruh_sound', filename: 'bruh_sound.mp3', next: 'Nope (under_score)' },
      ];
      const ids = [];
      for (const clip of clips) {
        fs.writeFileSync(path.join(soundsDir, clip.filename), tinyWav(clip.name));
        const created = soundboard.addSound({
          name: clip.name,
          filename: clip.filename,
          sourceType: 'local',
          mimeType: 'audio/mpeg',
        });
        ids.push(created.id);
        const renamed = soundboard.renameSound(created.id, clip.next);
        assert.strictEqual(renamed.name, clip.next);
        assert.strictEqual(renamed.filename, clip.filename);
        assert.ok(renamed.sync_id && renamed.sync_id !== clip.filename);
        assert.notStrictEqual(renamed.sync_id, clip.name);
        const stored = readRow(SQL, path.join(userData, 'mithium-sound.db'), created.id);
        assert.strictEqual(stored.name, clip.next);
        assert.strictEqual(stored.filename, clip.filename);
        assert.strictEqual(Number(stored.dirty), 1);
      }

      const first = await homeserver.syncNow();
      assert.strictEqual(first.status, 'connected', first.message);
      for (const clip of clips) {
        const remote = stub.clips.find((item) => item.name === clip.next);
        assert.ok(remote, `server missing ${clip.next}`);
        const post = stub.requests.find((req) => req.method === 'POST' && req.path === '/api/clips' && req.fields && req.fields.name === clip.next);
        assert.ok(post, `upload missing name ${clip.next}`);
        assert.notStrictEqual(post.fields.name, clip.filename);
      }
      for (let i = 0; i < clips.length; i += 1) {
        const local = soundboard.getSoundById(ids[i]);
        assert.strictEqual(local.name, clips[i].next);
        assert.strictEqual(local.filename, clips[i].filename);
      }

      const again = soundboard.renameSound(ids[0], 'bruh (sound_effect)');
      assert.strictEqual(again.name, 'bruh (sound_effect)');
      assert.strictEqual(again.filename, 'Voice 261011_184715.mp3');
      const second = await homeserver.syncNow();
      assert.strictEqual(second.status, 'connected', second.message);
      const third = await homeserver.syncNow();
      assert.strictEqual(third.status, 'connected', third.message);
      assert.strictEqual(soundboard.getSoundById(ids[0]).name, 'bruh (sound_effect)');
      assert.strictEqual(soundboard.getSoundById(ids[1]).name, 'Door (slam)');
      assert.strictEqual(soundboard.getSoundById(ids[2]).name, 'Nope (under_score)');
      const remote = stub.clips.find((item) => item.id === soundboard.getSoundById(ids[0]).sync_id);
      assert.ok(remote);
      assert.strictEqual(remote.name, 'bruh (sound_effect)');
      assert.ok(fs.existsSync(path.join(soundsDir, 'Voice 261011_184715.mp3')));
      assert.ok(crypto.randomUUID);
    } finally {
      if (stub.server.listening) await stub.close();
      Module._load = originalLoad;
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  if (process.exitCode) {
    console.error('Rename tests failed');
    process.exit(process.exitCode);
  }
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
