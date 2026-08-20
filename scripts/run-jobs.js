'use strict';

/**
 * Run every background pass once and exit. For hosts that provide a cron
 * runner but not a long-lived process (or for a manual catch-up).
 */

const db = require('../server/db');

async function main() {
  const results = await require('../server/jobs').runAllJobs();
  console.log(JSON.stringify(results, null, 2));
  await db.close();
}

main().catch(async (err) => {
  console.error('Jobs failed:', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
