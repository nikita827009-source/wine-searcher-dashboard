// Browser client for the Fine Liquors pricing API.
// Keeps the original window.WineSearcherAPI surface used by the classic fine.html UI,
// and maps the database-backed /api/products response to the tuple format that UI renders.
const API_BASE_URL = (location.protocol === 'file:') ? 'http://localhost:5000/api' : '/api';

// The classic UI groups the catalog into 7 headline categories.
const UI_CATEGORIES = ["Red Wine", "White Wine", "Champagne & Sparkling", "Whiskey & Bourbon", "Tequila & Mezcal", "Cognac, Brandy & Rum", "Gin & Vodka"];

function uiCategoryOf(dbCategory) {
    var c = String(dbCategory || '').toLowerCase();
    if (c.indexOf('champagne') === 0 || c.indexOf('sparkling') >= 0) return 2;
    if (c.indexOf('whiskey') === 0 || c.indexOf('whisky') >= 0) return 3;
    if (c.indexOf('tequila') === 0) return 4;
    if (c.indexOf('cognac') === 0) return 5;
    if (c.indexOf('gin') === 0) return 6;
    if (/burgundy white|chardonnay|sauvignon blanc|white/.test(c)) return 1;
    return 0;
}

async function apiGet(path, params) {
    var qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(function (e) { return e[1] !== undefined && e[1] !== '' && e[1] !== null; })).toString() : '';
    try {
        var res = await fetch(API_BASE_URL + path + qs);
        var data = await res.json().catch(function () { return null; });
        return res.ok ? data : null;
    } catch (error) {
        console.error('[API error]', path, error);
        return null;
    }
}

async function apiPost(path, body, token) {
    try {
        var headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        var res = await fetch(API_BASE_URL + path, { method: 'POST', headers: headers, body: JSON.stringify(body) });
        var data = await res.json().catch(function () { return null; });
        return { ok: res.ok, status: res.status, data: data };
    } catch (error) {
        console.error('[API error]', path, error);
        return { ok: false, data: null };
    }
}

async function apiDelete(path, token) {
    try {
        var headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        var res = await fetch(API_BASE_URL + path, { method: 'DELETE', headers: headers });
        return res.ok;
    } catch { return false; }
}

/** Fetch a balanced catalog (up to `limit` products across the 7 UI categories) for the classic UI. */
async function fetchProducts(params) {
    params = params || {};
    var limit = parseInt(params.limit, 10) || 700;
    var per = Math.max(25, Math.ceil(limit / UI_CATEGORIES.length));
    var filters = await apiGet('/filters');
    if (!filters) return null;

    var vendors = filters.vendors.map(function (v) { return [v.name, v.rating == null ? 0 : v.rating, v.state || 'USA']; });
    var vIdx = {}; filters.vendors.forEach(function (v, j) { vIdx[v.id] = j; });

    var groups = UI_CATEGORIES.map(function () { return []; });
    filters.categories.forEach(function (c) { groups[uiCategoryOf(c.name)].push(c.name); });

    var pages = await Promise.all(groups.map(function (names) {
        if (!names.length) return Promise.resolve({ products: [] });
        return apiGet('/products', { category: names.join('|'), q: params.q, pageSize: Math.min(per, 100) });
    }));
    if (pages.some(function (p) { return p === null; })) return null;

    var products = [];
    pages.forEach(function (pg) {
        pg.products.forEach(function (p) {
            var offers = p.offers.filter(function (o) { return o.comparable; }).map(function (o) { return { v: o.vendor, j: vIdx[o.vendorId], p: o.price }; });
            var avg = offers.length ? Math.round(offers.reduce(function (a, o) { return a + o.p; }, 0) / offers.length) : p.clientPrice;
            products.push([p.name, p.vintage || 'NV', p.bottleSize || '750 ml', p.sku, uiCategoryOf(p.category), p.clientPrice, avg, offers, p.id]);
        });
    });
    return { success: true, total: products.length, categories: UI_CATEGORIES, vendors: vendors, products: products };
}

async function fetchVendors() {
    var f = await apiGet('/filters');
    return f ? { success: true, vendors: f.vendors.map(function (v) { return [v.name, v.rating || 0, v.state || 'USA']; }) } : null;
}

async function fetchSettings() {
    return apiGet('/settings');
}

async function saveSettings(data, token) {
    return apiPost('/settings', data, token);
}

async function fetchAlerts(params) {
    return apiGet('/alerts', params);
}

async function markAlertsRead(ids, token) {
    return apiPost('/alerts/read', ids ? { ids: ids } : {}, token);
}

async function clearAlerts(token) {
    return apiDelete('/alerts', token);
}

window.WineSearcherAPI = {
    getProducts: fetchProducts,
    getVendors: fetchVendors,
    searchWine: async function () { return null; },
    liveScrape: async function () { return null; },
    getSettings: fetchSettings,
    saveSettings: saveSettings,
    getAlerts: fetchAlerts,
    markAlertsRead: markAlertsRead,
    clearAlerts: clearAlerts,
};
