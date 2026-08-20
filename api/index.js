'use strict';

/**
 * Vercel Node.js runtime entry point.
 *
 * Vercel gives every request a standard (req, res) pair, so the application
 * handler is used unchanged. `vercel.json` rewrites every path here, which
 * keeps routing (API, SPA pages, static assets) in one place instead of
 * splitting it between the platform and the app.
 *
 * There is no in-process scheduler in this shape — see the cron entry in
 * vercel.json, which calls /api/cron/jobs.
 */

const app = require('../server/app');

module.exports = (req, res) => app.handle(req, res);
