'use strict';

require('dotenv').config();
const path = require('path');
const prisma = require('../lib/db');
const { importCsv } = require('./csvImporter');

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileArg = args.find((a) => !a.startsWith('--'));

  if (!fileArg) {
    console.error('Usage: node src/import/csvCli.js [--dry-run] <path-to-file.csv>');
    console.error('Example: node src/import/csvCli.js --dry-run data/prices.csv');
    process.exitCode = 1;
    return;
  }

  const file = path.resolve(fileArg);
  const t0 = Date.now();
  try {
    const s = await importCsv(prisma, file, { dryRun });
    console.log(JSON.stringify(s, null, 2));
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (dryRun) {
      console.log(`\nDry run complete in ${elapsed}s. ${s.counts.validProducts} products (${s.counts.totalRows} rows). Re-run without --dry-run to apply.`);
    } else {
      console.log(`\nDone in ${elapsed}s.`);
      console.log(`  Products: +${s.created.products} created, ${s.updated.products} updated`);
      console.log(`  Vendors:  +${s.created.vendors} created`);
      console.log(`  Offers:   +${s.created.offers} created, ${s.updated.offers} updated, ${s.unchanged.offers} unchanged`);
      console.log(`  History:  ${s.historyRows} price-change rows`);
      if (s.counts.issues > 0) console.log(`  Issues:   ${s.counts.issues} rows skipped (see "issues" in output)`);
    }
  } catch (e) {
    console.error(`Import failed (${e.code || 'ERROR'}): ${e.message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
