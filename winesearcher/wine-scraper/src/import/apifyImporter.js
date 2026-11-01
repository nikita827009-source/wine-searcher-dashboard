'use strict';

/**
 * Importer for Apify wine-searcher scraper JSON datasets.
 * Format: array of records with cheapestPriceMerchant, cheapestPriceConverted, wineName, vintage, etc.
 * Offers are stored as VERIFIED (scraped from the live site by Apify).
 * New products get clientPrice=0 (no Fine Liquors shelf price known yet).
 * Idempotent: safe to re-run; only creates a price history row when the price changes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normName } = require('./validate');
const { stateFromLocation } = require('../lib/constants');

const SOURCE_TAG = 'import:apify-wine-searcher';
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive clean wine name from an Apify record.
 * wineName is usually "<vintage> <name>"; strip the leading year if present.
 */
function extractWineName(record) {
  const raw = (record.wineName || record.inputValue || '').trim();
  const vintage = record.vintage != null ? String(record.vintage) : null;
  if (vintage && raw.startsWith(vintage)) return raw.slice(vintage.length).trim();
  return raw;
}

/** Derive category string from Apify "style" field. */
function categoryFromStyle(style) {
  if (!style) return 'Wine';
  const s = style.toLowerCase();
  if (s.includes('white')) return 'Wine - White';
  if (s.includes('red')) return 'Wine - Red';
  if (s.includes('sparkling') || s.includes('champagne') || s.includes('prosecco')) return 'Wine - Sparkling';
  if (s.includes('ros')) return 'Wine - Rosé';
  if (s.includes('port') || s.includes('sherry') || s.includes('madeira') || s.includes('fortif')) return 'Wine - Fortified';
  if (s.includes('whisky') || s.includes('whiskey') || s.includes('bourbon')) return 'Spirits - Whisky';
  if (s.includes('brandy') || s.includes('cognac')) return 'Spirits - Brandy';
  return 'Wine';
}

/** Parse "Puligny-Montrachet Premier Cru, France" into { region, country }. */
function parseAppellation(appellation) {
  if (!appellation) return { region: null, country: null };
  const parts = appellation.split(',').map((s) => s.trim());
  return { region: parts[0] || null, country: parts[parts.length - 1] || null };
}

/** Find existing product by normalized name + vintage match. */
function matchProduct(existingProducts, name, vintage) {
  const norm = normName(name);
  const vint = vintage != null ? String(vintage) : null;
  return existingProducts.find((p) => p.normalizedName === norm && p.vintage === vint) || null;
}

/** Resolve the best USD price from an Apify record. */
function resolveUsdPrice(record) {
  if (record.targetCurrency === 'USD' && record.cheapestPriceConverted > 0) {
    return Math.round(record.cheapestPriceConverted * 100) / 100;
  }
  // Fall back to cheapestPriceAmount only when currency is already USD
  if (record.cheapestPriceCurrency === 'USD' && record.cheapestPriceAmount > 0) {
    return Math.round(record.cheapestPriceAmount * 100) / 100;
  }
  return null;
}

/** Build a stable sourceKey for an Apify wine record. */
function buildSourceKey(record, name, vintage) {
  const base = normName(record.inputValue || name);
  return `apify:${base}:${vintage || 'nv'}`;
}

// ─── Validate ────────────────────────────────────────────────────────────────

function validateApifyDataset(raw) {
  if (!Array.isArray(raw)) return { valid: [], fatal: 'Apify dataset must be a JSON array' };

  const valid = [];
  const skipped = { notOk: 0, noVendor: 0, noPrice: 0, noName: 0 };

  for (const r of raw) {
    if (!r || r.status !== 'ok') { skipped.notOk++; continue; }
    if (!r.cheapestPriceMerchant || !String(r.cheapestPriceMerchant).trim()) { skipped.noVendor++; continue; }
    if (!resolveUsdPrice(r)) { skipped.noPrice++; continue; }
    if (!r.wineName && !r.inputValue) { skipped.noName++; continue; }
    valid.push(r);
  }

  return { valid, skipped, fatal: null };
}

// ─── Main importer ───────────────────────────────────────────────────────────

