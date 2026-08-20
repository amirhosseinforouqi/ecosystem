'use strict';

/**
 * Shared plumbing for the demo/reset scripts: boot the app on a scratch port
 * and drive it over HTTP, exactly as a browser would, so the scripts can
 * never take a shortcut past a control the real UI has to satisfy.
 */

const http = require('node:http');

function guardEnvironment(action) {
  if (process.env.NODE_ENV === 'production') {
    console.error(`Refusing to ${action} with NODE_ENV=production.`);
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Start a PostgreSQL database first — see docs/DEPLOYMENT.md.');
    process.exit(1);
  }
  if (!process.env.ADMIN_EMAIL) {
    console.error('Set ADMIN_EMAIL (and optionally ADMIN_PASSWORD). There is no default account.');
    process.exit(1);
  }
}

async function start() {
  const app = require('../server/app');
  await app.ready();
  const server = http.createServer((req, res) => { app.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** A cookie-jar HTTP client. */
function makeClient(base) {
  const cookies = new Map();
  return {
    async call(method, url, { body, raw, filename } = {}) {
      const headers = { 'X-Requested-With': 'fetch' };
      if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      let payload;
      if (raw !== undefined) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['X-Filename'] = encodeURIComponent(filename);
        payload = raw;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + url, { method, headers, body: payload });
      for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        const value = pair.slice(i + 1).trim();
        if (value === '') cookies.delete(pair.slice(0, i).trim());
        else cookies.set(pair.slice(0, i).trim(), value);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${data.message || ''}`);
      return data;
    },
    get(url) { return this.call('GET', url); },
    post(url, body) { return this.call('POST', url, { body }); },
    put(url, body) { return this.call('PUT', url, { body }); },
    upload(url, raw, filename) { return this.call('POST', url, { raw, filename }); },
  };
}

/**
 * Sign the administrator in through every mandatory step: password change and
 * two-step verification.
 *
 * MFA is not bypassed for demos — that is the point of the control. The
 * enrolment secret is generated here and printed, so the operator can add it
 * to their authenticator app and sign in normally afterwards.
 */
async function signInAdmin(base, { quiet = false } = {}) {
  const mfa = require('../server/mfa');
  const client = makeClient(base);

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error('Set ADMIN_PASSWORD to the password printed when the administrator account was created.');
  }

  let res = await client.post('/api/auth/login', { email, password });
  let finalPassword = password;

  if (res.mfa_required) {
    const user = await require('../server/db').get('SELECT * FROM users WHERE lower(email) = lower(?)', email);
    await require('../server/db').run('UPDATE users SET mfa_last_used_step = NULL WHERE id = ?', user.id);
    res = await client.post('/api/auth/mfa/verify', { code: mfa.codeForStep(user.mfa_secret, mfa.currentStep()) });
  }

  if (res.must_change_password) {
    // A bootstrap password is single-use by design; pick a strong one and
    // print it so the operator can actually sign in afterwards.
    finalPassword = process.env.DEMO_ADMIN_PASSWORD
      || `Demo-${require('../server/auth').generateTemporaryPassword()}`;
    res = await client.post('/api/auth/change-password', {
      current_password: password, new_password: finalPassword,
    });
  }

  const status = await client.get('/api/auth/mfa/status');
  let mfaUri = null;
  if (status.required && !status.enrolled) {
    const begin = await client.post('/api/auth/mfa/begin');
    mfaUri = begin.uri;
    await client.post('/api/auth/mfa/confirm', { code: mfa.codeForStep(begin.secret, mfa.currentStep()) });
    if (!quiet) {
      console.log('\nTwo-step verification is required for administrators and has been set up.');
      console.log('Add this to your authenticator app (scan the URI as a QR code, or type the secret):');
      console.log(`  ${mfaUri}\n`);
    }
  }

  client.email = email;
  client.password = finalPassword;
  client.mfaUri = mfaUri;
  return client;
}

module.exports = { guardEnvironment, start, makeClient, signInAdmin };
