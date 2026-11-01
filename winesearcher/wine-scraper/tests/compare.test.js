const test = require('node:test');
const assert = require('node:assert/strict');
const { priceDifference, percentDifference, priceChange, comparability, freshness, compareProduct } = require('../src/pricing/compare');

const NOW = new Date('2026-10-28T12:00:00Z');
const product = { clientPrice: 100, bottleSize: '750 ml', currency: 'USD' };
const offer = (o) => ({ vendorId: 1, price: 90, bottleSize: '750ml', currency: 'USD', vintageMatch: 'EXACT', verificationStatus: 'VERIFIED', lastVerifiedAt: new Date('2026-10-28T08:00:00Z'), availability: 'IN_STOCK', ...o });

test('formulas match the spec', () => {
  assert.equal(priceDifference(90, 100), -10);
  assert.equal(percentDifference(90, 100), -10);
  assert.equal(percentDifference(125, 100), 25);
  assert.equal(percentDifference(100.5, 3), 3250);
  assert.deepEqual(priceChange(110, 100), { absolute: 10, percent: 10 });
  assert.deepEqual(priceChange(95, 100), { absolute: -5, percent: -5 });
});

test('zero, negative, null and NaN prices are handled safely (no Infinity/NaN)', () => {
  for (const bad of [0, -5, null, undefined, NaN, Infinity, '12']) {
    assert.equal(priceDifference(bad, 100), null);
    assert.equal(percentDifference(90, bad), null);
    assert.equal(priceChange(bad, 100), null);
  }
  assert.equal(percentDifference(90, 0), null);
});

test('bottle size mismatch excludes the offer; unknown size is an assumption, not a match', () => {
  assert.deepEqual(comparability(product, offer({ bottleSize: '1.5 L' })).reasons, ['bottle-size-mismatch']);
  const unknown = comparability({ ...product, bottleSize: null }, offer({ bottleSize: null }));
  assert.equal(unknown.comparable, true);
  assert.ok(unknown.assumptions.includes('bottle-size-unknown'));
});

test('currency mismatch excludes; unknown currency is flagged; no FX conversion is attempted', () => {
  assert.ok(comparability(product, offer({ currency: 'EUR' })).reasons.includes('currency-mismatch'));
  const c = comparability({ ...product, currency: null }, offer({ currency: null }));
  assert.ok(c.comparable && c.assumptions.includes('currency-unknown'));
});

test('vintage mismatch excludes; unconfirmed vintage is flagged', () => {
  assert.ok(comparability(product, offer({ vintageMatch: 'MISMATCH' })).reasons.includes('vintage-mismatch'));
  assert.ok(comparability(product, offer({ vintageMatch: null })).assumptions.includes('vintage-unconfirmed'));
});

test('invalid offer or reference price makes the offer incomparable', () => {
  assert.ok(comparability(product, offer({ price: 0 })).reasons.includes('invalid-price'));
  assert.ok(comparability({ ...product, clientPrice: 0 }, offer()).reasons.includes('invalid-reference-price'));
});

test('freshness is based on lastVerifiedAt only', () => {
  assert.equal(freshness({ lastVerifiedAt: null, observedAt: NOW }, NOW), 'never');
  assert.equal(freshness({ lastVerifiedAt: new Date('2026-10-28T00:00:00Z') }, NOW, 48), 'fresh');
  assert.equal(freshness({ lastVerifiedAt: new Date('2026-10-20T00:00:00Z') }, NOW, 48), 'stale');
});

test('lowest observed vs lowest verified are kept separate and never mislabelled', () => {
  const offers = [
    offer({ vendorId: 1, price: 80, verificationStatus: 'DEMO', lastVerifiedAt: null }),
    offer({ vendorId: 2, price: 95 }),
    offer({ vendorId: 3, price: 85, lastVerifiedAt: new Date('2026-10-01T00:00:00Z') }), // verified but stale
    offer({ vendorId: 4, price: 70, availability: 'OUT_OF_STOCK' }),
  ];
  const r = compareProduct(product, offers, { now: NOW });
  assert.equal(r.lowestObserved.price, 70);
  assert.equal(r.lowestVerified.price, 95);
  assert.equal(r.lowestVerified.vendorId, 2);
  assert.equal(r.verifiedCount, 1);
  assert.equal(r.lowestDelivered, null, 'no shipping/tax data => no delivered price');
});

test('no verified offers => lowestVerified is null (never guessed)', () => {
  const r = compareProduct(product, [offer({ verificationStatus: 'DEMO', lastVerifiedAt: null })], { now: NOW });
  assert.equal(r.lowestVerified, null);
  assert.equal(r.verifiedCount, 0);
});

test('delivered price only when both shipping and tax are known', () => {
  const r = compareProduct(product, [offer({ vendorId: 1, price: 90, shipping: 10, tax: 5 }), offer({ vendorId: 2, price: 80, shipping: 30, tax: 0 }), offer({ vendorId: 3, price: 50, shipping: 5 })], { now: NOW });
  assert.equal(r.lowestDelivered.price, 105);
  assert.equal(r.lowestDelivered.vendorId, 1);
});

test('mismatched-size offers are excluded from every lowest-price figure', () => {
  const r = compareProduct(product, [offer({ price: 10, bottleSize: '375 ml' }), offer({ vendorId: 2, price: 99 })], { now: NOW });
  assert.equal(r.comparableCount, 1);
  assert.equal(r.lowestObserved.price, 99);
});
