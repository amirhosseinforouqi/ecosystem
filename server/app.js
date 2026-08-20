'use strict';

/**
 * The HTTP application, independent of how it is hosted.
 *
 * `handle(req, res)` is a plain Node request listener, so the same code runs
 * behind `http.createServer` (npm start) and behind Vercel's Node runtime
 * (api/index.js). Nothing in here starts timers or binds ports.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ApiError } = require('./util');
const { Router, HANDLED, readJsonBody } = require('./router');
const { getSessionUser } = require('./auth');
const db = require('./db');
const ratelimit = require('./ratelimit');
const sentry = require('./sentry');

const router = new Router();
require('./routes/auth.routes').register(router);
require('./routes/broker.routes').register(router);
require('./routes/client.routes').register(router);
require('./routes/settings.routes').register(router);
require('./routes/ops.routes').register(router);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------------------
// Boot

let bootPromise = null;

/**
 * Idempotent startup: verify the environment, run migrations, seed defaults.
 * Every request awaits this, so a serverless cold start cannot serve traffic
 * against an un-migrated database.
 */
function ready() {
  if (!bootPromise) {
    bootPromise = (async () => {
      assertProductionConfig();
      sentry.init();
      await db.migrate();
      await require('./seed').seedIfNeeded();
    })().catch((err) => {
      // Let the next request retry rather than caching a transient failure
      // (e.g. the database still starting up) forever.
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

/**
 * Fail fast on a production configuration that would silently be insecure.
 * Every one of these was an audit finding; none of them should be a runtime
 * surprise discovered by a client.
 */
function assertProductionConfig() {
  require('./crypto-store').assertConfigured();
  require('./storage').assertBackendUsable();
  require('./scan').assertConfiguredForProduction();

  if (process.env.NODE_ENV !== 'production') return;

  const problems = [];
  if (process.env.FORCE_SECURE_COOKIES !== '1') {
    problems.push('FORCE_SECURE_COOKIES must be "1" in production so session cookies are never sent over plain HTTP.');
  }
  if (!process.env.APP_URL || !process.env.APP_URL.startsWith('https://')) {
    problems.push('APP_URL must be set to your https:// production URL (it builds the links in client emails).');
  }
  if (!process.env.DATABASE_URL) {
    problems.push('DATABASE_URL must point at your production PostgreSQL database.');
  }
  if (process.env.EMAIL_TRANSPORT === 'log' || !process.env.EMAIL_TRANSPORT) {
    problems.push('EMAIL_TRANSPORT must be set (graph or smtp) — "log" silently drops client email.');
  }
  if (problems.length) {
    throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  }
}

// ---------------------------------------------------------------------------
// Request helpers

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const key = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * Client IP, honouring X-Forwarded-For only as far as we actually trust it
 * (audit finding C3).
 *
 * TRUST_PROXY is the number of reverse proxies in front of the app (Vercel
 * and most managed platforms: 1). With the default of 0, the header is
 * ignored entirely — otherwise anyone could spoof it and walk straight
 * through the per-IP rate limits and the login lockout.
 */
function clientIp(req) {
  const hops = Number(process.env.TRUST_PROXY) || 0;
  const socketIp = (req.socket && req.socket.remoteAddress) || '';
  if (hops <= 0) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!chain.length) return socketIp;
  // The right-most entry is the address our nearest proxy saw. Step back one
  // entry per trusted hop; never past the start of the chain.
  const index = Math.max(0, chain.length - hops);
  return chain[index] || socketIp;
}

function isSecureRequest(req) {
  if (process.env.FORCE_SECURE_COOKIES === '1') return true;
  if ((Number(process.env.TRUST_PROXY) || 0) > 0) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto === 'https') return true;
  }
  return !!(req.socket && req.socket.encrypted);
}

function securityHeaders(res, secure) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "object-src 'none'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; " +
    "connect-src 'self'"
  );
  // HSTS (audit finding H7). Only sent over HTTPS, as the spec requires.
  if (secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function sendJson(res, status, obj, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(filePath).pipe(res);
}

/** SPA page routing: pretty URLs → the right portal's index.html. */
function resolvePage(pathname) {
  if (
    pathname === '/' || pathname === '/login' || pathname === '/activate' ||
    pathname === '/reset' || pathname === '/change-password' ||
    pathname === '/mfa' || pathname === '/mfa-setup'
  ) {
    return path.join(PUBLIC_DIR, 'login.html');
  }
  if (pathname === '/broker' || pathname.startsWith('/broker/')) {
    return path.join(PUBLIC_DIR, 'broker', 'index.html');
  }
  if (pathname === '/portal' || pathname.startsWith('/portal/')) {
    return path.join(PUBLIC_DIR, 'portal', 'index.html');
  }
  return null;
}

/**
 * CSRF: a cross-site form post cannot set a custom header, and our frontend
 * always does. The Origin header is checked as well when present, so a
 * same-site-but-wrong-host request is rejected too.
 */
function assertSameOrigin(req, url) {
  if (req.headers['x-requested-with'] !== 'fetch') {
    throw new ApiError(403, 'Bad request origin.', 'csrf');
  }
  const origin = req.headers.origin;
  if (!origin) return; // same-origin fetches may omit it
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, 'Bad request origin.', 'csrf');
  }
  const allowed = new Set([url.host]);
  if (process.env.APP_URL) {
    try { allowed.add(new URL(process.env.APP_URL).host); } catch { /* ignored */ }
  }
  if (!allowed.has(originHost)) {
    throw new ApiError(403, 'Bad request origin.', 'csrf');
  }
}

