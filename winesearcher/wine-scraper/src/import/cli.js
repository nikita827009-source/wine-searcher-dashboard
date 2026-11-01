require('dotenv').config();
const path = require('path');
const prisma = require('../lib/db');
const { importDataset } = require('./importer');

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', '..', 'wine_dataset.json');
  const t0 = Date.now();
  try {
    const s = await importDataset(prisma, file, { dryRun });
    console.log(JSON.stringify(s, null, 2));
    console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. Report: ${s.reportPath}`);
  } catch (e) {
    console.error(`Import failed (${e.code || 'ERROR'}): ${e.message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
