const crypto = require('crypto');

/**
 * Deterministic mock provider for development/tests. Its output is fake by definition:
 * `verifies: false` means the refresh runner stores results as DEMO and never sets lastVerifiedAt.
 * Price = clientPrice * (0.92..1.12), a pure function of (productKey, vendor, seed).
 */
function unit(...parts) {
  const h = crypto.createHash('sha256').update(parts.join('|')).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function createMockProvider({ seed = 'default', vendors = null } = {}) {
  return {
    name: 'mock',
    verifies: false,
    meta: () => ({
      name: 'mock',
      description: 'Deterministic fake prices for development. Not real market data.',
      sourceType: 'MOCK',
      refreshFrequency: 'any',
      requires: [],
    }),
    status: () => ({ configured: true, state: 'CONFIGURED', reason: null }),
    /** products: [{ sourceKey, clientPrice, offers: [{ vendorName }] }] */
    async fetchOffers(products, { seed: runSeed = seed } = {}) {
      const observedAt = new Date();
      const out = [];
      for (const p of products) {
        const names = vendors || p.offers.map((o) => o.vendorName);
        for (const vendorName of names) {
          const factor = 0.92 + unit(p.sourceKey, vendorName, runSeed) * 0.2;
          out.push({
            productKey: p.sourceKey,
            vendorName,
            price: Math.round(p.clientPrice * factor * 100) / 100,
            currency: 'USD',
            availability: null,
            observedAt,
          });
        }
      }
      return out;
    },
  };
}

module.exports = { createMockProvider };
