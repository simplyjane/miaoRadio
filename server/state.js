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

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub    TEXT UNIQUE,
    email         TEXT,
    name          TEXT,
    picture_url   TEXT,
    invite_code   TEXT,
    is_guest      INTEGER NOT NULL DEFAULT 0,
    chats_used    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS user_corpus (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    taste       TEXT NOT NULL DEFAULT '',
    routines    TEXT NOT NULL DEFAULT '',
    mood_rules  TEXT NOT NULL DEFAULT '',
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    weather_city       TEXT,
    tts_reference_id   TEXT,
    updated_at         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_google (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    refresh_token  TEXT NOT NULL,
    access_token   TEXT,
    expires_at     INTEGER,
    scopes         TEXT,
    email          TEXT,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS song_reactions (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id  TEXT NOT NULL,
    reaction  INTEGER NOT NULL CHECK (reaction IN (-1, 1)),
    title     TEXT,
    artist    TEXT,
    ts        INTEGER NOT NULL,
    PRIMARY KEY (user_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_song_reactions_user_rxn ON song_reactions(user_id, reaction);
`);

// One-shot column adds for the messages/plays tables (idempotent).
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('messages', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
ensureColumn('plays', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_user_ts ON messages(user_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_plays_user_ts ON plays(user_id, ts DESC);
`);

/* ───── messages ───────────────────────────────────────────────────────── */

const stmtInsertMessage = db.prepare(
  `INSERT INTO messages (ts, role, content, user_id) VALUES (?, ?, ?, ?)`,
);
const stmtRecentMessagesForUser = db.prepare(
  `SELECT ts, role, content FROM messages WHERE user_id = ? ORDER BY ts DESC LIMIT ?`,
);
const stmtLastUserMessageForUser = db.prepare(
  `SELECT content FROM messages WHERE user_id = ? AND role = 'user' ORDER BY ts DESC LIMIT 1`,
);

export function recordMessage(role, content, userId) {
  if (!content || !userId) return;
  stmtInsertMessage.run(Date.now(), role, content, userId);
}

export function getRecentMessages(limit = 10, userId) {
  if (!userId) return [];
  return stmtRecentMessagesForUser.all(userId, limit).reverse();
}

export function getLastUserMessage(userId) {
  if (!userId) return null;
  return stmtLastUserMessageForUser.get(userId)?.content ?? null;
}

/* ───── plays ──────────────────────────────────────────────────────────── */

const stmtInsertPlay = db.prepare(
  `INSERT INTO plays (ts, video_id, title, artist, query, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
);
const stmtRecentPlaysForUser = db.prepare(
  `SELECT ts, video_id, title, artist FROM plays WHERE user_id = ? ORDER BY ts DESC LIMIT ?`,
);

export function recordPlay({ videoId, title, artist, query, userId }) {
  if (!videoId || !userId) return;
  stmtInsertPlay.run(Date.now(), videoId, title || null, artist || null, query || null, userId);
}

export function getRecentPlays(limit = 30, userId) {
  if (!userId) return [];
  return stmtRecentPlaysForUser.all(userId, limit);
}

/* ───── users ──────────────────────────────────────────────────────────── */

const stmtCreateGuestUser = db.prepare(
  `INSERT INTO users (is_guest, created_at) VALUES (1, ?)`,
);
const stmtGetUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const stmtGetUserByGoogleSub = db.prepare(`SELECT * FROM users WHERE google_sub = ?`);
const stmtIncrementChatsUsed = db.prepare(
  `UPDATE users SET chats_used = chats_used + 1 WHERE id = ?`,
);
const stmtBindGuestToGoogle = db.prepare(`
  UPDATE users
     SET google_sub = ?, email = ?, name = ?, picture_url = ?,
         invite_code = ?, is_guest = 0
   WHERE id = ?
`);
const stmtCreateSignedInUser = db.prepare(`
  INSERT INTO users (google_sub, email, name, picture_url, invite_code, is_guest, created_at)
  VALUES (?, ?, ?, ?, ?, 0, ?)
`);
const stmtDeleteUser = db.prepare(`DELETE FROM users WHERE id = ?`);

export function createGuestUser() {
  const info = stmtCreateGuestUser.run(Date.now());
  return Number(info.lastInsertRowid);
}

export function getUserById(id) {
  return stmtGetUserById.get(id) || null;
}

export function getUserByGoogleSub(sub) {
  return stmtGetUserByGoogleSub.get(sub) || null;
}

export function incrementChatsUsed(userId) {
  stmtIncrementChatsUsed.run(userId);
}

export function bindGuestToGoogle(userId, { googleSub, email, name, pictureUrl, inviteCode }) {
  stmtBindGuestToGoogle.run(googleSub, email, name, pictureUrl, inviteCode, userId);
}

export function createSignedInUser({ googleSub, email, name, pictureUrl, inviteCode }) {
  const info = stmtCreateSignedInUser.run(
    googleSub, email, name, pictureUrl, inviteCode, Date.now(),
  );
  return Number(info.lastInsertRowid);
}

export function deleteUser(userId) {
  stmtDeleteUser.run(userId);
}

/* ───── sessions ───────────────────────────────────────────────────────── */

const stmtCreateSession = db.prepare(
  `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
);
const stmtGetSession = db.prepare(`SELECT * FROM sessions WHERE token = ?`);
const stmtDeleteSession = db.prepare(`DELETE FROM sessions WHERE token = ?`);
const stmtDeleteSessionsForUser = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);

export function createSession(userId, token, ttlMs) {
  const now = Date.now();
  stmtCreateSession.run(token, userId, now, now + ttlMs);
}

export function getSession(token) {
  if (!token) return null;
  const row = stmtGetSession.get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    stmtDeleteSession.run(token);
    return null;
  }
  return row;
}

export function deleteSession(token) {
  if (token) stmtDeleteSession.run(token);
}

export function deleteSessionsForUser(userId) {
  stmtDeleteSessionsForUser.run(userId);
}

/* ───── per-user corpus ────────────────────────────────────────────────── */

const stmtGetCorpus = db.prepare(
  `SELECT taste, routines, mood_rules FROM user_corpus WHERE user_id = ?`,
);
const stmtUpsertCorpus = db.prepare(`
  INSERT INTO user_corpus (user_id, taste, routines, mood_rules, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    taste = excluded.taste,
    routines = excluded.routines,
    mood_rules = excluded.mood_rules,
    updated_at = excluded.updated_at
`);

export function getCorpus(userId) {
  if (!userId) return null;
  return stmtGetCorpus.get(userId) || null;
}

export function setCorpus(userId, { taste = '', routines = '', mood_rules = '' }) {
  stmtUpsertCorpus.run(userId, taste, routines, mood_rules, Date.now());
}

/* ───── per-user settings ──────────────────────────────────────────────── */

const stmtGetSettings = db.prepare(
  `SELECT weather_city, tts_reference_id FROM user_settings WHERE user_id = ?`,
);
const stmtUpsertSettings = db.prepare(`
  INSERT INTO user_settings (user_id, weather_city, tts_reference_id, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    weather_city = excluded.weather_city,
    tts_reference_id = excluded.tts_reference_id,
    updated_at = excluded.updated_at
`);

export function getSettings(userId) {
  if (!userId) return null;
  return stmtGetSettings.get(userId) || null;
}

export function setSettings(userId, { weather_city, tts_reference_id }) {
  stmtUpsertSettings.run(
    userId,
    weather_city || null,
    tts_reference_id || null,
    Date.now(),
  );
}

/* ───── per-user Google tokens (Calendar) ──────────────────────────────── */

const stmtGetGoogleTokens = db.prepare(`SELECT * FROM user_google WHERE user_id = ?`);
const stmtUpsertGoogleTokens = db.prepare(`
  INSERT INTO user_google (user_id, refresh_token, access_token, expires_at, scopes, email, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    refresh_token = excluded.refresh_token,
    access_token = excluded.access_token,
    expires_at = excluded.expires_at,
    scopes = excluded.scopes,
    email = excluded.email,
    updated_at = excluded.updated_at
`);
const stmtUpdateGoogleAccessToken = db.prepare(`
  UPDATE user_google SET access_token = ?, expires_at = ?, updated_at = ? WHERE user_id = ?
`);
const stmtDeleteGoogleTokens = db.prepare(`DELETE FROM user_google WHERE user_id = ?`);

export function getGoogleTokens(userId) {
  if (!userId) return null;
  return stmtGetGoogleTokens.get(userId) || null;
}

export function setGoogleTokens(userId, { refreshToken, accessToken, expiresAt, scopes, email }) {
  stmtUpsertGoogleTokens.run(
    userId,
    refreshToken,
    accessToken || null,
    expiresAt || null,
    scopes || null,
    email || null,
    Date.now(),
  );
}

export function updateGoogleAccessToken(userId, { accessToken, expiresAt }) {
  stmtUpdateGoogleAccessToken.run(accessToken, expiresAt, Date.now(), userId);
}

export function deleteGoogleTokens(userId) {
  stmtDeleteGoogleTokens.run(userId);
}

/* ───── per-user song reactions ────────────────────────────────────────── */

const stmtUpsertReaction = db.prepare(`
  INSERT INTO song_reactions (user_id, video_id, reaction, title, artist, ts)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, video_id) DO UPDATE SET
    reaction = excluded.reaction,
    title = COALESCE(excluded.title, song_reactions.title),
    artist = COALESCE(excluded.artist, song_reactions.artist),
    ts = excluded.ts
`);
const stmtDeleteReaction = db.prepare(
  `DELETE FROM song_reactions WHERE user_id = ? AND video_id = ?`,
);
const stmtListReactions = db.prepare(
  `SELECT video_id, reaction, title, artist, ts
     FROM song_reactions WHERE user_id = ? ORDER BY ts DESC`,
);
const stmtListDislikedVideoIds = db.prepare(
  `SELECT video_id FROM song_reactions WHERE user_id = ? AND reaction = -1`,
);
const stmtRecentLikedVideoIds = db.prepare(
  `SELECT video_id FROM song_reactions
    WHERE user_id = ? AND reaction = 1 AND ts > ?`,
);
const stmtRecentByReaction = db.prepare(
  `SELECT video_id, title, artist, ts
     FROM song_reactions WHERE user_id = ? AND reaction = ? ORDER BY ts DESC LIMIT ?`,
);

export function setReaction(userId, { videoId, reaction, title, artist }) {
  if (!userId || !videoId) return;
  if (reaction === 0 || reaction == null) {
    stmtDeleteReaction.run(userId, videoId);
    return;
  }
  if (reaction !== 1 && reaction !== -1) return;
  stmtUpsertReaction.run(userId, videoId, reaction, title || null, artist || null, Date.now());
}

export function listReactions(userId) {
  if (!userId) return [];
  return stmtListReactions.all(userId);
}

export function getDislikedVideoIds(userId) {
  if (!userId) return new Set();
  return new Set(stmtListDislikedVideoIds.all(userId).map((r) => r.video_id));
}

export function getRecentLikedVideoIds(userId, sinceTs) {
  if (!userId) return new Set();
  return new Set(stmtRecentLikedVideoIds.all(userId, sinceTs).map((r) => r.video_id));
}

export function getRecentByReaction(userId, reaction, limit = 30) {
  if (!userId) return [];
  return stmtRecentByReaction.all(userId, reaction, limit);
}
