'use strict';

/**
 * Sends one real test email using the SMTP_* environment variables, so you
 * can confirm your mailbox connection works before relying on it inside the
 * app. Does not touch the app's database.
 *
 * Run:  npm run test:email -- you@example.com
 * (or)  npm run test:email -- you@example.com "Custom subject"
 */

const { sendMail } = require('../server/smtp');

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: npm run test:email -- you@example.com');
    process.exit(1);
  }
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.error('Set SMTP_HOST, SMTP_USER and SMTP_PASS first (see README "Connect a real email account").');
    process.exit(1);
  }

  console.log(`Connecting to ${host}:${process.env.SMTP_PORT || 587} as ${user}...`);
  try {
    await sendMail({
      host,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true' ? true : process.env.SMTP_SECURE === 'false' ? false : undefined,
      user,
      pass,
      from: process.env.SMTP_FROM || user,
      fromName: process.env.SMTP_FROM_NAME || undefined,
      to,
      subject: process.argv[3] || 'Test email from your mortgage platform',
      text: 'If you are reading this, SMTP is configured correctly. You can now create clients and real emails will be delivered.',
    });
    console.log(`Sent! Check the inbox for ${to}.`);
  } catch (err) {
    console.error('Failed to send:', err.message);
    process.exit(1);
  }
}

main();
