'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { seedIfNeeded } = require('./seed');
seedIfNeeded();

const { ApiError } = require('./util');
const { Router, HANDLED, readJsonBody } = require('./router');
const { getSessionUser } = require('./auth');
const { startScheduler } = require('./reminders');

const router = new Router();
require('./routes/auth.routes').register(router);
require('./routes/broker.routes').register(router);
require('./routes/client.routes').register(router);
require('./routes/settings.routes').register(router);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  );
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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
  if (pathname === '/' || pathname === '/login' || pathname === '/activate' || pathname === '/reset') {
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

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  const ctx = {
    req,
    res,
    query: Object.fromEntries(url.searchParams),
    params: {},
    body: null,
    user: null,
    session: null,
    sessionToken: null,
    status: 200,
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '',
    isSecure: req.headers['x-forwarded-proto'] === 'https' || process.env.FORCE_SECURE_COOKIES === '1',
    HANDLED,
  };

  try {
    // Session
    const cookies = parseCookies(req.headers.cookie);
    ctx.sessionToken = cookies.sid || null;
    const auth = getSessionUser(ctx.sessionToken);
    if (auth) {
      ctx.user = auth.user;
      ctx.session = auth.session;
    }

    // API
    if (pathname.startsWith('/api/')) {
      const match = router.match(req.method, pathname);
      if (!match) throw new ApiError(404, 'Not found.', 'not_found');
      ctx.params = match.params;

      if (!['GET', 'HEAD'].includes(req.method)) {
        // CSRF: cross-site form posts can't set custom headers; our frontend always does.
        if (req.headers['x-requested-with'] !== 'fetch') {
          throw new ApiError(403, 'Bad request origin.', 'csrf');
        }
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

    if (pathname === '/health') {
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
      return;
    }

    // Static assets (safe-join inside public/)
    const assetPath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (
      assetPath.startsWith(PUBLIC_DIR + path.sep) &&
      path.extname(assetPath) &&
      fs.existsSync(assetPath) &&
      fs.statSync(assetPath).isFile()
    ) {
      serveFile(res, assetPath);
      return;
    }

    // SPA pages
    const page = resolvePage(pathname);
    if (page && fs.existsSync(page)) {
      serveFile(res, page);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page not found.');
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(res, err.status, { ok: false, code: err.code, message: err.message });
      return;
    }
    console.error(`[error] ${req.method} ${pathname}:`, err);
    sendJson(res, 500, {
      ok: false,
      code: 'server_error',
      message: 'Something went wrong on our side. Please try again in a moment.',
    });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Mortgage client platform running at http://localhost:${PORT}`);
    console.log(`  Broker portal:  http://localhost:${PORT}/broker`);
    console.log(`  Client portal:  http://localhost:${PORT}/portal`);
  });
  startScheduler();
}

module.exports = { server };
