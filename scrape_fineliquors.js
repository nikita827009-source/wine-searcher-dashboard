/**
 * Scrapes fineliquors.com via the public Shopify products.json API.
 * Outputs wine_dataset.json ready for `npm run import`.
 *
 * Usage: node scrape_fineliquors.js
 */

const https = require('https');
const fs = require('fs');

const OUT_DATASET = 'D:/wine/winesearcher/wine-scraper/wine_dataset.json';
const OUT_RAW = 'D:/wine/fineliquors_raw.json';
const BASE = 'https://fineliquors.com';
const LIMIT = 250;
const SLEEP_MS = 4000; // polite delay between pages

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getRaw(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

async function get(url, retries = 5) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const { status, body } = await getRaw(url);
        if (status === 429) {
            const wait = attempt * 8000;
            console.log(`    429 rate-limit, waiting ${wait / 1000}s (attempt ${attempt}/${retries})...`);
            await sleep(wait);
            continue;
        }
        if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
        try { return JSON.parse(body); }
        catch (e) { throw new Error(`JSON parse error: ${e.message}`); }
    }
    throw new Error(`Still rate-limited after ${retries} retries: ${url}`);
}

// Map Shopify product_type + tags → dashboard category
function mapCategory(productType, tags) {
    const t = (productType || '').toLowerCase();
    const tg = tags.map(x => x.toLowerCase());

    if (t.includes('champagne') || tg.includes('champagne') || t.includes('sparkling') || tg.includes('sparkling') || t.includes('prosecco')) return 'Champagne & Sparkling';
    if (t.includes('whiskey') || t.includes('whisky') || t.includes('bourbon') || t.includes('scotch') || t.includes('rye') || tg.includes('whiskey') || tg.includes('bourbon') || tg.includes('scotch')) return 'Whiskey & Bourbon';
    if (t.includes('tequila') || t.includes('mezcal') || tg.includes('tequila') || tg.includes('mezcal')) return 'Tequila & Mezcal';
    if (t.includes('cognac') || t.includes('armagnac') || t.includes('brandy') || t.includes('rum') || tg.includes('cognac') || tg.includes('rum') || tg.includes('brandy')) return 'Cognac, Brandy & Rum';
    if (t.includes('gin') || t.includes('vodka') || tg.includes('gin') || tg.includes('vodka')) return 'Gin & Vodka';

    // For wine: check name/tags for white indicators
    if (t.includes('wine') || tg.includes('wine')) {
        const allText = [...tg, t].join(' ');
        if (allText.includes('white') || allText.includes('chardonnay') || allText.includes('sauvignon') || allText.includes('riesling') || allText.includes('pinot gris') || allText.includes('pinot grigio') || allText.includes('chenin') || allText.includes('viognier') || allText.includes('albarino') || allText.includes('gewurztraminer')) return 'White Wine';
        return 'Red Wine';
    }
    return 'Red Wine';
}

// Detect white wine from product name
function isWhiteWine(name) {
    const n = name.toLowerCase();
    return /chardonnay|sauvignon blanc|pinot gris|pinot grigio|riesling|chenin|viognier|albarino|albar|gewurztraminer|white|chablis|mersault|meursault|puligny|montrachet|muscadet|vermentino|soave|orvieto|gavi|greco|fiano|falanghina|verdicchio|gruner|veltliner|albari/.test(n);
}

function isSparkling(name) {
    const n = name.toLowerCase();
    return /champagne|prosecco|cava|crémant|cremant|sekt|sparkling|fizz|brut|blanc de blancs|blanc de noirs/.test(n);
}

// Extract vintage year from title
function extractVintage(title) {
    const m = title.match(/^(\d{4})\s/);
    if (m) {
        const yr = parseInt(m[1]);
        if (yr >= 1900 && yr <= 2030) return String(yr);
    }
    return null;
}

// Strip vintage prefix from title to get wine name
function extractName(title) {
    return title.replace(/^\d{4}\s+/, '').trim();
}

// Parse price string → number
function parsePrice(s) {
    const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
    return isNaN(n) || n <= 0 ? null : n;
}

async function scrapeAll() {
    const allProducts = [];
    let page = 1;

    console.log('Scraping fineliquors.com products.json API...');
    while (true) {
        const url = `${BASE}/products.json?limit=${LIMIT}&page=${page}`;
        console.log(`  Page ${page}: ${url}`);

        let data;
        try {
            data = await get(url);
        } catch (e) {
            console.error(`  Error: ${e.message}. Stopping.`);
            break;
        }

        const products = data.products || [];
        if (!products.length) {
            console.log(`  Empty page — done at page ${page - 1}`);
            break;
        }

        allProducts.push(...products);
        console.log(`  Got ${products.length} products (total: ${allProducts.length})`);

        if (products.length < LIMIT) {
            console.log('  Last page reached.');
            break;
        }

        page++;
        await sleep(SLEEP_MS);
    }

    console.log(`\nTotal raw products fetched: ${allProducts.length}`);
    fs.writeFileSync(OUT_RAW, JSON.stringify(allProducts, null, 2));
    console.log(`Raw data saved to ${OUT_RAW}`);

    return allProducts;
}

function convert(rawProducts) {
    const now = new Date().toISOString();
    const dataset = [];
    const seen = new Set();

    for (const p of rawProducts) {
        // Use the cheapest available variant
        const variants = (p.variants || []).filter(v => parsePrice(v.price) !== null);
        if (!variants.length) continue;

        const cheapest = variants.reduce((a, b) => parsePrice(a.price) < parsePrice(b.price) ? a : b);
        const price = parsePrice(cheapest.price);
        if (!price) continue;

        const title = (p.title || '').trim();
        if (!title) continue;

        // Deduplicate by handle
        if (seen.has(p.handle)) continue;
        seen.add(p.handle);

        const vintage = extractVintage(title);
        const wineName = extractName(title);
        const tags = p.tags || [];
        const productType = p.product_type || '';

        // Refine category: also check name for white wine / sparkling
        let category = mapCategory(productType, tags);
        if (category === 'Red Wine') {
            if (isSparkling(title)) category = 'Champagne & Sparkling';
            else if (isWhiteWine(title)) category = 'White Wine';
        }

        const productUrl = `${BASE}/products/${p.handle}`;

        dataset.push({
            id: productUrl,
            wineName,
            vintage,
            region: tags.filter(t => !['wine', 'champagne', 'usa', 'whiskey', 'bourbon', 'scotch', 'tequila', 'cognac', 'gin', 'vodka', 'rum', 'sparkling', 'mezcal', 'brandy', 'armagnac'].includes(t.toLowerCase())).join(', ') || null,
            category,
            clientPrice: price,
            competitors: [],  // no competitor data yet — will be matched later
            lastUpdated: now,
        });
    }

    return dataset;
}

async function main() {
    const raw = await scrapeAll();
    const dataset = convert(raw);

    fs.writeFileSync(OUT_DATASET, JSON.stringify(dataset, null, 2));
    console.log(`\nConverted ${dataset.length} products → ${OUT_DATASET}`);

    // Category breakdown
    const byCat = {};
    dataset.forEach(p => { byCat[p.category] = (byCat[p.category] || 0) + 1; });
    console.log('\nBy category:');
    Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(30)} ${v}`));

    // Price range
    const prices = dataset.map(p => p.clientPrice).sort((a, b) => a - b);
    console.log(`\nPrice range: $${prices[0]} – $${prices[prices.length - 1]}`);
    console.log(`Median: $${prices[Math.floor(prices.length / 2)]}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
