const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateDataset, reportToMarkdown, normName } = require('./validate');
const { stateFromLocation } = require('../lib/constants');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SOURCE_TAG = 'import:wine_dataset.json';

/** Copy the source file into data/backups (content-addressed) before anything else; never modifies the original. */
function backupSource(file, dataDir = DATA_DIR) {
  const buf = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const dest = path.join(dataDir, 'backups', `${path.basename(file, '.json')}.${sha.slice(0, 12)}.json`);
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
  return { buf, sha, backup: dest };
}

/**
 * Validate + import. dryRun=true only validates and writes the report.
 * Re-import is idempotent: products keyed by sourceKey, offers by (product, vendor);
 * history rows are written only when the price changed (or the offer is first seen).
 * Everything runs in one transaction, so a failure leaves the database untouched.
 */
async function importDataset(prisma, file, { dryRun = false, now = new Date(), dataDir = DATA_DIR } = {}) {
  const { buf, sha, backup } = backupSource(file, dataDir);
  let raw;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw Object.assign(new Error(`Invalid JSON: ${e.message}`), { code: 'INVALID_JSON' });
  }

  const { valid, report } = validateDataset(raw, { now });
  if (report.fatal) throw Object.assign(new Error(report.fatal), { code: 'INVALID_SHAPE' });

  fs.mkdirSync(path.join(dataDir, 'reports'), { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const base = path.join(dataDir, 'reports', `import-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${base}.md`, reportToMarkdown(report, { fileSha256: sha, source: path.basename(file) }));

  const summary = {
    dryRun, sha256: sha, backup, reportPath: `${base}.md`, counts: report.counts,
    created: { products: 0, offers: 0, vendors: 0 },
    updated: { products: 0, offers: 0 },
    unchanged: { offers: 0 },
    historyRows: 0,
  };
  if (dryRun) return summary;
  if (valid.length === 0) throw Object.assign(new Error('No valid products to import'), { code: 'NOTHING_TO_IMPORT' });

  await prisma.$transaction(async (tx) => {
    const existingProducts = new Map((await tx.product.findMany({ select: { id: true, sourceKey: true } })).map((p) => [p.sourceKey, p]));
    const vendorMap = new Map((await tx.vendor.findMany()).map((v) => [v.name, v]));
    const skuRows = await tx.product.findMany({ select: { sku: true } });
    let skuSeq = skuRows.reduce((m, r) => Math.max(m, parseInt(r.sku.replace(/\D/g, ''), 10) || 0), 0);

    for (const p of valid) {
      const lastUpdated = p.lastUpdated && !Number.isNaN(Date.parse(p.lastUpdated)) ? new Date(p.lastUpdated) : null;
      const data = {
        name: p.wineName,
        normalizedName: normName(p.wineName),
        category: p.category,
        vintage: p.vintage != null ? String(p.vintage) : null,
        region: p.region || null,
        clientPrice: p.clientPrice,
        sourceUpdatedAt: lastUpdated,
      };
      let prod = existingProducts.get(p.id);
      if (prod) {
        await tx.product.update({ where: { id: prod.id }, data });
        summary.updated.products++;
      } else {
        prod = await tx.product.create({ data: { ...data, sourceKey: p.id, sku: `FL-${String(++skuSeq).padStart(5, '0')}` } });
        summary.created.products++;
      }

      const existingOffers = new Map((await tx.offer.findMany({ where: { productId: prod.id } })).map((o) => [o.vendorId, o]));
      const hist = [];
      for (const o of p.competitors) {
        let vendor = vendorMap.get(o.vendor);
        if (!vendor) {
          vendor = await tx.vendor.create({ data: { name: o.vendor, sourceType: 'IMPORT', integrationStatus: 'NONE' } });
          vendorMap.set(o.vendor, vendor);
          summary.created.vendors++;
        }
        const observedAt = lastUpdated || now;
        const offerData = {
          price: o.price,
          source: SOURCE_TAG,
          observedAt,
          location: o.location || null,
          state: stateFromLocation(o.location),
          rating: typeof o.rating === 'number' ? o.rating : null,
        };
        const prev = existingOffers.get(vendor.id);
        if (!prev) {
          const created = await tx.offer.create({ data: { ...offerData, productId: prod.id, vendorId: vendor.id, verificationStatus: 'DEMO' } });
          hist.push({ offerId: created.id, previousPrice: null, price: o.price, observedAt, source: SOURCE_TAG });
          summary.created.offers++;
        } else if (prev.price !== o.price || prev.location !== offerData.location || prev.rating !== offerData.rating || prev.state !== offerData.state) {
          // An import only overwrites DEMO/UNVERIFIED rows; a provider-VERIFIED offer is never downgraded by it.
          if (prev.verificationStatus === 'DEMO' || prev.verificationStatus === 'UNVERIFIED') {
            await tx.offer.update({ where: { id: prev.id }, data: offerData });
            if (prev.price !== o.price) hist.push({ offerId: prev.id, previousPrice: prev.price, price: o.price, observedAt, source: SOURCE_TAG });
            summary.updated.offers++;
          } else summary.unchanged.offers++;
        } else summary.unchanged.offers++;
      }
      if (hist.length) {
        await tx.priceHistory.createMany({ data: hist });
        summary.historyRows += hist.length;
      }
    }
  }, { timeout: 15 * 60000, maxWait: 60000 });

  return summary;
}

module.exports = { importDataset, backupSource, SOURCE_TAG };
