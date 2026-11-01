const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { importDataset } = require('../src/import/importer');
const { runRefresh } = require('../src/jobs/refresh');
const { createMockProvider } = require('../src/providers/mock');
const { createWineSearcherProvider } = require('../src/providers/winesearcherApi');
const { ProviderError, withRetry, withTimeout, mapLimit } = require('../src/providers/util');
const { makeDb, sampleDataset, writeJson } = require('./helpers');

async function seeded() {
  const t = await makeDb();
  await importDataset(t.prisma, writeJson(t.dir, 'd.json', sampleDataset()), { dataDir: path.join(t.dir, 'data') });
  return t;
}
const fast = { baseMs: 1, retries: 2 };

/** Fake provider for scenarios; `verifies` makes results VERIFIED. */
const fake = (fetchOffers, { verifies = false, configured = true } = {}) => ({
  name: 'fake', verifies,
  meta: () => ({ name: 'fake' }),
  status: () => (configured ? { configured: true, state: 'CONFIGURED' } : { configured: false, state: 'NOT_CONFIGURED', reason: 'no key' }),
  fetchOffers,
});
const priceMap = (prices) => async (products) => products.flatMap((p) => p.offers.map((o) => ({ productKey: p.sourceKey, vendorName: o.vendorName, price: prices(p, o) })));

test('mock provider is deterministic for the same seed and varies with the seed', async () => {
  const input = [{ sourceKey: 'k', clientPrice: 100, offers: [{ vendorName: 'A' }] }];
  const a = await createMockProvider().fetchOffers(input, { seed: 's1' });
  const b = await createMockProvider().fetchOffers(input, { seed: 's1' });
  const c = await createMockProvider().fetchOffers(input, { seed: 's2' });
  assert.equal(a[0].price, b[0].price);
  assert.notEqual(a[0].price, c[0].price);
  assert.ok(a[0].price >= 92 && a[0].price <= 112);
});

test('refresh with mock provider: results are DEMO (never verified); history only for changed prices', async () => {
  const { prisma, cleanup } = await seeded();
  try {
    const provider = createMockProvider({ seed: 'r1' });
    const r1 = await runRefresh(prisma, provider, fast);
    assert.equal(r1.status, 'SUCCESS');
    assert.equal(r1.job.succeeded, 3);
    const histAfter1 = await prisma.priceHistory.count();
    assert.equal(histAfter1, 3 + 3, 'initial import rows + 3 changed prices');
    const offers = await prisma.offer.findMany();
    assert.ok(offers.every((o) => o.verificationStatus === 'DEMO' && o.lastVerifiedAt === null), 'mock must never produce verified offers');

    const r2 = await runRefresh(prisma, provider, fast); // identical observations
    assert.equal(r2.status, 'SUCCESS');
    assert.equal(await prisma.priceHistory.count(), histAfter1, 'identical observations create no duplicate history');
  } finally { await cleanup(); }
});

test('missing credentials => SKIPPED job with reason, no data changed, nothing verified', async () => {
  const { prisma, cleanup } = await seeded();
  try {
    const provider = createWineSearcherProvider({ env: {} });
    assert.equal(provider.status().state, 'NOT_CONFIGURED');
    const before = await prisma.offer.findMany({ orderBy: { id: 'asc' } });
    const r = await runRefresh(prisma, provider, fast);
    assert.equal(r.status, 'SKIPPED');
    assert.match(r.job.errorSummary, /NOT_CONFIGURED/);
    assert.deepEqual(await prisma.offer.findMany({ orderBy: { id: 'asc' } }), before);
    await assert.rejects(provider.fetchOffers([]), { code: 'NOT_CONFIGURED' });
  } finally { await cleanup(); }
});

test('key present but adapter unimplemented is reported honestly as not configured', async () => {
  const p = createWineSearcherProvider({ env: { WINESEARCHER_API_KEY: 'x' } });
  assert.equal(p.status().configured, false);
  assert.equal(p.status().state, 'NOT_IMPLEMENTED');
});

