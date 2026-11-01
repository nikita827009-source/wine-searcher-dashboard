'use strict';

/**
 * CSV importer for competitor pricing data.
 * Format: flat CSV, one row per competitor offer.
 * Required columns: wine_name, client_price, vendor, competitor_price
 * Optional: vintage, category, location, rating
 *
 * Multiple rows sharing the same wine_name+vintage are grouped into one product.
 * Offers are stored as DEMO (no live verification). Idempotent: safe to re-run.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { normName } = require('./validate');
const { stateFromLocation, isPrice: _unused } = require('../lib/constants');
const { isPrice } = require('../pricing/compare');

const SOURCE_TAG = 'import:csv';
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ─── CSV parser ───────────────────────────────────────────────────────────────

/** Parse a single CSV line respecting double-quoted fields. */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

/** Column name aliases → canonical key. */
const ALIASES = {
  wine_name: 'wine_name', wine: 'wine_name', name: 'wine_name', winename: 'wine_name',
  vintage: 'vintage', year: 'vintage',
  category: 'category', type: 'category',
  client_price: 'client_price', our_price: 'client_price', price: 'client_price', clientprice: 'client_price',
  vendor: 'vendor', merchant: 'vendor', retailer: 'vendor', competitor: 'vendor',
  competitor_price: 'competitor_price', comp_price: 'competitor_price', competitorprice: 'competitor_price', offer_price: 'competitor_price',
  location: 'location', city: 'location', state: 'location',
  rating: 'rating', score: 'rating',
};

function resolveHeader(raw) {
  return ALIASES[raw.toLowerCase().replace(/[^a-z_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')] || null;
}

async function parseCsv(file) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const fields = parseCsvLine(line);
      if (!headers) {
        headers = fields.map(resolveHeader);
        return;
      }
      const row = {};
      headers.forEach((h, i) => { if (h) row[h] = fields[i] || ''; });
      rows.push(row);
    });
    rl.on('close', () => resolve({ headers, rows }));
    rl.on('error', reject);
  });
}

// ─── Validate & group ─────────────────────────────────────────────────────────

function validateAndGroup(rows) {
  const issues = [];
  const productMap = new Map(); // normKey → { wine_name, vintage, category, client_price, offers[] }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lineNum = i + 2; // +2: header row + 1-indexed

    if (!r.wine_name) { issues.push({ line: lineNum, msg: 'wine_name missing' }); continue; }
    if (!r.vendor) { issues.push({ line: lineNum, msg: 'vendor missing' }); continue; }

    const clientPrice = parseFloat(r.client_price);
    if (!r.client_price || !isPrice(clientPrice)) { issues.push({ line: lineNum, msg: `invalid client_price "${r.client_price}"` }); continue; }

    const compPrice = parseFloat(r.competitor_price);
    if (!r.competitor_price || !isPrice(compPrice)) { issues.push({ line: lineNum, msg: `invalid competitor_price "${r.competitor_price}"` }); continue; }

    const vintageRaw = r.vintage ? String(r.vintage).trim() : null;
    const normKey = `${normName(r.wine_name)}|${vintageRaw || ''}`;

    if (!productMap.has(normKey)) {
      productMap.set(normKey, {
        wine_name: r.wine_name.trim(),
        vintage: vintageRaw,
        category: (r.category || 'Wine').trim(),
        client_price: clientPrice,
        offers: [],
      });
    }

    const prod = productMap.get(normKey);
    const vendorKey = r.vendor.trim().toLowerCase();
    if (prod.offers.some((o) => o.vendor.toLowerCase() === vendorKey)) {
      issues.push({ line: lineNum, msg: `duplicate vendor "${r.vendor}" for "${r.wine_name}"` });
      continue;
    }

    prod.offers.push({
      vendor: r.vendor.trim(),
      price: compPrice,
      location: r.location ? r.location.trim() : null,
      rating: r.rating ? parseFloat(r.rating) || null : null,
    });
  }

  return { products: [...productMap.values()], issues };
}

// ─── Main importer ────────────────────────────────────────────────────────────

