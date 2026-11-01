const { withRetry, mapLimit, ProviderError } = require('../providers/util');
const { isPrice } = require('../pricing/compare');

const LOCK_TTL_MS = 30 * 60000;
let inProcessRunning = false;

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

/**
 * One refresh run for a provider. Guarantees:
 *  - single flight: a RUNNING job younger than LOCK_TTL_MS blocks a new run (older ones are failed as abandoned)
 *  - provider not configured => job SKIPPED with the reason, nothing marked verified
 *  - history row only when the price changed (or the offer is new)
 *  - a failed batch keeps the previous price, records the error, and a VERIFIED offer becomes FAILED (not "current")
 *  - provider calls run concurrently; database writes are serialized (SQLite single writer), one transaction per batch
 *  - an unexpected crash marks the job FAILED instead of leaving it RUNNING
 */
async function runRefresh(prisma, provider, opts = {}) {
  const { trigger = 'MANUAL', batchSize = 100, concurrency = 2, retries = 2, baseMs = 200, timeoutMs = 15000, now = () => new Date() } = opts;

  if (inProcessRunning) return { status: 'BUSY', job: null };
  inProcessRunning = true;
  let job = null;
  try {
    const cutoff = new Date(now().getTime() - LOCK_TTL_MS);
    await prisma.refreshJob.updateMany({
      where: { status: 'RUNNING', startedAt: { lt: cutoff } },
      data: { status: 'FAILED', finishedAt: now(), errorSummary: 'Abandoned (exceeded lock TTL)' },
    });
    if (await prisma.refreshJob.findFirst({ where: { status: 'RUNNING' } })) return { status: 'BUSY', job: null };

    const st = provider.status();
    if (!st.configured) {
      const skipped = await prisma.refreshJob.create({
        data: { provider: provider.name, trigger, status: 'SKIPPED', finishedAt: now(), errorSummary: `${st.state}: ${st.reason}` },
      });
      return { status: 'SKIPPED', job: skipped };
    }

    job = await prisma.refreshJob.create({ data: { provider: provider.name, trigger, startedAt: now() } });
    const verifies = provider.verifies === true;
    const status = verifies ? 'VERIFIED' : 'DEMO';
    const errors = new Map();
    let processed = 0, succeeded = 0, failed = 0;

    const products = await prisma.product.findMany({
      select: { id: true, sourceKey: true, clientPrice: true, offers: { select: { id: true, vendorId: true, price: true, verificationStatus: true, vendor: { select: { name: true } } } } },
      orderBy: { id: 'asc' },
    });
    const vendors = new Map((await prisma.vendor.findMany()).map((v) => [v.name, v]));
    const autoCreate = provider.autoCreateVendors === true;
    const batches = [];
    for (let i = 0; i < products.length; i += batchSize) batches.push(products.slice(i, i + batchSize));

    let writeQueue = Promise.resolve();
    const enqueue = (fn) => {
      writeQueue = writeQueue.then(fn);
      return writeQueue;
    };

    const applyFailure = (batch, key) => enqueue(async () => {
      const ids = batch.flatMap((p) => p.offers.map((o) => o.id));
      await prisma.offer.updateMany({ where: { id: { in: ids } }, data: { error: key.slice(0, 300) } });
      await prisma.offer.updateMany({ where: { id: { in: ids }, verificationStatus: 'VERIFIED' }, data: { verificationStatus: 'FAILED' } });
    });

    const applyObservations = (batch, observations) => enqueue(() => prisma.$transaction(async (tx) => {
      const byProduct = new Map(batch.map((p) => [p.sourceKey, p]));
      for (const ob of observations) {
        const p = byProduct.get(ob.productKey);
        if (!p || !isPrice(ob.price)) {
          failed++;
          bump(errors, 'MALFORMED: invalid observation');
          continue;
        }
        let vendor = vendors.get(ob.vendorName);
        if (!vendor) {
          if (!autoCreate) {
            failed++;
            bump(errors, 'UNKNOWN_VENDOR');
            continue;
          }
          // Auto-create vendor on first encounter
          vendor = await tx.vendor.create({
            data: { name: ob.vendorName, sourceType: 'SCRAPER', integrationStatus: 'CONFIGURED' },
          });
          vendors.set(ob.vendorName, vendor);
        }
        const observedAt = ob.observedAt ? new Date(ob.observedAt) : now();
        const verifiedAt = verifies ? now() : null;
        const prev = p.offers.find((o) => o.vendorId === vendor.id);
        if (!prev) {
          const created = await tx.offer.create({ data: { productId: p.id, vendorId: vendor.id, price: ob.price, currency: ob.currency || null, availability: ob.availability ?? null, url: ob.url || null, location: ob.location || null, state: ob.state || null, source: provider.name, observedAt, lastVerifiedAt: verifiedAt, verificationStatus: status } });
          await tx.priceHistory.create({ data: { offerId: created.id, previousPrice: null, price: ob.price, currency: ob.currency || null, observedAt, source: provider.name, refreshJobId: job.id } });
        } else {
          await tx.offer.update({ where: { id: prev.id }, data: { price: ob.price, currency: ob.currency || null, availability: ob.availability ?? null, url: ob.url || undefined, location: ob.location || undefined, state: ob.state || undefined, source: provider.name, observedAt, lastVerifiedAt: verifiedAt ?? undefined, verificationStatus: status, error: null } });
          if (prev.price !== ob.price) {
            await tx.priceHistory.create({ data: { offerId: prev.id, previousPrice: prev.price, price: ob.price, currency: ob.currency || null, observedAt, source: provider.name, refreshJobId: job.id } });
          }
        }
        succeeded++;
      }
    }, { timeout: 120000, maxWait: 60000 }));

    await mapLimit(batches, concurrency, async (batch) => {
      const input = batch.map((p) => ({ sourceKey: p.sourceKey, clientPrice: p.clientPrice, offers: p.offers.map((o) => ({ vendorName: o.vendor.name })) }));
      processed += batch.length;
      let observations;
      try {
        const effectiveTimeoutMs = provider.fetchTimeoutMs ?? timeoutMs;
        observations = await withRetry(() => provider.fetchOffers(input), { retries, baseMs, timeoutMs: effectiveTimeoutMs });
        if (!Array.isArray(observations)) throw new ProviderError('MALFORMED', 'Provider returned a non-array response');
      } catch (e) {
        failed += batch.length;
        const key = `${e.code || 'ERROR'}: ${e.message}`;
        bump(errors, key);
        await applyFailure(batch, key);
        return;
      }
      await applyObservations(batch, observations);
    });
    await writeQueue;

    const finalStatus = failed === 0 ? 'SUCCESS' : succeeded === 0 ? 'FAILED' : 'PARTIAL';
    const errorSummary = errors.size ? [...errors].map(([k, n]) => `${k} (x${n})`).join('; ').slice(0, 1000) : null;
    const done = await prisma.refreshJob.update({ where: { id: job.id }, data: { status: finalStatus, finishedAt: now(), processed, succeeded, failed, errorSummary } });
    if (succeeded > 0 && verifies) await prisma.vendor.updateMany({ data: { lastSyncAt: now(), integrationStatus: 'CONFIGURED' } });
    return { status: finalStatus, job: done };
  } catch (e) {
    if (job) {
      await prisma.refreshJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: now(), errorSummary: `CRASH: ${e.message}`.slice(0, 1000) } }).catch(() => {});
    }
    throw e;
  } finally {
    inProcessRunning = false;
  }
}

module.exports = { runRefresh };
