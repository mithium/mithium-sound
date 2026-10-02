const { app } = require('electron');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(app.getPath('userData'), 'mithium-sound.db');
const SOUNDS_DIR = path.join(app.getPath('userData'), 'sounds');

let db = null;

function persist() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function nowIso() {
  return new Date().toISOString();
}

function toIso(value) {
  if (!value) return nowIso();
  const text = String(value);
  if (text.includes('T')) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? nowIso() : new Date(parsed).toISOString();
  }
  const parsed = Date.parse(`${text.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? nowIso() : new Date(parsed).toISOString();
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  return queryAll(sql, params)[0] || null;
}

function columnExists(table, name) {
  const info = db.exec(`PRAGMA table_info(${table})`);
  const columns = info[0]?.values || [];
  return columns.some((col) => col[1] === name);
}

function addColumn(table, name, definition) {
  if (!columnExists(table, name)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function migrateSyncColumns() {
  addColumn('sounds', 'sync_id', 'sync_id TEXT');
  addColumn('sounds', 'updated_at', 'updated_at TEXT');
  addColumn('sounds', 'content_hash', 'content_hash TEXT');
  addColumn('sounds', 'deleted_at', 'deleted_at TEXT');
  addColumn('sounds', 'dirty', 'dirty INTEGER NOT NULL DEFAULT 1');
  addColumn('sounds', 'synced', 'synced INTEGER NOT NULL DEFAULT 0');
  addColumn('sounds', 'hotkey', 'hotkey TEXT');
  addColumn('sounds', 'clip_volume', 'clip_volume REAL');

  addColumn('groups', 'sync_id', 'sync_id TEXT');
  addColumn('groups', 'updated_at', 'updated_at TEXT');
  addColumn('groups', 'deleted_at', 'deleted_at TEXT');
  addColumn('groups', 'dirty', 'dirty INTEGER NOT NULL DEFAULT 1');
  addColumn('groups', 'synced', 'synced INTEGER NOT NULL DEFAULT 0');

  const sounds = queryAll('SELECT id, sync_id, created_at, updated_at FROM sounds');
  for (const row of sounds) {
    if (row.sync_id) continue;
    db.run('UPDATE sounds SET sync_id = ?, updated_at = ? WHERE id = ?', [
      crypto.randomUUID(),
      row.updated_at || toIso(row.created_at),
      row.id,
    ]);
  }
  const groups = queryAll('SELECT id, sync_id, created_at, updated_at FROM groups');
  for (const row of groups) {
    if (row.sync_id) continue;
    db.run('UPDATE groups SET sync_id = ?, updated_at = ? WHERE id = ?', [
      crypto.randomUUID(),
      row.updated_at || toIso(row.created_at),
      row.id,
    ]);
  }

  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_sounds_sync_id ON sounds(sync_id)');
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_sync_id ON groups(sync_id)');
}

async function init() {
  if (!fs.existsSync(SOUNDS_DIR)) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
  }
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  
  db.run(`
    CREATE TABLE IF NOT EXISTS sounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'local',
      youtube_url TEXT,
      youtube_start TEXT,
      youtube_end TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      group_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  
  // Migration: add group_id column if it doesn't exist
  try {
    const tableInfo = db.exec('PRAGMA table_info(sounds)');
    const columns = tableInfo[0]?.values || [];
    const hasGroupId = columns.some(col => col[1] === 'group_id');
    if (!hasGroupId) {
      db.run('ALTER TABLE sounds ADD COLUMN group_id INTEGER');
      console.log('Added group_id column to sounds table');
    }
  } catch (err) {
    console.log('Migration check completed');
  }

  migrateSyncColumns();
  persist();
}

function getAllSounds() {
  return queryAll('SELECT * FROM sounds WHERE deleted_at IS NULL ORDER BY position, id');
}

