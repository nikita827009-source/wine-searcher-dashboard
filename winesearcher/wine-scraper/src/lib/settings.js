const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'settings.json');

const DEFAULTS = {
  refreshCron: '',       // '' = disabled; cron expression e.g. "0 8 * * *"
  alertThresholdPct: 5,  // alert when any price changes by >= this %
  alertEmail: '',        // empty = email alerts disabled
};

function load() {
  try {
    if (fs.existsSync(FILE)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {}
  return { ...DEFAULTS };
}

function save(updates) {
  const next = { ...load(), ...updates };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { load, save, DEFAULTS };
