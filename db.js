const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'bot.db'));

// Таблица участников
db.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    user_id    INTEGER PRIMARY KEY,
    username   TEXT,
    first_name TEXT,
    added_at   INTEGER NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 1
  );
`);

// На случай старой БД без колонки is_active
try {
  db.exec(`ALTER TABLE participants ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
} catch (_) { /* колонка уже есть */ }

// Таблица настроек
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Таблица времени последнего сообщения (антиспам)
db.exec(`
  CREATE TABLE IF NOT EXISTS last_message (
    user_id     INTEGER PRIMARY KEY,
    last_ts     INTEGER NOT NULL
  );
`);

// Таблица настроек тега
db.exec(`
  CREATE TABLE IF NOT EXISTS user_tags (
    user_id     INTEGER PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 0
  );
`);

// --- Участники ---

const addStmt = db.prepare(`
  INSERT INTO participants (user_id, username, first_name, added_at, is_active)
  VALUES (?, ?, ?, ?, 1)
  ON CONFLICT(user_id) DO UPDATE SET
    username   = excluded.username,
    first_name = excluded.first_name,
    is_active  = 1
`);

const setActiveStmt = db.prepare(`UPDATE participants SET is_active = ? WHERE user_id = ?`);
const hasStmt        = db.prepare(`SELECT 1 FROM participants WHERE user_id = ?`);
const listActiveStmt = db.prepare(`SELECT user_id FROM participants WHERE is_active = 1 ORDER BY added_at`);
const countAllStmt   = db.prepare(`SELECT COUNT(*) AS c FROM participants`);

function addParticipant(user) {
  addStmt.run(user.id, user.username || null, user.first_name || null, Date.now());
}
function setParticipantActive(id, active) {
  setActiveStmt.run(active ? 1 : 0, id);
}
function hasParticipant(id) {
  return !!hasStmt.get(id);
}
function listParticipants() {
  return listActiveStmt.all().map(r => r.user_id);
}
function countParticipants() {
  return countAllStmt.get().c;
}

// --- Настройки ---

const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getSetting(key, defaultValue = null) {
  const row = getSettingStmt.get(key);
  return row ? row.value : defaultValue;
}
function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

// --- Антиспам ---

const getLastStmt = db.prepare(`SELECT last_ts FROM last_message WHERE user_id = ?`);
const setLastStmt = db.prepare(`
  INSERT INTO last_message (user_id, last_ts) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET last_ts = excluded.last_ts
`);

function getLastMessageTime(userId) {
  const row = getLastStmt.get(userId);
  return row ? row.last_ts : 0;
}
function setLastMessageTime(userId, ts) {
  setLastStmt.run(userId, ts);
}

// --- Тег ---

const getTagStmt = db.prepare(`SELECT enabled FROM user_tags WHERE user_id = ?`);
const setTagStmt = db.prepare(`
  INSERT INTO user_tags (user_id, enabled) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled
`);

function isTagEnabled(userId) {
  const row = getTagStmt.get(userId);
  return row ? row.enabled === 1 : false;
}
function setTagEnabled(userId, enabled) {
  setTagStmt.run(userId, enabled ? 1 : 0);
}

module.exports = {
  db,
  addParticipant,
  setParticipantActive,
  hasParticipant,
  listParticipants,
  countParticipants,
  getSetting,
  setSetting,
  getLastMessageTime,
  setLastMessageTime,
  isTagEnabled,
  setTagEnabled
};

// Таблица наказаний (ban/mute)
db.exec(`
  CREATE TABLE IF NOT EXISTS punishments (
    user_id    INTEGER PRIMARY KEY,
    type       TEXT NOT NULL,        -- 'ban' или 'mute'
    until_ts   INTEGER NOT NULL,     -- 0 = бессрочно
    reason     TEXT,
    created_at INTEGER NOT NULL
  );
`);

const getPunishStmt = db.prepare(`SELECT * FROM punishments WHERE user_id = ?`);
const setPunishStmt = db.prepare(`
  INSERT INTO punishments (user_id, type, until_ts, reason, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    type       = excluded.type,
    until_ts   = excluded.until_ts,
    reason     = excluded.reason,
    created_at = excluded.created_at
`);
const clearPunishStmt = db.prepare(`DELETE FROM punishments WHERE user_id = ?`);

function getPunishment(userId) {
  const row = getPunishStmt.get(userId);
  if (!row) return null;
  // Если истёк — удаляем и возвращаем null
  if (row.until_ts !== 0 && row.until_ts < Date.now()) {
    clearPunishStmt.run(userId);
    return null;
  }
  return row;
}
function setPunishment(userId, type, untilTs, reason) {
  setPunishStmt.run(userId, type, untilTs, reason || null, Date.now());
}
function clearPunishment(userId) {
  clearPunishStmt.run(userId);
}
function listPunishments() {
  return db.prepare(`SELECT * FROM punishments`).all()
    .filter(p => p.until_ts === 0 || p.until_ts > Date.now());
}