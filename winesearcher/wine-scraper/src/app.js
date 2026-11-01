const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { requireAdmin } = require('./middleware/auth');
const { compareProduct, freshness, priceChange } = require('./pricing/compare');
const { runRefresh } = require('./jobs/refresh');
const { importDataset } = require('./import/importer');
const settingsLib = require('./lib/settings');
const alertStore = require('./lib/alertStore');
const { importApifyDataset } = require('./import/apifyImporter');
const { importCsv } = require('./import/csvImporter');
const { createRegistry } = require('./providers');

const apiError = (res, status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });

/** Display status: a VERIFIED offer whose verification has aged out is shown as STALE. */
function effectiveStatus(offer, now, staleHours) {
  if (offer.verificationStatus === 'VERIFIED' && freshness(offer, now, staleHours) !== 'fresh') return 'STALE';
  return offer.verificationStatus;
}

function createApp({ prisma, env = process.env, registry = createRegistry({ env }), datasetFile, apifyDatasetFile, csvDatasetFile, now = () => new Date(), onSettingsChange = null } = {}) {
  const app = express();
  const staleHours = Number(env.STALE_AFTER_HOURS) || 48;
  const origins = (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false })); // fine.html uses inline script/style and Google Fonts
  app.use(cors({ origin: origins.length ? origins : false, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', '..')));

  const adminLimiter = rateLimit({ windowMs: 60000, limit: Number(env.ADMIN_RATE_LIMIT) || 10, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } } });
  const admin = [adminLimiter, requireAdmin(env)];
  const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const serializeOffer = (offer, row) => ({
    id: offer.id,
    vendorId: offer.vendorId,
    vendor: offer.vendor?.name,
    price: offer.price,
    currency: offer.currency,
    location: offer.location,
    state: offer.state,
    rating: offer.rating,
    url: offer.url,
    availability: offer.availability,
    shipping: offer.shipping,
    tax: offer.tax,
    source: offer.source,
    observedAt: offer.observedAt,
    lastVerifiedAt: offer.lastVerifiedAt,
    status: effectiveStatus(offer, now(), staleHours),
    error: offer.error,
    comparable: row.comparable,
    exclusionReasons: row.exclusionReasons,
    assumptions: row.assumptions,
    difference: row.difference,
    percentDifference: row.percentDifference,
  });

  const serializeProduct = (p) => {
    const cmp = compareProduct(p, p.offers, { now: now(), staleAfterHours: staleHours });
    return {
      id: p.id, sku: p.sku, name: p.name, vintage: p.vintage, category: p.category, region: p.region,
      bottleSize: p.bottleSize, currency: p.currency, clientPrice: p.clientPrice,
      offerCount: p.offers.length,
      comparableCount: cmp.comparableCount,
      verifiedCount: cmp.verifiedCount,
      lowestObserved: cmp.lowestObserved,
      lowestVerified: cmp.lowestVerified,
      lowestDelivered: cmp.lowestDelivered,
      offers: cmp.rows.map((r) => serializeOffer(r.offer, r)),
    };
  };

  app.get('/api/health', ah(async (req, res) => {
    const [products, offers] = await Promise.all([prisma.product.count(), prisma.offer.count()]);
    res.json({ status: 'ok', products, offers, provider: registry.activeName(), timestamp: now() });
  }));

  // separator-delimited list -> array (max 60 values); empty/absent -> undefined
  const csv = (item, sep = ',') => z.preprocess((v) => (typeof v === 'string' && v.length ? v.split(sep) : undefined), z.array(item).max(60).optional());
  const listQuery = z.object({
    q: z.string().trim().max(100).optional(),
    category: csv(z.string().trim().min(1).max(120), '|'),
    state: csv(z.string().trim().length(2).toUpperCase()),
    vendor: csv(z.coerce.number().int().positive()),
    status: z.enum(['DEMO', 'UNVERIFIED', 'VERIFIED', 'STALE', 'FAILED']).optional(),
    missing: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(25),
  });

  const staleCutoff = () => new Date(now().getTime() - staleHours * 3.6e6);

  app.get('/api/products', ah(async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return apiError(res, 400, 'VALIDATION', 'Invalid query parameters.', parsed.error.flatten().fieldErrors);
    const { q, category, state, vendor, status, missing, page, pageSize } = parsed.data;

    const offerWhere = {};
    if (state) offerWhere.state = { in: state };
    if (vendor) offerWhere.vendorId = { in: vendor };
    if (status === 'VERIFIED') Object.assign(offerWhere, { verificationStatus: 'VERIFIED', lastVerifiedAt: { gte: staleCutoff() } });
    else if (status === 'STALE') offerWhere.OR = [{ verificationStatus: 'STALE' }, { verificationStatus: 'VERIFIED', lastVerifiedAt: { lt: staleCutoff() } }];
    else if (status) offerWhere.verificationStatus = status;

    const where = {};
    if (q) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      where.AND = terms.map((t) => ({ OR: [{ normalizedName: { contains: t } }, { sku: { contains: t.toUpperCase() } }, { brand: { contains: t } }, { vintage: { contains: t } }] }));
    }
    if (category) where.category = { in: category };
    if (missing === 'true') where.offers = { none: {} };
    else if (Object.keys(offerWhere).length) where.offers = { some: offerWhere };

    const [total, rows] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, orderBy: [{ name: 'asc' }, { vintage: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize, include: { offers: { include: { vendor: true } } } }),
    ]);
    res.json({ page, pageSize, total, totalPages: Math.ceil(total / pageSize), products: rows.map(serializeProduct) });
  }));

  const idParam = z.coerce.number().int().positive();

  app.get('/api/products/:id', ah(async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return apiError(res, 400, 'VALIDATION', 'Invalid product id.');
    const p = await prisma.product.findUnique({ where: { id: id.data }, include: { offers: { include: { vendor: true } } } });
    if (!p) return apiError(res, 404, 'NOT_FOUND', 'Product not found.');
    res.json(serializeProduct(p));
  }));

  app.get('/api/products/:id/history', ah(async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return apiError(res, 400, 'VALIDATION', 'Invalid product id.');
    const rows = await prisma.priceHistory.findMany({
      where: { offer: { productId: id.data } },
      orderBy: { observedAt: 'asc' },
      take: 2000,
      include: { offer: { select: { vendor: { select: { name: true } } } } },
    });
    res.json({
      history: rows.map((h) => ({ id: h.id, vendor: h.offer.vendor.name, previousPrice: h.previousPrice, price: h.price, change: h.previousPrice == null ? null : priceChange(h.price, h.previousPrice), observedAt: h.observedAt, source: h.source, refreshJobId: h.refreshJobId })),
    });
  }));

  app.get('/api/filters', ah(async (req, res) => {
    const [categories, vendorRows, states, vendorStates] = await Promise.all([
      prisma.product.groupBy({ by: ['category'], _count: { _all: true }, orderBy: { category: 'asc' } }),
      prisma.vendor.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      prisma.offer.groupBy({ by: ['state'], where: { state: { not: null } }, orderBy: { state: 'asc' } }),
      prisma.offer.groupBy({ by: ['vendorId', 'state'], where: { state: { not: null } }, _count: { _all: true }, _avg: { rating: true } }),
    ]);
    // A vendor's state is the one its offers are most often reported from; null when never reported (not guessed).
    const vendors = vendorRows.map((v) => {
      const best = vendorStates.filter((x) => x.vendorId === v.id).sort((a, b) => b._count._all - a._count._all)[0];
      return { ...v, state: best ? best.state : null, rating: best && best._avg.rating != null ? Math.round(best._avg.rating * 10) / 10 : null };
    });
    res.json({
      categories: categories.map((c) => ({ name: c.category, count: c._count._all })),
      vendors,
      states: states.map((s) => s.state),
      statuses: ['DEMO', 'UNVERIFIED', 'VERIFIED', 'STALE', 'FAILED'],
    });
  }));

  app.get('/api/stats', ah(async (req, res) => {
    const cutoff = staleCutoff();
    const since = new Date(now().getTime() - 7 * 864e5);
    const [products, vendors, offers, verified, staleA, staleB, demo, unverified, failed, noOffers, lastJob, changes] = await Promise.all([
      prisma.product.count(),
      prisma.vendor.count(),
      prisma.offer.count(),
      prisma.offer.count({ where: { verificationStatus: 'VERIFIED', lastVerifiedAt: { gte: cutoff } } }),
      prisma.offer.count({ where: { verificationStatus: 'STALE' } }),
      prisma.offer.count({ where: { verificationStatus: 'VERIFIED', lastVerifiedAt: { lt: cutoff } } }),
      prisma.offer.count({ where: { verificationStatus: 'DEMO' } }),
      prisma.offer.count({ where: { verificationStatus: 'UNVERIFIED' } }),
      prisma.offer.count({ where: { verificationStatus: 'FAILED' } }),
      prisma.product.count({ where: { offers: { none: {} } } }),
      prisma.refreshJob.findFirst({ orderBy: { id: 'desc' } }),
      prisma.priceHistory.findMany({ where: { previousPrice: { not: null }, observedAt: { gte: since } }, orderBy: { observedAt: 'desc' }, take: 500, include: { offer: { select: { productId: true, vendor: { select: { name: true } }, product: { select: { name: true, vintage: true } } } } } }),
    ]);
    const lastSuccess = await prisma.refreshJob.findFirst({ where: { status: { in: ['SUCCESS', 'PARTIAL'] } }, orderBy: { id: 'desc' } });
    const moves = changes.map((h) => ({ productId: h.offer.productId, product: h.offer.product.name, vintage: h.offer.product.vintage, vendor: h.offer.vendor.name, previousPrice: h.previousPrice, price: h.price, observedAt: h.observedAt }));
    res.json({
      products, vendors, offers,
      offerStatus: { verified, stale: staleA + staleB, demo, unverified, failed },
      productsMissingCompetitors: noOffers,
      recentChanges: {
        windowDays: 7,
        increases: moves.filter((m) => m.price > m.previousPrice).length,
        decreases: moves.filter((m) => m.price < m.previousPrice).length,
        latest: moves.slice(0, 10),
      },
      lastJob,
      lastSuccessfulRefresh: lastSuccess ? lastSuccess.finishedAt : null,
      staleAfterHours: staleHours,
      dataLabel: verified === 0 ? 'DEMO' : 'MIXED',
    });
  }));

  app.get('/api/vendors', ah(async (req, res) => {
    res.json({ vendors: await prisma.vendor.findMany({ orderBy: { name: 'asc' } }) });
  }));

  app.get('/api/providers', (req, res) => res.json({ providers: registry.list() }));

  app.get('/api/refresh/jobs', ah(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    res.json({ jobs: await prisma.refreshJob.findMany({ orderBy: { id: 'desc' }, take: limit }) });
  }));

  app.post('/api/refresh', ...admin, ah(async (req, res) => {
    const body = z.object({ provider: z.string().max(50).optional() }).safeParse(req.body || {});
    if (!body.success) return apiError(res, 400, 'VALIDATION', 'Invalid body.');
    const provider = registry.get(body.data.provider);
    if (!provider) return apiError(res, 400, 'UNKNOWN_PROVIDER', 'Unknown provider.');
    const result = await runRefresh(prisma, provider, { trigger: 'MANUAL', now });
    if (result.status === 'BUSY') return apiError(res, 409, 'REFRESH_RUNNING', 'A refresh job is already running.');
    if (result.job && global.__handlePostRefresh) global.__handlePostRefresh(result.job).catch(() => {});
    res.json({ status: result.status, job: result.job });
  }));

  app.post('/api/import', ...admin, ah(async (req, res) => {
    if (!datasetFile) return apiError(res, 503, 'IMPORT_NOT_CONFIGURED', 'No dataset file configured.');
    const dryRun = req.query.dryRun === 'true';
    try {
      const summary = await importDataset(prisma, datasetFile, { dryRun });
      res.json(summary);
    } catch (e) {
      apiError(res, 422, e.code || 'IMPORT_FAILED', e.message);
    }
  }));

  app.post('/api/import/apify', ...admin, ah(async (req, res) => {
    const file = apifyDatasetFile || env.APIFY_DATASET_FILE;
    if (!file) return apiError(res, 503, 'IMPORT_NOT_CONFIGURED', 'No Apify dataset file configured. Set APIFY_DATASET_FILE in .env or pass apifyDatasetFile to createApp.');
    const dryRun = req.query.dryRun === 'true';
    try {
      const summary = await importApifyDataset(prisma, file, { dryRun, now });
      res.json(summary);
    } catch (e) {
      apiError(res, 422, e.code || 'IMPORT_FAILED', e.message);
    }
  }));

  app.post('/api/import/csv', ...admin, ah(async (req, res) => {
    const file = csvDatasetFile || env.CSV_DATASET_FILE;
    if (!file) return apiError(res, 503, 'IMPORT_NOT_CONFIGURED', 'No CSV dataset file configured. Set CSV_DATASET_FILE in .env or pass csvDatasetFile to createApp.');
    const dryRun = req.query.dryRun === 'true';
    try {
      const summary = await importCsv(prisma, file, { dryRun, now });
      res.json(summary);
    } catch (e) {
      apiError(res, 422, e.code || 'IMPORT_FAILED', e.message);
    }
  }));

  app.get('/api/price-changes', ah(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = new Date(now().getTime() - days * 864e5);
    const rows = await prisma.priceHistory.findMany({
      where: { previousPrice: { not: null }, observedAt: { gte: since } },
      orderBy: { observedAt: 'desc' },
      take: 2000,
      include: { offer: { select: { productId: true, vendor: { select: { name: true } } } } },
    });
    // One entry per product — the most recent change
    const byProduct = new Map();
    for (const h of rows) {
      if (!byProduct.has(h.offer.productId)) {
        const pct = h.previousPrice > 0 ? Math.round(((h.price - h.previousPrice) / h.previousPrice) * 1000) / 10 : null;
        byProduct.set(h.offer.productId, {
          direction: h.price < h.previousPrice ? 'down' : 'up',
          percent: pct,
          previousPrice: h.previousPrice,
          price: h.price,
          vendorName: h.offer.vendor.name,
          observedAt: h.observedAt,
        });
      }
    }
    res.json({ changes: Object.fromEntries(byProduct), windowDays: days });
  }));

  // ── Settings ────────────────────────────────────────────────────────────────
  app.get('/api/settings', (req, res) => res.json(settingsLib.load()));

  app.post('/api/settings', ...admin, ah(async (req, res) => {
    const schema = z.object({
      refreshCron: z.string().max(100).optional(),
      alertThresholdPct: z.coerce.number().min(0).max(100).optional(),
      alertEmail: z.string().email().or(z.literal('')).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return apiError(res, 400, 'VALIDATION', 'Invalid settings.', parsed.error.flatten().fieldErrors);
    const saved = settingsLib.save(parsed.data);
    if (onSettingsChange) onSettingsChange(saved);
    res.json(saved);
  }));

  // ── Alerts ───────────────────────────────────────────────────────────────────
  app.get('/api/alerts', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const unreadOnly = req.query.unread === 'true';
    res.json({ alerts: alertStore.getRecent({ limit, unreadOnly }), unreadCount: alertStore.unreadCount() });
  });

  app.post('/api/alerts/read', ...admin, ah(async (req, res) => {
    const body = z.object({ ids: z.array(z.string()).optional() }).safeParse(req.body || {});
    if (!body.success) return apiError(res, 400, 'VALIDATION', 'Invalid body.');
    const n = body.data.ids ? alertStore.markRead(body.data.ids) : alertStore.markAllRead();
    res.json({ marked: n });
  }));

  app.delete('/api/alerts', ...admin, ah(async (req, res) => {
    alertStore.clear();
    res.json({ ok: true });
  }));

  app.use('/api', (req, res) => apiError(res, 404, 'NOT_FOUND', 'No such endpoint.'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err.message);
    apiError(res, 500, 'INTERNAL', 'Internal server error.');
  });
  return app;
}

module.exports = { createApp, effectiveStatus };