function addSound({ name, filename, sourceType = 'local', youtubeUrl, youtubeStart, youtubeEnd }) {
  const posStmt = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sounds');
  posStmt.step();
  const nextPos = posStmt.getAsObject().next;
  posStmt.free();

  let contentHash = null;
  try {
    const filePath = getFilePath(filename);
    if (fs.existsSync(filePath)) contentHash = hashBuffer(fs.readFileSync(filePath));
  } catch (err) {
    console.error('Failed to hash sound file:', err.message);
  }

  db.run(
    `INSERT INTO sounds (
       name, filename, source_type, youtube_url, youtube_start, youtube_end, position,
       sync_id, updated_at, content_hash, dirty, synced
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    [
      name,
      filename,
      sourceType,
      youtubeUrl || null,
      youtubeStart || null,
      youtubeEnd || null,
      nextPos,
      crypto.randomUUID(),
      nowIso(),
      contentHash,
    ]
  );
  const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  persist();
  return { id };
}

function deleteSound(id) {
  const sound = queryOne('SELECT * FROM sounds WHERE id = ?', [id]);
  if (sound) {
    const filePath = path.join(SOUNDS_DIR, sound.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const now = nowIso();
  db.run(
    'UPDATE sounds SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?',
    [now, now, id]
  );
  persist();
}

function renameSound(id, newName) {
  db.run('UPDATE sounds SET name = ?, updated_at = ?, dirty = 1 WHERE id = ?', [newName, nowIso(), id]);
  persist();
}

function reorderSound(id, newPosition) {
  db.run('UPDATE sounds SET position = ?, updated_at = ?, dirty = 1 WHERE id = ?', [newPosition, nowIso(), id]);
  persist();
}

function getSoundsDir() {
  return SOUNDS_DIR;
}

function getFilePath(filename) {
  return path.join(SOUNDS_DIR, filename);
}

// --- Group Management ---
function getAllGroups() {
  return queryAll('SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY position, id');
}

function createGroup(name) {
  const posStmt = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM groups');
  posStmt.step();
  const nextPos = posStmt.getAsObject().next;
  posStmt.free();
  
  db.run(
    `INSERT INTO groups (name, position, collapsed, sync_id, updated_at, dirty, synced)
     VALUES (?, ?, 1, ?, ?, 1, 0)`,
    [name, nextPos, crypto.randomUUID(), nowIso()]
  );
  const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  persist();
  return { id };
}

function renameGroup(id, newName) {
  db.run('UPDATE groups SET name = ?, updated_at = ?, dirty = 1 WHERE id = ?', [newName, nowIso(), id]);
  persist();
}

function deleteGroup(id) {
  const now = nowIso();
  db.run(
    `UPDATE sounds
     SET group_id = NULL, updated_at = ?, dirty = 1
     WHERE group_id = ? AND deleted_at IS NULL`,
    [now, id]
  );
  db.run(
    'UPDATE groups SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?',
    [now, now, id]
  );
  persist();
}

function toggleGroupCollapsed(id) {
  db.run('UPDATE groups SET collapsed = 1 - collapsed WHERE id = ?', [id]);
  persist();
  const stmt = db.prepare('SELECT collapsed FROM groups WHERE id = ?');
  stmt.bind([id]);
  let collapsed = 1;
  if (stmt.step()) {
    collapsed = stmt.getAsObject().collapsed;
  }
  stmt.free();
  return { collapsed };
}

function assignSoundToGroup(soundId, groupId) {
  db.run(
    'UPDATE sounds SET group_id = ?, updated_at = ?, dirty = 1 WHERE id = ?',
    [groupId || null, nowIso(), soundId]
  );
  persist();
}

// --- Backup & Restore ---
function getLibraryInfo() {
  const sounds = getAllSounds();
  let totalSize = 0;
  
  for (const sound of sounds) {
    try {
      const filePath = getFilePath(sound.filename);
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
      }
    } catch (err) {
      console.error(`Failed to stat ${sound.filename}:`, err.message);
    }
  }
  
  return {
    soundCount: sounds.length,
    groupCount: getAllGroups().length,
    totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
    soundsDir: SOUNDS_DIR,
    dbPath: DB_PATH,
  };
}

async function backupLibrary(backupDir) {
  if (!fs.existsSync(backupDir)) {
    throw new Error('Backup directory does not exist');
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const backupName = `mithium-sound-backup-${timestamp}`;
  const backupPath = path.join(backupDir, backupName);
  
  fs.mkdirSync(backupPath, { recursive: true });
  
  // Copy database
  const dbBackupPath = path.join(backupPath, 'mithium-sound.db');
  fs.copyFileSync(DB_PATH, dbBackupPath);
  
  // Copy all sound files
  const soundsBackupDir = path.join(backupPath, 'sounds');
  fs.mkdirSync(soundsBackupDir, { recursive: true });
  
  const sounds = getAllSounds();
  let copiedCount = 0;
  
  for (const sound of sounds) {
    try {
      const srcPath = getFilePath(sound.filename);
      if (fs.existsSync(srcPath)) {
        const destPath = path.join(soundsBackupDir, sound.filename);
        fs.copyFileSync(srcPath, destPath);
        copiedCount++;
      }
    } catch (err) {
      console.error(`Failed to backup ${sound.filename}:`, err.message);
    }
  }
  
  // Create manifest
  const manifest = {
    backupDate: new Date().toISOString(),
    appVersion: require('../../package.json').version,
    soundCount: sounds.length,
    groupCount: getAllGroups().length,
    copiedFiles: copiedCount,
  };
  fs.writeFileSync(
    path.join(backupPath, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  
  return {
    backupPath,
    soundsCopied: copiedCount,
    totalSounds: sounds.length,
  };
}

async function restoreLibrary(backupPath) {
  const manifestPath = path.join(backupPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Invalid backup: manifest.json not found');
  }
  
  const dbBackupPath = path.join(backupPath, 'mithium-sound.db');
  const soundsBackupDir = path.join(backupPath, 'sounds');
  
  if (!fs.existsSync(dbBackupPath)) {
    throw new Error('Invalid backup: database file not found');
  }
  
  if (!fs.existsSync(soundsBackupDir)) {
    throw new Error('Invalid backup: sounds directory not found');
  }
  
  // Backup current state before restoring (safety measure)
  const tempBackup = path.join(app.getPath('temp'), `mithium-sound-pre-restore-${Date.now()}`);
  fs.mkdirSync(tempBackup, { recursive: true });
  
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, path.join(tempBackup, 'mithium-sound.db'));
  }
  
  if (fs.existsSync(SOUNDS_DIR)) {
    const files = fs.readdirSync(SOUNDS_DIR);
    const tempSoundsDir = path.join(tempBackup, 'sounds');
    fs.mkdirSync(tempSoundsDir, { recursive: true });
    for (const file of files) {
      fs.copyFileSync(
        path.join(SOUNDS_DIR, file),
        path.join(tempSoundsDir, file)
      );
    }
  }
  
  // Restore database
  fs.copyFileSync(dbBackupPath, DB_PATH);
  
  // Restore sound files
  if (!fs.existsSync(SOUNDS_DIR)) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
  }
  
  const backupFiles = fs.readdirSync(soundsBackupDir);
  let restoredCount = 0;
  
  for (const file of backupFiles) {
    try {
      const srcPath = path.join(soundsBackupDir, file);
      const destPath = path.join(SOUNDS_DIR, file);
      fs.copyFileSync(srcPath, destPath);
      restoredCount++;
    } catch (err) {
      console.error(`Failed to restore ${file}:`, err.message);
    }
  }
  
  // Reload database
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  db = new SQL.Database(buf);
  migrateSyncColumns();
  persist();
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  return {
    restoredCount,
    manifest,
    tempBackupPath: tempBackup,
  };
}

function groupMaps() {
  const rows = queryAll('SELECT id, sync_id FROM groups');
  const byLocal = new Map();
  const bySync = new Map();
  for (const row of rows) {
    if (!row.sync_id) continue;
    byLocal.set(row.id, row.sync_id);
    bySync.set(row.sync_id, row.id);
  }
  return { byLocal, bySync };
}

function ensureContentHash(row) {
  if (row.content_hash || !row.filename || row.deleted_at) return row.content_hash || null;
  const filePath = getFilePath(row.filename);
  if (!fs.existsSync(filePath)) return null;
  const hash = hashBuffer(fs.readFileSync(filePath));
  db.run('UPDATE sounds SET content_hash = ? WHERE id = ?', [hash, row.id]);
  row.content_hash = hash;
  return hash;
}

function rowToClip(row, byLocal) {
  return {
    id: row.sync_id,
    groupId: row.group_id ? (byLocal.get(row.group_id) || null) : null,
    name: row.name,
    filename: row.filename,
    contentHash: row.content_hash || null,
    sourceType: row.source_type || 'local',
    youtubeUrl: row.youtube_url || null,
    trimStart: row.youtube_start || null,
    trimEnd: row.youtube_end || null,
    volume: row.clip_volume == null ? null : row.clip_volume,
    hotkey: row.hotkey || null,
    position: row.position || 0,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    dirty: !!row.dirty,
    synced: !!row.synced,
  };
}

function rowToGroup(row) {
  return {
    id: row.sync_id,
    name: row.name,
    position: row.position || 0,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    dirty: !!row.dirty,
    synced: !!row.synced,
  };
}

function getSyncSnapshot() {
  const maps = groupMaps();
  const sounds = queryAll('SELECT * FROM sounds');
  let hashed = false;
  for (const row of sounds) {
    const before = row.content_hash;
    ensureContentHash(row);
    if (row.content_hash && row.content_hash !== before) hashed = true;
  }
  if (hashed) persist();
  return {
    groups: queryAll('SELECT * FROM groups').filter((row) => row.sync_id).map(rowToGroup),
    clips: sounds.filter((row) => row.sync_id).map((row) => rowToClip(row, maps.byLocal)),
  };
}

function safeSoundPath(filename) {
  const base = path.basename(String(filename || ''));
  if (!base || base === '.' || base === '..') return null;
  const root = path.resolve(SOUNDS_DIR);
  const resolved = path.resolve(root, base);
  if (resolved !== path.join(root, base)) return null;
  return resolved;
}

function safeSyncFilename(clip) {
  const ext = path.extname(String(clip.filename || '')).toLowerCase();
  const allowed = ['.mp3', '.wav', '.ogg', '.flac', '.webm', '.m4a', '.aac'];
  const useExt = allowed.includes(ext) ? ext : '.mp3';
  const raw = String(clip.id || '');
  const safe = /^[A-Za-z0-9_-]{1,128}$/.test(raw)
    ? raw
    : crypto.createHash('sha256').update(raw).digest('hex');
  return `sync-${safe}${useExt}`;
}

function applySyncedGroup(group) {
  if (!group || !group.id) return;
  const existing = queryOne('SELECT * FROM groups WHERE sync_id = ?', [group.id]);
  if (existing && Date.parse(existing.updated_at) > Date.parse(group.updatedAt)) return;
  if (!existing) {
    const posStmt = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM groups');
    posStmt.step();
    const fallback = posStmt.getAsObject().next;
    posStmt.free();
    db.run(
      `INSERT INTO groups (name, position, collapsed, sync_id, updated_at, deleted_at, dirty, synced)
       VALUES (?, ?, 1, ?, ?, ?, 0, 1)`,
      [
        group.name || 'Group',
        Number.isFinite(Number(group.position)) ? Number(group.position) : fallback,
        group.id,
        group.updatedAt,
        group.deletedAt || null,
      ]
    );
  } else {
    db.run(
      `UPDATE groups
       SET name = ?, position = ?, updated_at = ?, deleted_at = ?, dirty = 0, synced = 1
       WHERE sync_id = ?`,
      [
        group.name || existing.name,
        Number(group.position) || 0,
        group.updatedAt,
        group.deletedAt || null,
        group.id,
      ]
    );
    if (group.deletedAt) {
      db.run('UPDATE sounds SET group_id = NULL WHERE group_id = ?', [existing.id]);
    }
  }
  persist();
}

function applySyncedClip(clip) {
  if (!clip || !clip.id) return;
  const existing = queryOne('SELECT * FROM sounds WHERE sync_id = ?', [clip.id]);
  if (existing && Date.parse(existing.updated_at) > Date.parse(clip.updatedAt)) return;
  const groupLocalId = clip.groupId
    ? (queryOne('SELECT id FROM groups WHERE sync_id = ?', [clip.groupId]) || {}).id || null
    : null;
  if (!existing) {
    db.run(
      `INSERT INTO sounds (
         name, filename, source_type, youtube_url, youtube_start, youtube_end, position, group_id,
         sync_id, updated_at, content_hash, deleted_at, dirty, synced, hotkey, clip_volume
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      [
        clip.name || 'Clip',
        safeSyncFilename(clip),
        clip.sourceType || 'local',
        clip.youtubeUrl || null,
        clip.trimStart || null,
        clip.trimEnd || null,
        Number(clip.position) || 0,
        groupLocalId,
        clip.id,
        clip.updatedAt,
        null,
        clip.deletedAt || null,
        clip.hotkey || null,
        clip.volume == null ? null : clip.volume,
      ]
    );
  } else {
    // Clear the stored hash when remote bytes differ so a failed download cannot
    // win a timestamp tie and push the old file back. writeAudio sets the hash
    // after the bytes are verified.
    let nextHash = existing.content_hash || null;
    if (!clip.deletedAt && clip.contentHash && nextHash !== clip.contentHash) {
      nextHash = null;
    }
    db.run(
      `UPDATE sounds
       SET name = ?, source_type = ?, youtube_url = ?, youtube_start = ?, youtube_end = ?,
           position = ?, group_id = ?, updated_at = ?, content_hash = ?, deleted_at = ?,
           dirty = 0, synced = 1, hotkey = ?, clip_volume = ?
       WHERE sync_id = ?`,
      [
        clip.name || existing.name,
        clip.sourceType || existing.source_type || 'local',
        clip.youtubeUrl || null,
        clip.trimStart || null,
        clip.trimEnd || null,
        Number(clip.position) || 0,
        groupLocalId,
        clip.updatedAt,
        nextHash,
        clip.deletedAt || null,
        clip.hotkey || null,
        clip.volume == null ? null : clip.volume,
        clip.id,
      ]
    );
  }
  persist();
}

