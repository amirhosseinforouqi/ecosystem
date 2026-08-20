'use strict';

/**
 * Print the current two-step verification code for a staff account.
 *
 *   npm run code                      # the administrator
 *   npm run code -- jane@brokerage.io # somebody else
 *
 * Two-step verification is mandatory for staff and this does not weaken it:
 * the code is derived from the secret already in the database, so this only
 * works for someone who can already run commands on the server. It exists so
 * that trying the demo does not require an authenticator app on a phone.
 *
 * On a real deployment, staff use an authenticator app. Nobody should be
 * reading codes off the server — if that is happening, the second factor is
 * not doing its job.
 */

const db = require('../server/db');
const mfa = require('../server/mfa');

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      'Refusing to print a verification code with NODE_ENV=production.\n' +
      'Staff use an authenticator app; a code read off the server is not a second factor.'
    );
    process.exit(1);
  }

  const email = (process.argv[2] || process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const user = await db.get(
    "SELECT id, email, first_name, mfa_secret, mfa_enrolled_at FROM users WHERE lower(email) = ? AND role <> 'client'",
    email
  );

  if (!user) {
    console.error(`No staff account found for ${email}.`);
    const others = await db.all("SELECT email FROM users WHERE role <> 'client' ORDER BY id");
    if (others.length) console.error('Staff accounts: ' + others.map((u) => u.email).join(', '));
    await db.close();
    process.exit(1);
  }

  if (!user.mfa_secret) {
    console.log(`\n${user.email} has not set up two-step verification yet.`);
    console.log('Sign in with the password and the setup screen will walk you through it.');
    console.log('Then run this command again to get a code without a phone.\n');
    await db.close();
    return;
  }

  const step = mfa.currentStep();
  const secondsLeft = 30 - Math.floor((Date.now() / 1000) % 30);

  console.log('');
  console.log(`  ${user.email}`);
  console.log(`  CODE:  ${mfa.codeForStep(user.mfa_secret, step)}`);
  console.log(`  valid for ${secondsLeft}s (the next one is ${mfa.codeForStep(user.mfa_secret, step + 1)})`);
  console.log('');
  if (secondsLeft < 8) {
    console.log('  That one is about to expire — use the next one.');
    console.log('');
  }

  await db.close();
}

main().catch(async (err) => {
  console.error('Could not read the code:', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
