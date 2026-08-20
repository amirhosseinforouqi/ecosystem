'use strict';

/**
 * Long-running server entry point.
 *
 * The request handling itself lives in server/app.js so the identical code
 * runs on Vercel (api/index.js). This file only owns the process: binding a
 * port, ticking the scheduler and shutting down cleanly.
 */

const http = require('node:http');
const app = require('./app');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  app.handle(req, res).catch((err) => {
    console.error('[fatal] unhandled request error:', err);
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"ok":false,"code":"server_error","message":"Something went wrong on our side."}');
    }
  });
});

// Slowloris protection: a client that opens a socket and never finishes its
// headers must not hold a connection open indefinitely.
// A port that is already taken, or a permission problem, should be one clear
// line — not an unhandled 'error' event and a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[startup] port ${PORT} is already in use. Stop the other process, or set PORT to something else.`);
  } else if (err.code === 'EACCES') {
    console.error(`[startup] not permitted to bind port ${PORT}. Use a port above 1024, or grant the capability.`);
  } else {
    console.error('[startup] could not start the server:', err.message);
  }
  process.exit(1);
});

server.headersTimeout = 20000;
server.requestTimeout = 120000;
server.keepAliveTimeout = 15000;

/**
 * Graceful shutdown (audit finding H10).
 *
 * A SIGTERM mid-upload previously killed the process instantly, which could
 * leave a document written to disk with no database row. Now: stop accepting
 * connections, let in-flight requests finish, stop the scheduler, close the
 * pool — with a hard deadline so a stuck request cannot block the deploy.
 */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — finishing in-flight requests.`);

  const deadline = setTimeout(() => {
    console.error('[shutdown] timed out after 25s — exiting.');
    process.exit(1);
  }, 25000);
  deadline.unref();

  try {
    require('./jobs').stopScheduler();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    console.log('[shutdown] clean.');
    clearTimeout(deadline);
    process.exit(0);
  } catch (err) {
    console.error('[shutdown] error:', err);
    process.exit(1);
  }
}

async function main() {
  try {
    await app.ready();
  } catch (err) {
    console.error('[startup] refusing to start:', err.message);
    process.exit(1);
  }

  // Bind explicitly to all IPv4 interfaces: Node's default (host omitted)
  // binds IPv6-only, which the Codespaces/devcontainer port-forwarding
  // proxy cannot reach — that shows up to users as a 502.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mortgage client platform running at http://localhost:${PORT}`);
    console.log(`  Broker portal:  http://localhost:${PORT}/broker`);
    console.log(`  Client portal:  http://localhost:${PORT}/portal`);
  });

  if (process.env.DISABLE_SCHEDULER !== '1') {
    require('./jobs').startScheduler();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
    require('./sentry').captureException(err instanceof Error ? err : new Error(String(err)), {
      request: { method: 'internal', path: 'unhandledRejection' },
    });
  });
}

if (require.main === module) {
  main();
}

module.exports = { server, app };
