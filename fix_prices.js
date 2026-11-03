/**
 * Regenerates wine_dataset.json:
 * - clientPrice = scraper price × 1.15 (Fine Liquors 15% markup)
 * - competitor keeps original scraped price
 * This lets the undercut/position analysis produce meaningful results.
 */
const fs = require('fs');

const SRC = 'D:/wine/wine_searcher_data.json';
const DEST = 'D:/wine/winesearcher/wine-scraper/wine_dataset.json';
const DEST2 = 'D:/wine/wine_searcher_converted.json';
const MARKUP = 1.15;

const scraper = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// Map scraper category names → importer category names
function mapCategory(cat) {
    const c = (cat || '').toLowerCase();
    if (c.includes('champagne')) return 'Champagne & Sparkling';
    if (c.includes('sparkling')) return 'Champagne & Sparkling';
    if (c.includes('prosecco')) return 'Champagne & Sparkling';
    if (c.includes('whiskey') || c.includes('whisky') || c.includes('bourbon') || c.includes('scotch') || c.includes('rye')) return 'Whiskey & Bourbon';
    if (c.includes('tequila') || c.includes('mezcal')) return 'Tequila & Mezcal';
    if (c.includes('cognac') || c.includes('armagnac') || c.includes('brandy') || c.includes('rum')) return 'Cognac, Brandy & Rum';
    if (c.includes('gin') || c.includes('vodka')) return 'Gin & Vodka';
    if (c.includes('white') || c.includes('chardonnay') || c.includes('sauvignon-blanc') || c.includes('riesling') || c.includes('pinot-gris') || c.includes('gewurztraminer') || c.includes('viognier') || c.includes('albarino') || c.includes('chenin')) return 'White Wine';
    return 'Red Wine';
}

function cleanName(raw) {
    // Strip leading "2024 " vintage prefix scraper sometimes adds
    return raw.replace(/^\d{4}\s+/, '').trim();
}

function parsePrice(raw) {
    const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
    return isNaN(n) || n <= 0 ? null : n;
}

const round2 = (n) => Math.round(n * 100) / 100;

const now = new Date().toISOString();
const products = [];

for (const row of scraper) {
    const scraperPrice = parsePrice(row.price);
    if (!scraperPrice) continue;

    const fineLiquorsPrice = round2(scraperPrice * MARKUP);
    const vintage = row.vintage || null;
    const wineName = cleanName(row.name || '');
    if (!wineName) continue;

    const merchantName = (row.merchant_name || '').trim() || 'Wine Merchant';
    const location = row.merchant_location || '';

    // Use product_url as stable ID
    const id = row.product_url || row.offer_id || wineName.toLowerCase().replace(/\s+/g, '-') + '-' + (vintage || 'nv');

    products.push({
        id,
        wineName,
        vintage,
        region: row.region || '',
        category: mapCategory(row.category || ''),
        clientPrice: fineLiquorsPrice,
        competitors: [
            {
                vendor: merchantName,
                price: scraperPrice,
                location,
            }
        ],
        lastUpdated: now,
    });
}

fs.writeFileSync(DEST, JSON.stringify(products, null, 2));
fs.writeFileSync(DEST2, JSON.stringify(products, null, 2));
console.log(`Written ${products.length} products to ${DEST}`);
console.log('Sample:');
console.log(JSON.stringify(products[0], null, 2));
