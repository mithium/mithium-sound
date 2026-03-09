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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
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

module.exports = { init, getAllSounds, addSound, deleteSound, renameSound, reorderSound, getSoundsDir, getFilePath };
