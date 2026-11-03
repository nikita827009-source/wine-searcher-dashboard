/**
 * Converts fineliquors_raw.json -> wine_dataset.json
 * Only includes products with at least one available (in-stock) variant.
 */
const fs = require('fs');

const BASE = 'https://fineliquors.com';
const OUT = 'D:/wine/winesearcher/wine-scraper/wine_dataset.json';

const raw = JSON.parse(fs.readFileSync('D:/wine/fineliquors_raw.json'));

function mapCategory(productType, tags, title) {
    const t = (productType || '').toLowerCase();
    const tg = tags.map(x => x.toLowerCase());
    const ttl = title.toLowerCase();

    if (t === 'champagne' || tg.includes('champagne') || /champagne|prosecco|cava|cr[eé]mant|sekt|sparkling|blanc de/.test(ttl)) return 'Champagne & Sparkling';
    if (/whiskey|whisky|bourbon|scotch/.test(t) || tg.some(x => /whiskey|whisky|bourbon|scotch|rye/.test(x)) || /\b(whisky|whiskey|bourbon|scotch|rye)\b/.test(ttl)) return 'Whiskey & Bourbon';
    if (/tequila|mezcal/.test(t) || tg.some(x => /tequila|mezcal/.test(x)) || /\b(tequila|mezcal)\b/.test(ttl)) return 'Tequila & Mezcal';
    if (/cognac|armagnac|brandy|rum/.test(t) || tg.some(x => /cognac|armagnac|brandy|rum/.test(x)) || /\b(cognac|armagnac|brandy|rum)\b/.test(ttl)) return 'Cognac, Brandy & Rum';
    if (/gin|vodka/.test(t) || tg.some(x => /gin|vodka/.test(x)) || /\b(gin|vodka)\b/.test(ttl)) return 'Gin & Vodka';

    // White wine detection
    if (/chardonnay|sauvignon|riesling|pinot gris|pinot grigio|chenin|viognier|albarino|albar|gewurz|chablis|meursault|mersault|puligny|montrachet|muscadet|vermentino|soave|gavi|greco|fiano|falanghina|verdicchio|gr[uü]ner|veltliner|verdejo|godello|ribolla/.test(ttl)) return 'White Wine';
    return 'Red Wine';
}

function extractVintage(title) {
    const m = title.match(/^(\d{4})\s/);
    if (m) { const yr = parseInt(m[1]); if (yr >= 1900 && yr <= 2030) return String(yr); }
    return null;
}

function parsePrice(s) { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return isNaN(n) || n <= 0 ? null : n; }

const SKIP_TAGS = new Set(['wine','champagne','usa','france','italy','spain','whiskey','bourbon','scotch',
    'tequila','cognac','gin','vodka','rum','sparkling','mezcal','brandy','armagnac','port','madeira',
    'fineliquors','new arrivals','rare','limited','whisky','italian','french','italian new','other','spanish']);

const now = new Date().toISOString();
const dataset = [];
let skipped = 0;

for (const p of raw) {
    const title = (p.title || '').trim();
    if (!title) continue;

    // Use all variants with a valid price (include sold-out)
    const variants = (p.variants || []).filter(v => parsePrice(v.price));
    if (!variants.length) { skipped++; continue; }

    // Prefer available variant if one exists; otherwise use cheapest overall
    const availVariants = variants.filter(v => v.available);
    const pool = availVariants.length ? availVariants : variants;
    const cheapest = pool.reduce((a, b) => parsePrice(a.price) <= parsePrice(b.price) ? a : b);
    const price = parsePrice(cheapest.price);
    if (!price) continue;

    const tags = p.tags || [];
    const vintage = extractVintage(title);
    const wineName = title.replace(/^\d{4}\s+/, '').trim();
    const category = mapCategory(p.product_type || '', tags, title);
    const regionTags = tags.filter(t => !SKIP_TAGS.has(t.toLowerCase()) && t.length > 2);

    dataset.push({
        id: `${BASE}/products/${p.handle}`,
        wineName,
        vintage,
        region: regionTags.slice(0, 3).join(', ') || null,
        category,
        clientPrice: price,
        competitors: [],
        lastUpdated: now,
    });
}

fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2));
console.log(`Written ${dataset.length} available products (skipped ${skipped} sold-out)`);

const byCat = {};
dataset.forEach(p => { byCat[p.category] = (byCat[p.category]||0)+1; });
Object.entries(byCat).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k.padEnd(30)} ${v}`));

const prices = dataset.map(p => p.clientPrice).sort((a,b)=>a-b);
console.log(`\nPrice: $${prices[0]} - $${prices[prices.length-1]}, median $${prices[Math.floor(prices.length/2)]}`);
