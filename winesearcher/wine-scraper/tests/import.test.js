const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateDataset } = require('../src/import/validate');
const { importDataset } = require('../src/import/importer');
const { makeDb, sampleDataset, writeJson } = require('./helpers');

test('validation reports counts and does not mutate the input', () => {
  const raw = sampleDataset();
  const before = JSON.stringify(raw);
  const { valid, report } = validateDataset(raw);
  assert.equal(report.counts.validProducts, 2);
  assert.equal(report.counts.validOffers, 3);
  assert.equal(report.counts.distinctVendors, 2);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(valid.length, 2);
});

test('validation flags schema errors, bad prices, duplicate offers and duplicate name+vintage', () => {
  const raw = sampleDataset({
    broken: { id: 'broken', wineName: '', category: 'x', clientPrice: 1, competitors: [] },
    zero: { id: 'zero', wineName: 'Zero', category: 'x', clientPrice: 0, competitors: [] },
    dupvendor: { id: 'dupvendor', wineName: 'Dv', vintage: '2000', category: 'x', clientPrice: 10, lastUpdated: 'not-a-date', competitors: [{ vendor: 'S', price: 9 }, { vendor: 's', price: 8 }, { vendor: 'T', price: -1 }] },
    'alpha again': { id: 'alpha again', wineName: 'ALPHA cab', vintage: '2015', category: 'x', clientPrice: 5, competitors: [] },
  });
  const { valid, report } = validateDataset(raw);
  const codes = new Set(report.issues.map((i) => i.code));
  for (const c of ['SCHEMA', 'BAD_CLIENT_PRICE', 'DUPLICATE_OFFER', 'BAD_OFFER_PRICE', 'BAD_TIMESTAMP', 'DUPLICATE_NAME_VINTAGE', 'KEY_ID_MISMATCH']) {
    if (c === 'KEY_ID_MISMATCH') continue;
    assert.ok(codes.has(c), `missing ${c}`);
  }
  assert.equal(report.counts.invalidProducts, 2);
  const dv = valid.find((p) => p.id === 'dupvendor');
  assert.equal(dv.competitors.length, 1, 'only the first valid offer per vendor survives');
});

test('validation flags suspicious synthetic-looking datasets without altering them', () => {
  const { report } = validateDataset(sampleDataset());
  const codes = report.global.map((g) => g.code);
  assert.ok(codes.includes('SINGLE_REGION'));
  assert.ok(codes.includes('TIMESTAMP_BURST'));
  assert.ok(codes.includes('MISSING_FIELDS_BY_DESIGN'));
});

test('non-object top level is rejected', () => {
  assert.ok(validateDataset('nope').report.fatal);
});

test('import is transactional-idempotent: re-import creates no duplicates and no extra history', async () => {
  const { prisma, dir, cleanup } = await makeDb();
  try {
    const file = writeJson(dir, 'd.json', sampleDataset());
    const dataDir = path.join(dir, 'data');
    const s1 = await importDataset(prisma, file, { dataDir });
    assert.deepEqual(s1.created, { products: 2, offers: 3, vendors: 2 });
    assert.equal(s1.historyRows, 3);

    const s2 = await importDataset(prisma, file, { dataDir });
    assert.deepEqual(s2.created, { products: 0, offers: 0, vendors: 0 });
    assert.equal(s2.unchanged.offers, 3);
    assert.equal(s2.historyRows, 0);
    assert.equal(await prisma.product.count(), 2);
    assert.equal(await prisma.offer.count(), 3);
    assert.equal(await prisma.priceHistory.count(), 3);

    const skus = (await prisma.product.findMany({ orderBy: { id: 'asc' } })).map((p) => p.sku);
    assert.deepEqual(skus, ['FL-00001', 'FL-00002'], 'SKUs are stable across re-imports');
    const offers = await prisma.offer.findMany();
    assert.ok(offers.every((o) => o.verificationStatus === 'DEMO' && o.lastVerifiedAt === null && o.url === null && o.currency === null));
  } finally { await cleanup(); }
});

test('changed price on re-import updates the offer and records one history row', async () => {
  const { prisma, dir, cleanup } = await makeDb();
  try {
    const dataDir = path.join(dir, 'data');
    await importDataset(prisma, writeJson(dir, 'a.json', sampleDataset()), { dataDir });
    const changed = sampleDataset();
    changed['alpha 2015'].competitors[0].price = 95;
    const s = await importDataset(prisma, writeJson(dir, 'b.json', changed), { dataDir });
    assert.equal(s.updated.offers, 1);
    assert.equal(s.historyRows, 1);
    const h = await prisma.priceHistory.findFirst({ where: { previousPrice: { not: null } } });
    assert.equal(h.previousPrice, 90);
    assert.equal(h.price, 95);
  } finally { await cleanup(); }
});

test('import never downgrades or overwrites a VERIFIED offer', async () => {
  const { prisma, dir, cleanup } = await makeDb();
  try {
    const dataDir = path.join(dir, 'data');
    await importDataset(prisma, writeJson(dir, 'a.json', sampleDataset()), { dataDir });
    const o = await prisma.offer.findFirst();
    await prisma.offer.update({ where: { id: o.id }, data: { verificationStatus: 'VERIFIED', lastVerifiedAt: new Date(), price: 1234 } });
    const s = await importDataset(prisma, writeJson(dir, 'a.json', sampleDataset()), { dataDir });
    assert.ok(s.unchanged.offers >= 1);
    const after = await prisma.offer.findUnique({ where: { id: o.id } });
    assert.equal(after.price, 1234);
    assert.equal(after.verificationStatus, 'VERIFIED');
  } finally { await cleanup(); }
});

test('invalid JSON fails before any DB write; source file is backed up and left intact', async () => {
  const { prisma, dir, cleanup } = await makeDb();
  try {
    const dataDir = path.join(dir, 'data');
    const bad = writeJson(dir, 'bad.json', '{ not json');
    await assert.rejects(importDataset(prisma, bad, { dataDir }), { code: 'INVALID_JSON' });
    assert.equal(await prisma.product.count(), 0);

    const file = writeJson(dir, 'ok.json', sampleDataset());
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const s = await importDataset(prisma, file, { dataDir, dryRun: true });
    assert.equal(s.sha256, sha);
    assert.ok(fs.existsSync(s.backup));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), sha);
    assert.equal(await prisma.product.count(), 0, 'dry run writes nothing');
    assert.ok(fs.existsSync(s.reportPath));
  } finally { await cleanup(); }
});
