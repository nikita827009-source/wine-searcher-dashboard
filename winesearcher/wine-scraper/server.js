require('dotenv').config();
const path = require('path');
const cron = require('node-cron');
const prisma = require('./src/lib/db');
const { createApp } = require('./src/app');
const { createRegistry } = require('./src/providers');
const { runRefresh } = require('./src/jobs/refresh');
const settingsLib = require('./src/lib/settings');
const alertStore = require('./src/lib/alertStore');
const mailer = require('./src/lib/mailer');

const PORT = process.env.PORT || 5000;
mailer.init(process.env);

// ── Dynamic cron scheduler ────────────────────────────────────────────────────
const registry = createRegistry();
let cronJob = null;

function applyCron(expression) {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  if (!expression) return;
  if (!cron.validate(expression)) {
    console.error(`[scheduler] Invalid cron "${expression}" - scheduler disabled.`);
    return;
  }
  cronJob = cron.schedule(expression, async () => {
    const provider = registry.get();
    if (!provider) return;
    try {
      const r = await runRefresh(prisma, provider, { trigger: 'SCHEDULED' });
      console.log(`[scheduler] refresh ${r.status}`);
      if (r.job) await handlePostRefresh(r.job);
    } catch (e) {
      console.error('[scheduler] refresh crashed:', e.message);
    }
  });
  console.log(`[scheduler] refresh scheduled: ${expression}`);
}

// ── Post-refresh alert logic ──────────────────────────────────────────────────
async function handlePostRefresh(job) {
  if (!job || job.succeeded === 0) return;
  const settings = settingsLib.load();

  const changes = await prisma.priceHistory.findMany({
    where: { refreshJobId: job.id, previousPrice: { not: null } },
    include: { offer: { include: { vendor: { select: { name: true } }, product: { select: { name: true, vintage: true } } } } },
  });
  if (changes.length === 0) return;

  const threshold = settings.alertThresholdPct ?? 5;
  const significant = changes.filter((c) => {
    const pct = Math.abs((c.price - c.previousPrice) / c.previousPrice * 100);
    return pct >= threshold;
  });
  if (significant.length === 0) return;

  const entry = alertStore.add({
    jobId: job.id,
    provider: job.provider,
    totalChanges: changes.length,
    changes: significant.slice(0, 100).map((c) => ({
      productId: c.offer.productId,
      productName: c.offer.product.name,
      vintage: c.offer.product.vintage,
      vendor: c.offer.vendor.name,
      previousPrice: c.previousPrice,
      price: c.price,
      pctChange: Math.round((c.price - c.previousPrice) / c.previousPrice * 1000) / 10,
    })),
  });
  console.log(`[alerts] ${significant.length} significant price change(s) — alert #${entry.id.slice(0, 8)} created`);

  if (settings.alertEmail) {
    await mailer.sendPriceAlert(settings.alertEmail, entry).catch((e) => console.error('[alerts] email failed:', e.message));
  }
}

// Expose handlePostRefresh so manual refresh via API also triggers alerts
global.__handlePostRefresh = handlePostRefresh;

// ── Boot ──────────────────────────────────────────────────────────────────────
const app = createApp({
  prisma,
  registry,
  datasetFile: path.join(__dirname, 'wine_dataset.json'),
  apifyDatasetFile: process.env.APIFY_DATASET_FILE || null,
  csvDatasetFile: process.env.CSV_DATASET_FILE || null,
  onSettingsChange: (s) => applyCron(s.refreshCron),
});

// Load schedule from persistent settings (overrides REFRESH_CRON env var)
const savedSettings = settingsLib.load();
const initCron = savedSettings.refreshCron || process.env.REFRESH_CRON || '';
applyCron(initCron);

if (!process.env.ADMIN_TOKEN) console.warn('[auth] ADMIN_TOKEN not set - refresh/import endpoints are disabled (503).');

app.listen(PORT, () => console.log(`[Fine Liquors Pricing] http://localhost:${PORT}  provider=${registry.activeName()}`));