// ---------------------------------------------------------------------------
// Handler

async function handle(req, res) {
  const secure = isSecureRequest(req);
  securityHeaders(res, secure);

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendJson(res, 400, { ok: false, code: 'bad_request', message: 'Bad request.' });
    return;
  }
  const pathname = url.pathname;

  const ctx = {
    req,
    res,
    url,
    query: Object.fromEntries(url.searchParams),
    params: {},
    body: null,
    cookies: parseCookies(req.headers.cookie),
    user: null,
    session: null,
    sessionToken: null,
    status: 200,
    ip: clientIp(req),
    isSecure: secure,
    HANDLED,
  };

  try {
    await ready();

    ctx.sessionToken = ctx.cookies.sid || null;
    if (ctx.sessionToken) {
      const auth = await getSessionUser(ctx.sessionToken);
      if (auth) {
        ctx.user = auth.user;
        ctx.session = auth.session;
      }
    }

    if (pathname.startsWith('/api/')) {
      // Blanket rate limit before any routing work, so an unknown path is
      // just as cheap to refuse as a known one.
      const ipRule = ratelimit.rule('api_ip');
      await ratelimit.enforce(`api:ip:${ctx.ip}`, ipRule.limit, ipRule.window);
      if (ctx.user) {
        const userRule = ratelimit.rule('api_user');
        await ratelimit.enforce(`api:user:${ctx.user.id}`, userRule.limit, userRule.window);
      }

      const match = router.match(req.method, pathname);
      if (!match) throw new ApiError(404, 'Not found.', 'not_found');
      ctx.params = match.params;

      if (!['GET', 'HEAD'].includes(req.method)) {
        assertSameOrigin(req, url);
        if (!match.route.rawBody) ctx.body = await readJsonBody(req);
      }

      let result;
      for (const handler of match.route.handlers) {
        result = await handler(ctx);
      }
      if (result === HANDLED) return;
      sendJson(res, ctx.status, result === undefined ? { ok: true } : result);
      return;
    }

    // Liveness: no dependencies, answers even while the database is down.
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
      return;
    }
    // Readiness: proves the database is reachable before a load balancer
    // sends real traffic to this instance.
    if (pathname === '/ready') {
      try {
        const health = await db.healthCheck();
        sendJson(res, 200, { ok: true, database: health });
      } catch (err) {
        sendJson(res, 503, { ok: false, code: 'not_ready', message: 'Database is not reachable.' });
      }
      return;
    }

    // Static assets (safe-join inside public/)
    const assetPath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
    if (assetPath.startsWith(PUBLIC_DIR + path.sep) && path.extname(assetPath)) {
      const stat = await fsp.stat(assetPath).catch(() => null);
      if (stat && stat.isFile()) {
        serveFile(res, assetPath);
        return;
      }
    }

    const page = resolvePage(pathname);
    if (page && fs.existsSync(page)) {
      serveFile(res, page);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page not found.');
  } catch (err) {
    if (err instanceof ApiError) {
      const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
      // When we stopped reading a request body early (an over-size upload),
      // the rest of it is still in flight. Answer first, then close, so the
      // caller sees the explanation rather than a reset connection.
      if (err.closeConnection) headers.Connection = 'close';
      sendJson(res, err.status, { ok: false, code: err.code, message: err.message }, headers);
      if (err.closeConnection) res.socket && res.socket.end();
      return;
    }
    // Unexpected: log server-side, report to Sentry, and tell the user
    // nothing that could help an attacker.
    console.error(`[error] ${req.method} ${pathname}:`, err);
    sentry.captureException(err, {
      request: { method: req.method, path: pathname },
      user: ctx.user ? { id: ctx.user.id, role: ctx.user.role } : null,
    });
    sendJson(res, 500, {
      ok: false,
      code: 'server_error',
      message: 'Something went wrong on our side. Please try again in a moment.',
    });
  }
}

module.exports = { handle, ready, router, clientIp, parseCookies, assertProductionConfig };