test('verifying provider: offers become VERIFIED with lastVerifiedAt; later failure keeps price and marks FAILED', async () => {
  const { prisma, cleanup } = await seeded();
  try {
    const ok = fake(priceMap((p) => p.clientPrice * 0.9), { verifies: true });
    const r1 = await runRefresh(prisma, ok, fast);
    assert.equal(r1.status, 'SUCCESS');
    let offers = await prisma.offer.findMany({ orderBy: { id: 'asc' } });
    assert.ok(offers.every((o) => o.verificationStatus === 'VERIFIED' && o.lastVerifiedAt instanceof Date));
    const priceBefore = offers.map((o) => o.price);

    const bad = fake(async () => { throw new ProviderError('UPSTREAM', 'boom', { retryable: false }); }, { verifies: true });
    const r2 = await runRefresh(prisma, bad, fast);
    assert.equal(r2.status, 'FAILED');
    assert.equal(r2.job.failed, 2);
    assert.match(r2.job.errorSummary, /UPSTREAM: boom/);
    offers = await prisma.offer.findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(offers.map((o) => o.price), priceBefore, 'previous valid price preserved');
    assert.ok(offers.every((o) => o.verificationStatus === 'FAILED' && o.error), 'failed offers are not marked current');
  } finally { await cleanup(); }
});

test('transient failures are retried and then succeed', async () => {
  const { prisma, cleanup } = await seeded();
  try {
    let calls = 0;
    const flaky = fake(async (products) => {
      if (++calls < 3) throw new ProviderError('RATE_LIMITED', 'slow down', { retryable: true, retryAfterMs: 1 });
      return priceMap((p) => p.clientPrice)(products);
    });
    const r = await runRefresh(prisma, flaky, { ...fast, retries: 3 });
    assert.equal(r.status, 'SUCCESS');
    assert.equal(calls, 3);
  } finally { await cleanup(); }
});

test('timeouts surface as TIMEOUT failures', async () => {
  const { prisma, cleanup } = await seeded();
  try {
    const slow = fake(() => new Promise(() => {}));
    const r = await runRefresh(prisma, slow, { ...fast, timeoutMs: 20, retries: 1 });
    assert.equal(r.status, 'FAILED');
    assert.match(r.job.errorSummary, /TIMEOUT/);
  } finally { await cleanup(); }
});

test('malformed responses and invalid prices are counted as failures, valid rows still applied (PARTIAL)', async () => {
  const { prisma, cleanup } = await seeded();
  try {
    const mixed = fake(async (products) => {
      const rows = await priceMap((p) => p.clientPrice)(products);
      rows[0].price = -5;
      return rows;
    });
    const r = await runRefresh(prisma, mixed, fast);
    assert.equal(r.status, 'PARTIAL');
    assert.equal(r.job.failed, 1);
    assert.equal(r.job.succeeded, 2);

    const notArray = fake(async () => ({ nope: true }));
    const r2 = await runRefresh(prisma, notArray, fast);
    assert.equal(r2.status, 'FAILED');
    assert.match(r2.job.errorSummary, /MALFORMED/);
  } finally { await cleanup(); }
});

test('overlapping refreshes are blocked (single flight)', async () => {
  const { prisma, cleanup } = await seeded();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = fake(async (products) => { await gate; return priceMap((p) => p.clientPrice)(products); });
    const first = runRefresh(prisma, slow, fast);
    await new Promise((r) => setTimeout(r, 100));
    const second = await runRefresh(prisma, slow, fast);
    assert.equal(second.status, 'BUSY');
    release();
    assert.equal((await first).status, 'SUCCESS');
    assert.equal(await prisma.refreshJob.count({ where: { status: 'RUNNING' } }), 0);
  } finally { await cleanup(); }
});

test('an abandoned RUNNING job older than the lock TTL does not block new runs', async () => {
  const { prisma, cleanup } = await seeded();
  try {
    await prisma.refreshJob.create({ data: { provider: 'x', status: 'RUNNING', startedAt: new Date(Date.now() - 3600000) } });
    const r = await runRefresh(prisma, createMockProvider(), fast);
    assert.equal(r.status, 'SUCCESS');
    assert.equal((await prisma.refreshJob.findFirst({ where: { provider: 'x' } })).status, 'FAILED');
  } finally { await cleanup(); }
});

test('withRetry: non-retryable errors are not retried; withTimeout rejects; mapLimit caps concurrency', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new ProviderError('X', 'no', { retryable: false }); }, { retries: 3, baseMs: 1 }));
  assert.equal(n, 1);
  await assert.rejects(withTimeout(() => new Promise(() => {}), 10), { code: 'TIMEOUT' });
  let active = 0, peak = 0;
  await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; });
  assert.equal(peak, 2);
});
