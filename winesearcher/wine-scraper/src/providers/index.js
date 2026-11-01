const { createMockProvider } = require('./mock');
const { createWineSearcherProvider } = require('./winesearcherApi');

/** Registry of known providers; PROVIDER env selects the active one. */
function createRegistry({ env = process.env, extra = [] } = {}) {
  const all = [createMockProvider(), createWineSearcherProvider({ env }), ...extra];
  const byName = new Map(all.map((p) => [p.name, p]));
  return {
    list: () => all.map((p) => ({ ...p.meta(), ...p.status(), active: p.name === (env.PROVIDER || 'mock') })),
    get: (name) => byName.get(name || env.PROVIDER || 'mock') || null,
    activeName: () => env.PROVIDER || 'mock',
  };
}

module.exports = { createRegistry };