async function importCsv(prisma, file, { dryRun = false, now = new Date(), dataDir = DATA_DIR } = {}) {
  const buf = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const backupPath = path.join(dataDir, 'backups', `csv-${sha.slice(0, 12)}.csv`);
  if (!fs.existsSync(backupPath)) fs.copyFileSync(file, backupPath);

  const { rows } = await parseCsv(file);
  const { products, issues } = validateAndGroup(rows);

  if (!dryRun && products.length === 0) {
    throw Object.assign(new Error('No valid rows to import'), { code: 'NOTHING_TO_IMPORT' });
  }

  const summary = {
    dryRun,
    sha256: sha,
    backup: backupPath,
    source: path.basename(file),
    counts: { totalRows: rows.length, validProducts: products.length, issues: issues.length },
    issues: issues.slice(0, 20), // cap for readability
    created: { products: 0, vendors: 0, offers: 0 },
    updated: { products: 0, offers: 0 },
    unchanged: { offers: 0 },
    historyRows: 0,
  };

  if (dryRun) {
    summary.preview = products.slice(0, 5).map((p) => ({
      wine: p.wine_name, vintage: p.vintage, clientPrice: p.client_price,
      offers: p.offers.map((o) => `${o.vendor} $${o.price}`),
    }));
    return summary;
  }

  await prisma.$transaction(async (tx) => {
    const existingProducts = await tx.product.findMany({
      select: { id: true, sourceKey: true, name: true, normalizedName: true, vintage: true },
    });
    const vendorMap = new Map((await tx.vendor.findMany()).map((v) => [v.name, v]));
    const skuRows = await tx.product.findMany({ select: { sku: true } });
    let skuSeq = skuRows.reduce((m, r) => Math.max(m, parseInt(r.sku.replace(/\D/g, ''), 10) || 0), 0);

    for (const p of products) {
      const vintageStr = p.vintage || null;
      const normKey = normName(p.wine_name);
      const sourceKey = `csv:${normKey}:${vintageStr || 'nv'}`;

      // Match by normalizedName + vintage, or by sourceKey
      let prod = existingProducts.find((e) => e.normalizedName === normKey && e.vintage === vintageStr)
        || existingProducts.find((e) => e.sourceKey === sourceKey)
        || null;

      if (!prod) {
        const created = await tx.product.create({
          data: {
            sourceKey,
            sku: `FL-${String(++skuSeq).padStart(5, '0')}`,
            name: p.wine_name,
            normalizedName: normKey,
            category: p.category,
            vintage: vintageStr,
            clientPrice: p.client_price,
            sourceUpdatedAt: now,
          },
        });
        existingProducts.push({ id: created.id, sourceKey, name: p.wine_name, normalizedName: normKey, vintage: vintageStr });
        prod = created;
        summary.created.products++;
      } else {
        await tx.product.update({
          where: { id: prod.id },
          data: { clientPrice: p.client_price, category: p.category, sourceUpdatedAt: now },
        });
        summary.updated.products++;
      }

      const hist = [];
      for (const o of p.offers) {
        let vendor = vendorMap.get(o.vendor);
        if (!vendor) {
          vendor = await tx.vendor.create({ data: { name: o.vendor, sourceType: 'IMPORT', integrationStatus: 'NONE' } });
          vendorMap.set(o.vendor, vendor);
          summary.created.vendors++;
        }

        const offerData = {
          price: o.price,
          source: SOURCE_TAG,
          observedAt: now,
          location: o.location || null,
          state: stateFromLocation(o.location),
          rating: typeof o.rating === 'number' && isFinite(o.rating) ? o.rating : null,
        };

        const prev = await tx.offer.findFirst({ where: { productId: prod.id, vendorId: vendor.id } });

        if (!prev) {
          const created = await tx.offer.create({
            data: { ...offerData, productId: prod.id, vendorId: vendor.id, verificationStatus: 'DEMO' },
          });
          hist.push({ offerId: created.id, previousPrice: null, price: o.price, observedAt: now, source: SOURCE_TAG });
          summary.created.offers++;
        } else if (prev.verificationStatus === 'DEMO' || prev.verificationStatus === 'UNVERIFIED') {
          const changed = prev.price !== o.price || prev.location !== offerData.location || prev.rating !== offerData.rating;
          if (changed) {
            await tx.offer.update({ where: { id: prev.id }, data: offerData });
            if (prev.price !== o.price) {
              hist.push({ offerId: prev.id, previousPrice: prev.price, price: o.price, observedAt: now, source: SOURCE_TAG });
            }
            summary.updated.offers++;
          } else {
            summary.unchanged.offers++;
          }
        } else {
          // VERIFIED offer — CSV never downgrades it
          summary.unchanged.offers++;
        }
      }

      if (hist.length) {
        await tx.priceHistory.createMany({ data: hist });
        summary.historyRows += hist.length;
      }
    }
  }, { timeout: 15 * 60000, maxWait: 60000 });

  return summary;
}

module.exports = { importCsv, SOURCE_TAG };
