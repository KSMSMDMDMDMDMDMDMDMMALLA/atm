const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

// ---- Загрузка/сохранение ----
let data = {
  participants: {},   // { userId: { username, firstName, addedAt, isActive } }
  settings: {},       // { key: value }
  lastMessage: {},    // { userId: timestamp }
  userTags: {},       // { userId: true/false }
  punishments: {}     // { userId: { type, untilTs, reason, createdAt } }
};

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      data = { ...data, ...parsed };
      // гарантируем, что вложенные объекты есть
      for (const k of ['participants', 'settings', 'lastMessage', 'userTags', 'punishments']) {
        if (!data[k] || typeof data[k] !== 'object') data[k] = {};
      }
    }
  } catch (e) {
    console.error('db load error:', e.message);
  }
}

let saveTimer = null;
function save() {
  // отложенная запись, чтобы не дёргать диск на каждое сообщение
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('db save error:', e.message);
    }
  }, 200);
}

load();

// ---- Участники ----
function addParticipant(user) {
  data.participants[user.id] = {
    username: user.username || null,
    firstName: user.first_name || null,
    addedAt: Date.now(),
    isActive: true
  };
  save();
}

function setParticipantActive(id, active) {
  if (!data.participants[id]) {
    data.participants[id] = { addedAt: Date.now(), isActive: !!active };
  } else {
    data.participants[id].isActive = !!active;
  }
  save();
}

function hasParticipant(id) {
  return !!data.participants[id];
}

function listParticipants() {
  return Object.entries(data.participants)
    .filter(([, p]) => p.isActive)
    .map(([id]) => Number(id));
}

function countParticipants() {
  return Object.keys(data.participants).length;
}

// ---- Настройки ----
function getSetting(key, defaultValue = null) {
  return key in data.settings ? data.settings[key] : defaultValue;
}
function setSetting(key, value) {
  data.settings[key] = String(value);
  save();
}

// ---- Антиспам ----
function getLastMessageTime(userId) {
  return data.lastMessage[userId] || 0;
}
function setLastMessageTime(userId, ts) {
  data.lastMessage[userId] = ts;
  save();
}

// ---- Тег ----
function isTagEnabled(userId) {
  return data.userTags[userId] === true;
}
function setTagEnabled(userId, enabled) {
  data.userTags[userId] = !!enabled;
  save();
}

// ---- Наказания ----
function getPunishment(userId) {
  const p = data.punishments[userId];
  if (!p) return null;
  if (p.untilTs !== 0 && p.untilTs < Date.now()) {
    delete data.punishments[userId];
    save();
    return null;
  }
  return { user_id: userId, type: p.type, until_ts: p.untilTs, reason: p.reason };
}
function setPunishment(userId, type, untilTs, reason) {
  data.punishments[userId] = { type, untilTs, reason: reason || null, createdAt: Date.now() };
  save();
}
function clearPunishment(userId) {
  delete data.punishments[userId];
  save();
}
function listPunishments() {
  return Object.entries(data.punishments)
    .filter(([, p]) => p.untilTs === 0 || p.untilTs > Date.now())
    .map(([id, p]) => ({ user_id: Number(id), type: p.type, until_ts: p.untilTs, reason: p.reason }));
}

module.exports = {
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
  setTagEnabled,
  getPunishment,
  setPunishment,
  clearPunishment,
  listPunishments
};