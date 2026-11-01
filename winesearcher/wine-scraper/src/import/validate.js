const { z } = require('zod');

const OfferSchema = z.object({
  vendor: z.string().trim().min(1),
  price: z.number().finite(),
  location: z.string().optional(),
  rating: z.number().optional(),
}).passthrough();

const ProductSchema = z.object({
  id: z.string().min(1),
  wineName: z.string().trim().min(1),
  vintage: z.union([z.string(), z.number()]).optional().nullable(),
  region: z.string().optional().nullable(),
  category: z.string().trim().min(1),
  clientPrice: z.number().finite(),
  competitors: z.array(OfferSchema),
  lastUpdated: z.string().optional().nullable(),
}).passthrough();

const normName = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Validate the parsed JSON (object keyed by id, or array). Never mutates the input.
 * Returns { valid: [products passing schema], report }.
 */
function validateDataset(raw, { now = new Date() } = {}) {
  const issues = []; // { severity: 'error'|'warning'|'info', code, productId?, vendor?, message }
  const add = (severity, code, message, extra = {}) => issues.push({ severity, code, message, ...extra });

  let entries;
  if (Array.isArray(raw)) entries = raw.map((p, i) => [p && p.id != null ? String(p.id) : `#${i}`, p]);
  else if (raw && typeof raw === 'object') entries = Object.entries(raw);
  else return { valid: [], report: { fatal: 'Top-level JSON must be an object or array', issues: [], counts: {} } };

  const valid = [];
  const seenKeys = new Set();
  const seenNameVintage = new Map();
  const vendors = new Map();
  const cats = new Map();
  const regions = new Map();
  const currencies = new Set();
  let offerCount = 0, invalidProducts = 0, dupOffers = 0, badPrices = 0, badTimestamps = 0;
  const timestamps = [];

  for (const [key, p] of entries) {
    const parsed = ProductSchema.safeParse(p);
    if (!parsed.success) {
      invalidProducts++;
      add('error', 'SCHEMA', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), { productId: key });
      continue;
    }
    const prod = parsed.data;
    if (prod.id !== key && !Array.isArray(raw)) add('warning', 'KEY_ID_MISMATCH', `object key "${key}" differs from id "${prod.id}"`, { productId: key });

    if (seenKeys.has(prod.id)) {
      add('error', 'DUPLICATE_PRODUCT_ID', `id ${prod.id} repeated`, { productId: prod.id });
      invalidProducts++;
      continue;
    }
    seenKeys.add(prod.id);
    const nv = `${normName(prod.wineName)}|${prod.vintage ?? ''}`;
    if (seenNameVintage.has(nv)) add('warning', 'DUPLICATE_NAME_VINTAGE', `"${prod.wineName}" ${prod.vintage ?? ''} also appears as ${seenNameVintage.get(nv)}`, { productId: prod.id });
    else seenNameVintage.set(nv, prod.id);

    if (prod.clientPrice <= 0) {
      badPrices++;
      add('error', 'BAD_CLIENT_PRICE', `clientPrice ${prod.clientPrice}`, { productId: prod.id });
      invalidProducts++;
      continue;
    }

    if (prod.lastUpdated) {
      const t = Date.parse(prod.lastUpdated);
      if (Number.isNaN(t)) {
        badTimestamps++;
        add('warning', 'BAD_TIMESTAMP', `lastUpdated "${prod.lastUpdated}"`, { productId: prod.id });
      } else {
        timestamps.push(t);
        if (t > now.getTime() + 864e5) add('warning', 'FUTURE_TIMESTAMP', prod.lastUpdated, { productId: prod.id });
      }
    } else add('warning', 'MISSING_TIMESTAMP', 'lastUpdated missing', { productId: prod.id });

    cats.set(prod.category, (cats.get(prod.category) || 0) + 1);
    const regionKey = prod.region || '(missing)';
    regions.set(regionKey, (regions.get(regionKey) || 0) + 1);
    if (!prod.vintage) add('info', 'MISSING_VINTAGE', 'vintage missing', { productId: prod.id });
    if (prod.currency) currencies.add(prod.currency);

    const seenVendors = new Set();
    const goodOffers = [];
    for (const o of prod.competitors) {
      offerCount++;
      if (seenVendors.has(o.vendor.toLowerCase())) {
        dupOffers++;
        add('warning', 'DUPLICATE_OFFER', `vendor ${o.vendor} repeated`, { productId: prod.id, vendor: o.vendor });
        continue;
      }
      seenVendors.add(o.vendor.toLowerCase());
      if (o.price <= 0) {
        badPrices++;
        add('error', 'BAD_OFFER_PRICE', `price ${o.price}`, { productId: prod.id, vendor: o.vendor });
        continue;
      }
      if (o.price > prod.clientPrice * 5 || o.price < prod.clientPrice / 5) add('warning', 'PRICE_OUTLIER', `offer ${o.price} vs clientPrice ${prod.clientPrice}`, { productId: prod.id, vendor: o.vendor });
      if (o.currency) currencies.add(o.currency);
      if (!vendors.has(o.vendor)) vendors.set(o.vendor, { offers: 0, locations: new Set() });
      const v = vendors.get(o.vendor);
      v.offers++;
      if (o.location) v.locations.add(o.location);
      goodOffers.push(o);
    }
    if (prod.competitors.length === 0) add('warning', 'NO_OFFERS', 'product has no competitor offers', { productId: prod.id });
    valid.push({ ...prod, competitors: goodOffers });
  }

  // Dataset-level suspicion checks (flag only, never alter data)
  const n = valid.length;
  const global = [];
  if (n > 1 && regions.size === 1) global.push({ code: 'SINGLE_REGION', message: `All ${n} products share one region "${[...regions.keys()][0]}" - region/category inconsistency likely (e.g. whiskey tagged as Cognac, France).` });
  if (timestamps.length > 1) {
    const spanMs = Math.max(...timestamps) - Math.min(...timestamps);
    if (spanMs < 60000) global.push({ code: 'TIMESTAMP_BURST', message: `All lastUpdated values fall within ${spanMs} ms: they record one generation/import run, not per-offer verification.` });
  }
  const perProduct = new Set(valid.map((p) => p.competitors.length));
  if (n > 1 && perProduct.size === 1) global.push({ code: 'UNIFORM_OFFER_COUNT', message: `Every product has exactly ${[...perProduct][0]} offers - consistent with synthetic or templated data.` });
  const missing = ['currency', 'bottle size', 'stock availability', 'offer URL', 'vendor product ID', 'per-offer timestamp'];
  global.push({ code: 'MISSING_FIELDS_BY_DESIGN', message: `Source file does not record: ${missing.join(', ')}. These stay null; nothing is invented.` });

  const sev = (s) => issues.filter((i) => i.severity === s).length;
  const report = {
    generatedAt: now.toISOString(),
    counts: {
      productsInFile: entries.length,
      validProducts: n,
      invalidProducts,
      offersInFile: offerCount,
      validOffers: valid.reduce((a, p) => a + p.competitors.length, 0),
      duplicateOffers: dupOffers,
      badPrices,
      badTimestamps,
      distinctVendors: vendors.size,
      distinctCategories: cats.size,
      distinctRegions: regions.size,
      distinctNames: new Set(valid.map((p) => normName(p.wineName))).size,
      currencies: [...currencies],
    },
    severity: { errors: sev('error'), warnings: sev('warning'), info: sev('info') },
    global,
    vendors: [...vendors].map(([name, v]) => ({ name, offers: v.offers, locations: [...v.locations] })),
    categories: Object.fromEntries(cats),
    regions: Object.fromEntries(regions),
    timestampRange: timestamps.length ? [new Date(Math.min(...timestamps)).toISOString(), new Date(Math.max(...timestamps)).toISOString()] : null,
    issues,
  };
  return { valid, report };
}

