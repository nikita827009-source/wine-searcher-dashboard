const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { importDataset } = require('../src/import/importer');
const { makeDb, sampleDataset, writeJson } = require('./helpers');

async function setup(env = {}) {
  const t = await makeDb();
  const file = writeJson(t.dir, 'd.json', sampleDataset());
  await importDataset(t.prisma, file, { dataDir: path.join(t.dir, 'data') });
  const app = createApp({ prisma: t.prisma, env: { ADMIN_TOKEN: 'secret-token', PROVIDER: 'mock', ...env }, datasetFile: file });
  return { ...t, app };
}

test('GET /api/products paginates and labels offers Demo (never Verified) after import', async () => {
  const { app, cleanup } = await setup();
  try {
    const r = await request(app).get('/api/products?pageSize=1&page=2').expect(200);
    assert.equal(r.body.total, 2);
    assert.equal(r.body.totalPages, 2);
    assert.equal(r.body.products.length, 1);
    const all = (await request(app).get('/api/products')).body.products;
    for (const p of all) {
      assert.equal(p.lowestVerified, null);
      assert.ok(p.offers.every((o) => o.status === 'DEMO' && o.lastVerifiedAt === null && o.url === null));
    }
    const alpha = all.find((p) => p.name === 'Alpha Cab');
    assert.equal(alpha.lowestObserved.price, 90);
    assert.equal(alpha.lowestObserved.percentDifference, -10);
  } finally { await cleanup(); }
});

test('filters: search, state, vendor, status; invalid params return 400', async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await request(app).get('/api/products?q=beta')).body.total, 1);
    assert.equal((await request(app).get('/api/products?q=FL-00001')).body.total, 1);
    assert.equal((await request(app).get('/api/products?state=NY')).body.total, 1);
    assert.equal((await request(app).get('/api/products?status=VERIFIED')).body.total, 0);
    assert.equal((await request(app).get('/api/products?status=DEMO')).body.total, 2);
    assert.equal((await request(app).get('/api/products?category=Red%20Wine%20-%20Cabernet')).body.total, 2);
    for (const q of ['page=0', 'pageSize=1000', 'status=BOGUS', 'vendor=abc', 'state=NEW']) {
      const r = await request(app).get(`/api/products?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error.code, 'VALIDATION');
    }
  } finally { await cleanup(); }
});

test('product detail, history, 404 and bad id', async () => {
  const { app, cleanup } = await setup();
  try {
    const list = (await request(app).get('/api/products')).body.products;
    const id = list[0].id;
    assert.equal((await request(app).get(`/api/products/${id}`).expect(200)).body.id, id);
    const h = await request(app).get(`/api/products/${id}/history`).expect(200);
    assert.ok(h.body.history.length >= 1);
    assert.equal((await request(app).get('/api/products/99999')).status, 404);
    assert.equal((await request(app).get('/api/products/abc')).status, 400);
    assert.equal((await request(app).get('/api/nope')).status, 404);
  } finally { await cleanup(); }
});

test('stats reflect demo data honestly', async () => {
  const { app, cleanup } = await setup();
  try {
    const s = (await request(app).get('/api/stats').expect(200)).body;
    assert.equal(s.products, 2);
    assert.equal(s.offerStatus.verified, 0);
    assert.equal(s.offerStatus.demo, 3);
    assert.equal(s.dataLabel, 'DEMO');
    assert.equal(s.lastSuccessfulRefresh, null);
  } finally { await cleanup(); }
});

test('refresh/import require a valid bearer token', async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await request(app).post('/api/refresh')).status, 401);
    assert.equal((await request(app).post('/api/refresh').set('Authorization', 'Bearer wrong')).status, 403);
    assert.equal((await request(app).post('/api/import')).status, 401);
    assert.equal((await request(app).post('/api/import?dryRun=true').set('Authorization', 'Bearer nope')).status, 403);
    const ok = await request(app).post('/api/refresh').set('Authorization', 'Bearer secret-token').expect(200);
    assert.equal(ok.body.status, 'SUCCESS');
    const jobs = (await request(app).get('/api/refresh/jobs')).body.jobs;
    assert.equal(jobs[0].status, 'SUCCESS');
    const imp = await request(app).post('/api/import?dryRun=true').set('Authorization', 'Bearer secret-token').expect(200);
    assert.equal(imp.body.dryRun, true);
  } finally { await cleanup(); }
});

test('without ADMIN_TOKEN configured the mutating endpoints are closed (503), not open', async () => {
  const { app, cleanup } = await setup({ ADMIN_TOKEN: '' });
  try {
    assert.equal((await request(app).post('/api/refresh')).status, 503);
    assert.equal((await request(app).post('/api/import')).status, 503);
  } finally { await cleanup(); }
});

test('unconfigured provider refresh returns SKIPPED, not success', async () => {
  const { app, cleanup } = await setup();
  try {
    const r = await request(app).post('/api/refresh').set('Authorization', 'Bearer secret-token').send({ provider: 'winesearcher-api' }).expect(200);
    assert.equal(r.body.status, 'SKIPPED');
    assert.match(r.body.job.errorSummary, /NOT_CONFIGURED/);
    assert.equal((await request(app).post('/api/refresh').set('Authorization', 'Bearer secret-token').send({ provider: 'nope' })).status, 400);
  } finally { await cleanup(); }
});

test('admin endpoints are rate limited', async () => {
  const { app, cleanup } = await setup({ ADMIN_RATE_LIMIT: '3' });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app).post('/api/import?dryRun=true').set('Authorization', 'Bearer secret-token')).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.equal(codes[4], 429);
  } finally { await cleanup(); }
});

test('providers endpoint never leaks secrets', async () => {
  const { app, cleanup } = await setup({ WINESEARCHER_API_KEY: 'super-secret-key-123' });
  try {
    const r = await request(app).get('/api/providers').expect(200);
    assert.ok(!JSON.stringify(r.body).includes('super-secret-key-123'));
    assert.ok(r.body.providers.find((p) => p.name === 'winesearcher-api').requires.includes('WINESEARCHER_API_KEY'));
  } finally { await cleanup(); }
});
