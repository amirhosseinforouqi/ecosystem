'use strict';

/**
 * Microsoft Graph client (zero-dependency, built on global fetch).
 *
 * Uses the OAuth 2.0 client-credentials flow: the brokerage registers an app
 * in Microsoft Entra ID and grants it application permissions (Mail.Send,
 * Files.ReadWrite.All). The user's Outlook password is never entered into or
 * stored by this application — only the app registration's own credentials,
 * supplied server-side via environment variables:
 *
 *   MS_TENANT_ID      Entra tenant id
 *   MS_CLIENT_ID      app registration (client) id
 *   MS_CLIENT_SECRET  client secret (server-side only, never sent to the UI)
 *   MS_MAILBOX        the mailbox/user (UPN) to send mail from and whose
 *                     OneDrive stores client documents
 *
 * Test overrides (protocol-accurate mock servers in the test suite):
 *   MS_LOGIN_BASE     default https://login.microsoftonline.com
 *   MS_GRAPH_BASE     default https://graph.microsoft.com/v1.0
 */

function config() {
  return {
    tenantId: process.env.MS_TENANT_ID || '',
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    mailbox: process.env.MS_MAILBOX || '',
    loginBase: (process.env.MS_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, ''),
    graphBase: (process.env.MS_GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/$/, ''),
  };
}

function isConfigured() {
  const c = config();
  return !!(c.tenantId && c.clientId && c.clientSecret && c.mailbox);
}

let cachedToken = null; // { token, expiresAt }

async function getToken() {
  const c = config();
  if (!isConfigured()) {
    throw new Error('Microsoft 365 is not configured — set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_MAILBOX.');
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.token;
  }
  const res = await fetch(`${c.loginBase}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Microsoft sign-in failed (${res.status}): ${data.error_description || data.error || 'no access token returned'}`);
  }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return cachedToken.token;
}

function clearTokenCache() {
  cachedToken = null;
}

/**
 * Authenticated Graph request. path starts with '/'. body:
 *  - object → JSON
 *  - Buffer → raw upload (caller sets contentType)
 * Returns parsed JSON (or null for 202/204 responses).
 */
async function graphRequest(method, path, { body, contentType, headers = {} } = {}) {
  const c = config();
  const token = await getToken();
  const options = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
  if (Buffer.isBuffer(body)) {
    options.body = body;
    options.headers['Content-Type'] = contentType || 'application/octet-stream';
  } else if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${c.graphBase}${path}`, options);
  if (res.status === 401) clearTokenCache(); // expired/revoked — next call re-authenticates
  if (res.status === 202 || res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && (data.error.message || data.error.code)) || `HTTP ${res.status}`;
    throw new Error(`Microsoft Graph error on ${method} ${path}: ${message}`);
  }
  return data;
}

/** Send a plain-text email from the configured mailbox via Graph sendMail. */
async function sendMailViaGraph({ toEmail, toName, subject, text }) {
  const c = config();
  await graphRequest('POST', `/users/${encodeURIComponent(c.mailbox)}/sendMail`, {
    body: {
      message: {
        subject,
        body: { contentType: 'Text', content: text },
        toRecipients: [{ emailAddress: { address: toEmail, name: toName || undefined } }],
      },
      saveToSentItems: true,
    },
  });
}

module.exports = { isConfigured, getToken, clearTokenCache, graphRequest, sendMailViaGraph, config };
