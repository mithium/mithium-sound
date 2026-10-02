const { app } = require('electron');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(app.getPath('userData'), 'mithium-sound.db');
const SOUNDS_DIR = path.join(app.getPath('userData'), 'sounds');

let db = null;

function persist() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
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
  
  persist();
}

function getAllSounds() {
  const stmt = db.prepare('SELECT * FROM sounds ORDER BY position, id');
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function addSound({ name, filename, sourceType = 'local', youtubeUrl, youtubeStart, youtubeEnd }) {
  const posStmt = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sounds');
  posStmt.step();
  const nextPos = posStmt.getAsObject().next;
  posStmt.free();

  db.run(
    `INSERT INTO sounds (name, filename, source_type, youtube_url, youtube_start, youtube_end, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, filename, sourceType, youtubeUrl || null, youtubeStart || null, youtubeEnd || null, nextPos]
  );
  const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  persist();
  return { id };
}

function deleteSound(id) {
  const stmt = db.prepare('SELECT * FROM sounds WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const sound = stmt.getAsObject();
    const filePath = path.join(SOUNDS_DIR, sound.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  stmt.free();
  db.run('DELETE FROM sounds WHERE id = ?', [id]);
  persist();
}

function renameSound(id, newName) {
  db.run('UPDATE sounds SET name = ? WHERE id = ?', [newName, id]);
  persist();
}

function reorderSound(id, newPosition) {
  db.run('UPDATE sounds SET position = ? WHERE id = ?', [newPosition, id]);
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
  const stmt = db.prepare('SELECT * FROM groups ORDER BY position, id');
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function createGroup(name) {
  const posStmt = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM groups');
  posStmt.step();
  const nextPos = posStmt.getAsObject().next;
  posStmt.free();
  
  db.run('INSERT INTO groups (name, position, collapsed) VALUES (?, ?, 1)', [name, nextPos]);
  const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  persist();
  return { id };
}

function renameGroup(id, newName) {
  db.run('UPDATE groups SET name = ? WHERE id = ?', [newName, id]);
  persist();
}

function deleteGroup(id) {
  db.run('UPDATE sounds SET group_id = NULL WHERE group_id = ?', [id]);
  db.run('DELETE FROM groups WHERE id = ?', [id]);
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
  db.run('UPDATE sounds SET group_id = ? WHERE id = ?', [groupId || null, soundId]);
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
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  return {
    restoredCount,
    manifest,
    tempBackupPath: tempBackup,
  };
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
};