function reportToMarkdown(r, { fileSha256, source } = {}) {
  const c = r.counts;
  const byCode = {};
  for (const i of r.issues) byCode[`${i.severity}:${i.code}`] = (byCode[`${i.severity}:${i.code}`] || 0) + 1;
  return [
    '# Import data-quality report',
    '',
    `- Generated: ${r.generatedAt}`,
    source ? `- Source: ${source}` : '',
    fileSha256 ? `- SHA-256: ${fileSha256}` : '',
    '',
    '## Counts',
    '| Metric | Value |',
    '|---|---|',
    ...Object.entries(c).map(([k, v]) => `| ${k} | ${Array.isArray(v) ? v.join(', ') || 'none' : v} |`),
    '',
    '## Dataset-level findings',
    ...r.global.map((g) => `- **${g.code}** - ${g.message}`),
    '',
    '## Issue totals',
    ...(Object.keys(byCode).length ? Object.entries(byCode).map(([k, v]) => `- ${k}: ${v}`) : ['- none']),
    '',
    '## Vendors',
    ...r.vendors.map((v) => `- ${v.name}: ${v.offers} offers (${v.locations.join('; ') || 'no location'})`),
    '',
    '## Actions',
    '- Treat every imported offer as Demo/Unverified until a licensed provider confirms it.',
    '- Obtain real region data; the current region field is not reliable.',
    '- Obtain currency, bottle size, offer URL and vendor product IDs from the real source.',
    '',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

module.exports = { validateDataset, reportToMarkdown, normName };
