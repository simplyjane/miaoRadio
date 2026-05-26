import Database from 'better-sqlite3';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(ROOT, 'state.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    role    TEXT NOT NULL CHECK (role IN ('user', 'dj')),
    content TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);

  CREATE TABLE IF NOT EXISTS plays (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    title    TEXT,
    artist   TEXT,
    query    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_plays_ts ON plays(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_plays_video ON plays(video_id);
`);

const stmtInsertMessage = db.prepare(
  `INSERT INTO messages (ts, role, content) VALUES (?, ?, ?)`,
);
const stmtRecentMessages = db.prepare(
  `SELECT ts, role, content FROM messages ORDER BY ts DESC LIMIT ?`,
);

const stmtInsertPlay = db.prepare(
  `INSERT INTO plays (ts, video_id, title, artist, query) VALUES (?, ?, ?, ?, ?)`,
);
const stmtRecentPlays = db.prepare(
  `SELECT ts, video_id, title, artist FROM plays ORDER BY ts DESC LIMIT ?`,
);

export function recordMessage(role, content) {
  if (!content) return;
  stmtInsertMessage.run(Date.now(), role, content);
}

export function recordPlay({ videoId, title, artist, query }) {
  if (!videoId) return;
  stmtInsertPlay.run(Date.now(), videoId, title || null, artist || null, query || null);
}

export function getRecentMessages(limit = 10) {
  return stmtRecentMessages.all(limit).reverse();
}

const stmtLastUserMessage = db.prepare(
  `SELECT content FROM messages WHERE role = 'user' ORDER BY ts DESC LIMIT 1`,
);

export function getLastUserMessage() {
  return stmtLastUserMessage.get()?.content ?? null;
}

export function getRecentPlays(limit = 30) {
  return stmtRecentPlays.all(limit);
}
