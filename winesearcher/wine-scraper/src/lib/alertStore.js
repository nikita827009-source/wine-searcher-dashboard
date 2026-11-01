const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', '..', 'data', 'alerts.json');
const MAX_ALERTS = 500;

function loadAll() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return [];
}

function saveAll(alerts) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(alerts, null, 2));
}

function add(alert) {
  const all = loadAll();
  const entry = { id: crypto.randomUUID(), read: false, createdAt: new Date().toISOString(), ...alert };
  all.unshift(entry);
  saveAll(all.slice(0, MAX_ALERTS));
  return entry;
}

function getRecent({ limit = 50, unreadOnly = false } = {}) {
  const all = loadAll();
  return (unreadOnly ? all.filter((a) => !a.read) : all).slice(0, limit);
}

function unreadCount() {
  return loadAll().filter((a) => !a.read).length;
}

function markRead(ids) {
  const all = loadAll();
  const set = new Set(ids);
  let n = 0;
  for (const a of all) if (set.has(a.id) && !a.read) { a.read = true; n++; }
  if (n) saveAll(all);
  return n;
}

function markAllRead() {
  const all = loadAll();
  let n = 0;
  for (const a of all) if (!a.read) { a.read = true; n++; }
  if (n) saveAll(all);
  return n;
}

function clear() {
  saveAll([]);
}

module.exports = { add, getRecent, unreadCount, markRead, markAllRead, clear };
