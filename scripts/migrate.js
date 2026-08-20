'use strict';

/**
 * Apply the schema and seed the brokerage defaults.
 *
 * Safe to run repeatedly: every statement in schema.sql is IF NOT EXISTS, and
 * seeding only fills in what is missing. Run it on every deploy.
 */

const db = require('../server/db');

async function main() {
  const started = Date.now();
  await db.migrate();
  console.log(`Schema applied (${Date.now() - started} ms).`);
  // seedIfNeeded() also creates the first administrator when none exists.
  // It requires ADMIN_EMAIL and deliberately has no default password.
  const { seedIfNeeded } = require('../server/seed');
  await seedIfNeeded();
  console.log('Brokerage defaults present.');

  await db.close();
}

main().catch(async (err) => {
  console.error('Migration failed:', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
