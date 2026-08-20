'use strict';

/**
 * Operational endpoints: the scheduled-jobs trigger and a deep health
 * report. Neither is part of the product UI.
 */

const crypto = require('node:crypto');
const { ApiError } = require('../util');
const { requirePermission } = require('../auth');
const db = require('../db');

/** Constant-time comparison that tolerates differing lengths. */
function secretMatches(supplied, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  // Hash first so length differences do not leak through the comparison.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a).digest(),
    crypto.createHash('sha256').update(b).digest()
  );
}

function register(router) {
  /**
   * Run every background pass once.
   *
   * On a long-running server the in-process scheduler does this; on Vercel
   * there are no timers, so vercel.json points a cron at this URL. It is
   * authenticated with a shared secret because it is reachable from the
   * public internet.
   */
  router.post('/api/cron/jobs', async (ctx) => {
    const supplied = ctx.req.headers['x-cron-secret']
      || String(ctx.req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secretMatches(supplied, process.env.CRON_SECRET)) {
      throw new ApiError(404, 'Not found.', 'not_found');
    }
    const results = await require('../jobs').runAllJobs();
    return { ok: true, results };
  });

  // Vercel Cron issues GET requests; same guard, same work.
  router.get('/api/cron/jobs', async (ctx) => {
    const supplied = ctx.req.headers['x-cron-secret']
      || String(ctx.req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secretMatches(supplied, process.env.CRON_SECRET)) {
      throw new ApiError(404, 'Not found.', 'not_found');
    }
    const results = await require('../jobs').runAllJobs();
    return { ok: true, results };
  });

  /** Administrator-facing system status: integrations, storage, integrity. */
  router.get('/api/ops/status', requirePermission('settings.manage'), async () => {
    const storage = require('../storage');
    const { verifyAuditChain } = require('../log');
    const chain = await verifyAuditChain({ limit: 5000 });
    return {
      database: await db.healthCheck(),
      storage: { bytes_used: await storage.usageBytes(), limits: await storage.uploadLimits() },
      integrations: {
        email_transport: require('../emails').transportName(),
        microsoft_graph: require('../msgraph').isConfigured(),
        onedrive: require('../onedrive').isEnabled(),
        ai_review: await require('../ai-review').isEnabled(),
        ai_review_disabled_reason: require('../ai-review').disabledReason(),
        malware_scanning: require('../scan').mode(),
        error_reporting: require('../sentry').isEnabled(),
      },
      audit_chain: chain,
      encryption: {
        active_key: process.env.DOCUMENT_ENCRYPTION_ACTIVE_KEY || null,
        configured: !!process.env.DOCUMENT_ENCRYPTION_KEYS,
      },
      queues: {
        ai_reviews_pending: (await db.get("SELECT COUNT(*)::int AS n FROM ai_reviews WHERE status = 'pending'")).n,
        onedrive_pending: (await db.get("SELECT COUNT(*)::int AS n FROM document_versions WHERE onedrive_status = 'pending'")).n,
        scans_pending: (await db.get("SELECT COUNT(*)::int AS n FROM document_versions WHERE scan_status = 'pending'")).n,
        emails_failed: (await db.get("SELECT COUNT(*)::int AS n FROM email_log WHERE status = 'failed'")).n,
      },
    };
  });
}

module.exports = { register };
