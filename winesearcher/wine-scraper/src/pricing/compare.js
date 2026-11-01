/**
 * Pure price-comparison functions. No I/O.
 * Formulas (per spec):
 *   difference = competitor - fineLiquors
 *   percentDifference = (competitor - fineLiquors) / fineLiquors * 100
 *   change = current - previous
 */
const round2 = (n) => Math.round(n * 100) / 100;
const isPrice = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

function priceDifference(competitorPrice, fineLiquorsPrice) {
  if (!isPrice(competitorPrice) || !isPrice(fineLiquorsPrice)) return null;
  return round2(competitorPrice - fineLiquorsPrice);
}

function percentDifference(competitorPrice, fineLiquorsPrice) {
  if (!isPrice(competitorPrice) || !isPrice(fineLiquorsPrice)) return null;
  return round2(((competitorPrice - fineLiquorsPrice) / fineLiquorsPrice) * 100);
}

function priceChange(current, previous) {
  if (!isPrice(current) || !isPrice(previous)) return null;
  const abs = round2(current - previous);
  return { absolute: abs, percent: round2((abs / previous) * 100) };
}

const norm = (s) => (s == null ? null : String(s).trim().toLowerCase().replace(/\s+/g, ''));

/**
 * Decide whether an offer may be compared with the product.
 * Unknown size/currency on BOTH sides is treated as "assumed" (flagged), a known
 * mismatch excludes the offer. Returns { comparable, reasons[], assumptions[] }.
 */
function comparability(product, offer) {
  const reasons = [];
  const assumptions = [];
  if (!isPrice(offer.price)) reasons.push('invalid-price');
  if (!isPrice(product.clientPrice)) reasons.push('invalid-reference-price');

  const ps = norm(product.bottleSize), os = norm(offer.bottleSize);
  if (ps && os && ps !== os) reasons.push('bottle-size-mismatch');
  else if (!ps || !os) assumptions.push('bottle-size-unknown');

  const pc = product.currency && product.currency.toUpperCase();
  const oc = offer.currency && offer.currency.toUpperCase();
  if (pc && oc && pc !== oc) reasons.push('currency-mismatch'); // no FX source configured
  else if (!pc || !oc) assumptions.push('currency-unknown');

  if (offer.vintageMatch === 'MISMATCH') reasons.push('vintage-mismatch');
  else if (offer.vintageMatch !== 'EXACT') assumptions.push('vintage-unconfirmed');

  return { comparable: reasons.length === 0, reasons, assumptions };
}

/** fresh | stale | never — based on lastVerifiedAt only (observedAt is not verification). */
function freshness(offer, now = new Date(), staleAfterHours = 48) {
  if (!offer.lastVerifiedAt) return 'never';
  const ageH = (now - new Date(offer.lastVerifiedAt)) / 3.6e6;
  return ageH > staleAfterHours ? 'stale' : 'fresh';
}

/** An offer is "verified & current" only with a VERIFIED status, a fresh verification and not out of stock. */
function isVerifiedCurrent(offer, now, staleAfterHours) {
  return (
    offer.verificationStatus === 'VERIFIED' &&
    freshness(offer, now, staleAfterHours) === 'fresh' &&
    offer.availability !== 'OUT_OF_STOCK' &&
    offer.stockStatus !== 'OUT_OF_STOCK'
  );
}

const cheapest = (offers, fn = (o) => o.price) =>
  offers.reduce((best, o) => (best === null || fn(o) < fn(best) ? o : best), null);

/**
 * Summarise a product against its offers.
 * - lowestObserved: cheapest comparable offer regardless of verification (labelled by status)
 * - lowestVerified: cheapest comparable, VERIFIED, fresh, in-stock offer; null if none (never guessed)
 * - lowestDelivered: cheapest by price+shipping+tax, only among offers that report shipping AND tax
 */
function compareProduct(product, offers, { now = new Date(), staleAfterHours = 48 } = {}) {
  const rows = offers.map((offer) => {
    const c = comparability(product, offer);
    return {
      offer,
      comparable: c.comparable,
      exclusionReasons: c.reasons,
      assumptions: c.assumptions,
      difference: c.comparable ? priceDifference(offer.price, product.clientPrice) : null,
      percentDifference: c.comparable ? percentDifference(offer.price, product.clientPrice) : null,
      freshness: freshness(offer, now, staleAfterHours),
      verifiedCurrent: c.comparable && isVerifiedCurrent(offer, now, staleAfterHours),
    };
  });
  const comparable = rows.filter((r) => r.comparable);
  const verified = comparable.filter((r) => r.verifiedCurrent);
  const delivered = comparable.filter((r) => r.offer.shipping != null && r.offer.tax != null);

  const pick = (list, fn) => {
    const r = cheapest(list, (x) => fn(x.offer));
    return r ? { vendorId: r.offer.vendorId, price: fn(r.offer), difference: r.difference, percentDifference: r.percentDifference, verificationStatus: r.offer.verificationStatus } : null;
  };

  return {
    rows,
    comparableCount: comparable.length,
    verifiedCount: verified.length,
    lowestObserved: pick(comparable, (o) => o.price),
    lowestVerified: pick(verified, (o) => o.price),
    lowestDelivered: pick(delivered, (o) => o.price + o.shipping + o.tax),
  };
}

module.exports = { priceDifference, percentDifference, priceChange, comparability, freshness, isVerifiedCurrent, compareProduct, isPrice };
