const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.join(__dirname, '..');

/** Fresh migrated SQLite database in the OS temp dir; never touches the dev database. */
async function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-test-'));
  const url = `file:${path.join(dir, 'test.db').replace(/\\/g, '/')}`;
  execSync('npx prisma migrate deploy', { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  return { prisma, dir, cleanup: async () => { await prisma.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function sampleDataset(overrides = {}) {
  const mk = (id, name, price, offers) => ({
    id, wineName: name, vintage: '2015', region: 'Napa', category: 'Red Wine - Cabernet',
    clientPrice: price, lastUpdated: '2026-10-01T10:00:00.000Z',
    competitors: offers.map(([vendor, p, location]) => ({ vendor, price: p, location, rating: 4.5 })),
  });
  return {
    'alpha 2015': mk('alpha 2015', 'Alpha Cab', 100, [['Shop A', 90, 'California, USA'], ['Shop B', 110, 'New York, USA']]),
    'beta 2015': mk('beta 2015', 'Beta Cab', 200, [['Shop A', 210, 'California, USA']]),
    ...overrides,
  };
}

function writeJson(dir, name, obj) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}

module.exports = { makeDb, sampleDataset, writeJson, ROOT };