function getAudioHash(syncId) {
  const row = queryOne('SELECT filename, deleted_at FROM sounds WHERE sync_id = ?', [syncId]);
  if (!row || row.deleted_at || !row.filename) return null;
  const filePath = safeSoundPath(row.filename);
  if (!filePath || !fs.existsSync(filePath)) return null;
  return hashBuffer(fs.readFileSync(filePath));
}

function readAudioBySyncId(syncId) {
  const row = queryOne('SELECT filename FROM sounds WHERE sync_id = ?', [syncId]);
  if (!row || !row.filename) return null;
  const filePath = safeSoundPath(row.filename);
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

function writeAudioBySyncId(syncId, bytes) {
  const row = queryOne('SELECT * FROM sounds WHERE sync_id = ?', [syncId]);
  if (!row) throw new Error(`Unknown clip ${syncId}`);
  const filePath = safeSoundPath(row.filename);
  if (!filePath) throw new Error('Invalid sound filename');
  const buffer = Buffer.from(bytes);
  if (buffer.length > 100 * 1024 * 1024) {
    throw new Error('Audio file is too large');
  }
  fs.writeFileSync(filePath, buffer);
  const hash = hashBuffer(buffer);
  db.run('UPDATE sounds SET content_hash = ? WHERE sync_id = ?', [hash, syncId]);
  persist();
  return hash;
}

function discardAudioBySyncId(syncId) {
  const row = queryOne('SELECT filename FROM sounds WHERE sync_id = ?', [syncId]);
  if (!row || !row.filename) return;
  const filePath = safeSoundPath(row.filename);
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function markSyncAcknowledged(kind, syncId, updatedAt) {
  const table = kind === 'group' ? 'groups' : 'sounds';
  if (updatedAt) {
    db.run(
      `UPDATE ${table} SET dirty = 0, synced = 1 WHERE sync_id = ? AND updated_at = ?`,
      [syncId, updatedAt]
    );
  } else {
    db.run(`UPDATE ${table} SET dirty = 0, synced = 1 WHERE sync_id = ?`, [syncId]);
  }
  persist();
}

module.exports = { 
  init, 
  getAllSounds, 
  addSound, 
  deleteSound, 
  renameSound, 
  reorderSound, 
  getSoundsDir, 
  getFilePath,
  getAllGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  toggleGroupCollapsed,
  assignSoundToGroup,
  getLibraryInfo,
  backupLibrary,
  restoreLibrary,
  getSyncSnapshot,
  applySyncedGroup,
  applySyncedClip,
  getAudioHash,
  readAudioBySyncId,
  writeAudioBySyncId,
  discardAudioBySyncId,
  markSyncAcknowledged,
};
