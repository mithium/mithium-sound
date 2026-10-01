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
  assignSoundToGroup
};
