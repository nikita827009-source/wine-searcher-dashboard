const { ProviderError } = require('./util');

/**
 * Placeholder for a LICENSED Wine-Searcher data-access integration.
 * Nothing here calls Wine-Searcher: no endpoint, parameters or response format have been
 * verified against official documentation, and no client credentials are available.
 * Without WINESEARCHER_API_KEY the status is NOT_CONFIGURED and a refresh is SKIPPED -
 * it never reports success. Even with a key set, fetchOffers fails with NOT_IMPLEMENTED
 * until the adapter is written against the official API contract supplied by the client.
 */
function createWineSearcherProvider({ env = process.env } = {}) {
  const hasKey = () => Boolean(env.WINESEARCHER_API_KEY && env.WINESEARCHER_API_KEY.trim());
  return {
    name: 'winesearcher-api',
    verifies: true, // would be true once a real, authorized response is parsed
    meta: () => ({
      name: 'winesearcher-api',
      description: 'Licensed Wine-Searcher API access (client must supply credentials and licence).',
      sourceType: 'API',
      refreshFrequency: 'per licence terms (unverified)',
      requires: ['WINESEARCHER_API_KEY'],
    }),
    status: () =>
      hasKey()
        ? { configured: false, state: 'NOT_IMPLEMENTED', reason: 'API key present but adapter not implemented against the official contract.' }
        : { configured: false, state: 'NOT_CONFIGURED', reason: 'WINESEARCHER_API_KEY is not set.' },
    async fetchOffers() {
      throw new ProviderError(hasKey() ? 'NOT_IMPLEMENTED' : 'NOT_CONFIGURED', 'Wine-Searcher provider is not available');
    },
  };
}

module.exports = { createWineSearcherProvider };