async function importApifyDataset(prisma, file, { dryRun = false, now = new Date(), dataDir = DATA_DIR } = {}) {
  // Backup source file (content-addressed, never overwrites original)
  const buf = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const backupPath = path.join(dataDir, 'backups', `apify-${sha.slice(0, 12)}.json`);
  if (!fs.existsSync(backupPath)) fs.copyFileSync(file, backupPath);

  let raw;
  try { raw = JSON.parse(buf.toString('utf8')); } catch (e) {
    throw Object.assign(new Error(`Invalid JSON: ${e.message}`), { code: 'INVALID_JSON' });
  }

  const { valid, skipped, fatal } = validateApifyDataset(raw);
  if (fatal) throw Object.assign(new Error(fatal), { code: 'INVALID_SHAPE' });
  if (!dryRun && valid.length === 0) throw Object.assign(new Error('No valid records to import'), { code: 'NOTHING_TO_IMPORT' });

  const summary = {
    dryRun,
    sha256: sha,
    backup: backupPath,
    source: path.basename(file),
    counts: {
      totalRecords: raw.length,
      validRecords: valid.length,
      skipped,
    },
    created: { products: 0, vendors: 0, offers: 0 },
    updated: { products: 0, offers: 0 },
    unchanged: { offers: 0 },
    historyRows: 0,
  };

  if (dryRun) {
    // Show a preview of the first 5 records that would be imported
    summary.preview = valid.slice(0, 5).map((r) => ({
      wine: extractWineName(r),
      vintage: r.vintage,
      vendor: r.cheapestPriceMerchant,
      priceUSD: resolveUsdPrice(r),
      originalPrice: `${r.cheapestPriceAmount} ${r.cheapestPriceCurrency}`,
    }));
    return summary;
  }

  await prisma.$transaction(async (tx) => {
    // Load all existing products and vendors into memory for fast lookup
    const existingProducts = await tx.product.findMany({
      select: { id: true, sourceKey: true, name: true, normalizedName: true, vintage: true },
    });
    const vendorMap = new Map((await tx.vendor.findMany()).map((v) => [v.name, v]));
    const skuSeqRow = await tx.product.findMany({ select: { sku: true } });
    let skuSeq = skuSeqRow.reduce((m, r) => Math.max(m, parseInt(r.sku.replace(/\D/g, ''), 10) || 0), 0);

    for (const record of valid) {
      const name = extractWineName(record);
      const vintageStr = record.vintage != null ? String(record.vintage) : null;
      const price = resolveUsdPrice(record);
      const merchantName = String(record.cheapestPriceMerchant).trim();
      const observedAt = record.scrapedAt ? new Date(record.scrapedAt) : now;
      const sourceKey = buildSourceKey(record, name, vintageStr);
      const { region, country } = parseAppellation(record.appellation);

      // ── Product ──────────────────────────────────────────────────────────
      let prod = matchProduct(existingProducts, name, record.vintage)
        || existingProducts.find((p) => p.sourceKey === sourceKey)
        || null;

      if (!prod) {
        const created = await tx.product.create({
          data: {
            sourceKey,
            sku: `FL-${String(++skuSeq).padStart(5, '0')}`,
            name,
            normalizedName: normName(name),
            brand: record.wineryName || null,
            category: categoryFromStyle(record.style),
            vintage: vintageStr,
            region: region || null,
            country: country || null,
            clientPrice: 0, // Fine Liquors shelf price unknown; update via dashboard
            sourceUpdatedAt: observedAt,
            metadata: record.score != null ? { wsScore: record.score, wsPopularityRank: record.winePopularityRank || null } : undefined,
          },
        });
        existingProducts.push({ id: created.id, sourceKey, name, normalizedName: normName(name), vintage: vintageStr });
        prod = created;
        summary.created.products++;
      } else {
        // Patch missing metadata without overwriting richer existing data
        await tx.product.update({
          where: { id: prod.id },
          data: {
            region: region || undefined,
            country: country || undefined,
            brand: record.wineryName || undefined,
            sourceUpdatedAt: observedAt,
          },
        });
        summary.updated.products++;
      }

      // ── Vendor ───────────────────────────────────────────────────────────
      let vendor = vendorMap.get(merchantName);
      if (!vendor) {
        vendor = await tx.vendor.create({
          data: { name: merchantName, sourceType: 'SCRAPER', integrationStatus: 'CONFIGURED' },
        });
        vendorMap.set(merchantName, vendor);
        summary.created.vendors++;
      }

      // ── Offer ────────────────────────────────────────────────────────────
      const offerBase = {
        price,
        currency: 'USD',
        url: record.wineSearcherUrl || null,
        source: SOURCE_TAG,
        observedAt,
        lastVerifiedAt: observedAt,
        verificationStatus: 'VERIFIED',
        error: null,
      };

      const existing = await tx.offer.findFirst({ where: { productId: prod.id, vendorId: vendor.id } });

      if (!existing) {
        const created = await tx.offer.create({ data: { ...offerBase, productId: prod.id, vendorId: vendor.id } });
        await tx.priceHistory.create({
          data: { offerId: created.id, previousPrice: null, price, currency: 'USD', observedAt, source: SOURCE_TAG },
        });
        summary.created.offers++;
      } else if (existing.price !== price) {
        await tx.offer.update({ where: { id: existing.id }, data: offerBase });
        await tx.priceHistory.create({
          data: { offerId: existing.id, previousPrice: existing.price, price, currency: 'USD', observedAt, source: SOURCE_TAG },
        });
        summary.updated.offers++;
        summary.historyRows++;
      } else {
        // Price unchanged — still refresh lastVerifiedAt
        await tx.offer.update({ where: { id: existing.id }, data: { lastVerifiedAt: observedAt, verificationStatus: 'VERIFIED', error: null } });
        summary.unchanged.offers++;
      }
    }
  }, { timeout: 15 * 60000, maxWait: 60000 });

  return summary;
}

module.exports = { importApifyDataset, SOURCE_TAG };
