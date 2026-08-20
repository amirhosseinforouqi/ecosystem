'use strict';

/**
 * Background jobs.
 *
 * Two entry points, because the app runs in two shapes:
 *   - long-running server: an in-process scheduler ticks the passes
 *   - serverless (Vercel): a cron request hits /api/cron/jobs, which calls
 *     runAllJobs() once. No in-process timers exist there.
 *
 * Every pass is independent and idempotent: one failing must never stop the
 * others, and running a pass twice must be harmless.
 */

const { all, get, run, getSetting } = require('./db');
const { now, today } = require('./util');
const { sendTemplate } = require('./emails');
const { notifyUser, notifyStaffForFile } = require('./notify');
const { activity } = require('./log');

const REMINDABLE = ['required', 'rejected', 'replacement_requested', 'expired'];

function hoursSince(iso) {
  return (Date.now() - Date.parse(iso)) / 3600000;
}

/** Send a reminder for one outstanding request (manual or automatic). */
async function sendDocumentReminder(request, { manual = false, actor = null } = {}) {
  const cfg = await getSetting('reminders', {});
  if (!manual) {
    if (cfg.enabled === false) return false;
    if (request.reminders_enabled === 0) return false;
    if ((request.reminder_count || 0) >= (cfg.max_reminders ?? 3)) return false;
  }
  const minHours = cfg.min_hours_between ?? 24;
  if (request.last_reminder_at && hoursSince(request.last_reminder_at) < minHours && !manual) return false;

  const file = await get('SELECT * FROM client_files WHERE id = ?', request.file_id);
  if (!file || file.status !== 'active') return false;
  const docType = await get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);

  // Remind the applicant the document belongs to; fall back to every portal
  // user on the file for application-level documents.
  let recipients = [];
  if (request.applicant_id) {
    const applicant = await get('SELECT * FROM applicants WHERE id = ?', request.applicant_id);
    if (applicant && applicant.portal_user_id) {
      const u = await get('SELECT * FROM users WHERE id = ?', applicant.portal_user_id);
      if (u) recipients = [u];
    }
  }
  if (recipients.length === 0) {
    recipients = await all(
      `SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id
        WHERE a.file_id = ? GROUP BY u.id`,
      request.file_id
    );
  }
  if (recipients.length === 0) return false;

  for (const user of recipients) {
    await notifyUser(
      user.id, 'document_reminder', `Reminder: ${docType.name} still needed`,
      request.client_message || '', file.id, '#/documents'
    );
    await sendTemplate('document_reminder', {
      toEmail: user.email,
      toName: `${user.first_name} ${user.last_name}`.trim(),
      userId: user.id,
      fileId: file.id,
      vars: { client_first_name: user.first_name, client_last_name: user.last_name, document_name: docType.name },
    });
  }

  await run(
    'UPDATE document_requests SET last_reminder_at = ?, reminder_count = reminder_count + 1, updated_at = ? WHERE id = ?',
    now(), now(), request.id
  );
  await activity(file.id, actor, 'reminder_sent', `${manual ? 'Reminder' : 'Automatic reminder'} sent for ${docType.name}`);
  return true;
}

async function runReminderPass() {
  const cfg = await getSetting('reminders', {});
  if (cfg.enabled === false) return;
  const cadence = (cfg.cadence_days && cfg.cadence_days.length ? cfg.cadence_days : [2, 5, 7])
    .map(Number).filter((n) => n > 0).sort((a, b) => a - b);

  const outstanding = await all(
    `SELECT r.* FROM document_requests r
       JOIN client_files f ON f.id = r.file_id
      WHERE f.status = 'active' AND r.reminders_enabled = 1 AND r.requirement = 'required'
        AND r.status IN (${REMINDABLE.map(() => '?').join(',')})`,
    ...REMINDABLE
  );

  for (const request of outstanding) {
    const count = request.reminder_count || 0;
    if (count >= (cfg.max_reminders ?? 3) || count >= cadence.length) continue;
    const anchor = request.last_reminder_at || request.updated_at || request.created_at;
    const daysSinceAnchor = (Date.now() - Date.parse(anchor)) / 86400000;
    const waitDays = count === 0 ? cadence[0] : cadence[count] - cadence[count - 1];
    if (daysSinceAnchor >= Math.max(waitDays, 1)) {
      await sendDocumentReminder(request);
    }
  }
}

async function runExpiryPass() {
  const expiring = await all(
    `SELECT r.*, dt.name AS document_name FROM document_requests r
       JOIN document_types dt ON dt.id = r.document_type_id
       JOIN client_files f ON f.id = r.file_id
      WHERE f.status = 'active' AND r.status = 'approved'
        AND r.expires_at IS NOT NULL AND r.expires_at <= ?`,
    now()
  );
  for (const request of expiring) {
    await run("UPDATE document_requests SET status = 'expired', updated_at = ? WHERE id = ?", now(), request.id);
    const file = await get('SELECT * FROM client_files WHERE id = ?', request.file_id);
    await activity(request.file_id, null, 'document_expired', `${request.document_name} has expired and needs a fresh copy`);
    if (file) {
      await notifyStaffForFile(file, 'document_expired', `${request.document_name} expired`, 'A previously approved document has passed its validity window.', '');
    }
  }
}

async function overdueTaskPass() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const tasks = await all(
    `SELECT t.* FROM tasks t
      WHERE t.status IN ('pending','in_progress') AND t.due_date IS NOT NULL AND t.due_date < ?
        AND t.assigned_to IS NOT NULL`,
    today()
  );
  for (const task of tasks) {
    const already = await get(
      `SELECT id FROM notifications WHERE user_id = ? AND kind = 'task_overdue'
        AND link = ? AND created_at > ? LIMIT 1`,
      task.assigned_to, `task:${task.id}`, cutoff
    );
    if (already) continue;
    await notifyUser(task.assigned_to, 'task_overdue', `Overdue: ${task.title}`, `Was due ${task.due_date}`, task.file_id, `task:${task.id}`);
  }
}

/** Malware scanning for uploads awaiting a verdict (audit finding H4). */
async function scanPass() {
  const scan = require('./scan');
  if (!scan.isEnabled()) return;
  const storage = require('./storage');
  const { parseJsonSafe } = require('./util');

  const pending = await all(
    "SELECT * FROM document_versions WHERE scan_status = 'pending' ORDER BY id LIMIT 5"
  );
  for (const version of pending) {
    try {
      const bytes = await storage.readStored(version.stored_name, parseJsonSafe(version.enc_envelope, null));
      const result = await scan.scanBuffer(bytes);
      await run(
        'UPDATE document_versions SET scan_status = ?, scan_result = ? WHERE id = ?',
        result.status, result.signature || result.detail || null, version.id
      );
      if (result.status === 'infected') {
        const request = await get('SELECT * FROM document_requests WHERE id = ?', version.request_id);
        const file = request ? await get('SELECT * FROM client_files WHERE id = ?', request.file_id) : null;
        if (file) {
          await activity(file.id, null, 'document_quarantined', `An uploaded document was quarantined by the malware scanner (${result.signature}).`);
          await notifyStaffForFile(file, 'document_quarantined', 'Document quarantined', `A client upload matched ${result.signature} and is not available for download.`, `#/files/${file.id}/documents`);
        }
      }
    } catch (err) {
      await run("UPDATE document_versions SET scan_status = 'error', scan_result = ? WHERE id = ?", String(err.message).slice(0, 200), version.id);
    }
  }
}

/** Housekeeping: expired sessions, stale rate-limit buckets, old attempts. */
/**
 * Apply the brokerage's retention policy.
 *
 * Files are *archived*, never deleted — that is what the policy note in
 * Settings promises, and deleting a mortgage file automatically would be
 * wrong under most brokerages' record-keeping obligations. Both windows are
 * off (null) until an administrator sets them.
 */
async function retentionPass() {
  const cfg = await getSetting('retention', {});
  const completedDays = Number(cfg.archive_completed_after_days) || null;
  const inactiveDays = Number(cfg.archive_inactive_after_days) || null;
  if (!completedDays && !inactiveDays) return;

  const archive = async (rows, reason) => {
    for (const file of rows) {
      await run("UPDATE client_files SET status = 'archived', updated_at = ? WHERE id = ?", now(), file.id);
      await activity(file.id, null, 'status_changed', `File archived automatically — ${reason}`);
    }
  };

  if (completedDays) {
    const cutoff = new Date(Date.now() - completedDays * 86400000).toISOString();
    // "Completed" means the file reached a terminal stage; the clock runs from
    // when it last saw activity, not from when it was created.
    const rows = await all(
      `SELECT f.id FROM client_files f
         JOIN stages s ON s.id = f.stage_id
        WHERE f.status = 'completed' AND s.is_terminal = 1
          AND COALESCE(f.last_activity_at, f.updated_at) < ?
        LIMIT 200`,
      cutoff
    );
    await archive(rows, `completed and untouched for ${completedDays} days`);
  }

  if (inactiveDays) {
    const cutoff = new Date(Date.now() - inactiveDays * 86400000).toISOString();
    const rows = await all(
      `SELECT id FROM client_files
        WHERE status = 'active' AND COALESCE(last_activity_at, updated_at) < ?
        LIMIT 200`,
      cutoff
    );
    await archive(rows, `no activity for ${inactiveDays} days`);
  }
}

async function maintenancePass() {
  const auth = require('./auth');
  const ratelimit = require('./ratelimit');
  await auth.purgeExpiredSessions();
  await auth.purgeOldLoginAttempts();
  await ratelimit.purgeExpired();
}

const PASSES = [
  ['reminders', runReminderPass],
  ['expiry', runExpiryPass],
  ['overdue-tasks', overdueTaskPass],
  ['scan', scanPass],
  ['ai-review', () => require('./ai-review').processAiReviews()],
  ['onedrive', () => require('./onedrive').processOneDriveSync()],
  ['retention', retentionPass],
  ['maintenance', maintenancePass],
];

/** Run every pass once. Returns a per-pass result for the cron response. */
async function runAllJobs() {
  const results = {};
  for (const [name, pass] of PASSES) {
    const started = Date.now();
    try {
      await pass();
      results[name] = { ok: true, ms: Date.now() - started };
    } catch (err) {
      results[name] = { ok: false, ms: Date.now() - started, error: err.message };
      console.error(`[jobs] ${name} failed:`, err.message);
      require('./sentry').captureException(err, { job: name });
    }
  }
  return results;
}

/** Document-pipeline passes only — run frequently by the in-process scheduler. */
async function runDocumentJobs() {
  for (const [name, pass] of PASSES.filter(([n]) => ['scan', 'ai-review', 'onedrive'].includes(n))) {
    try {
      await pass();
    } catch (err) {
      console.error(`[jobs] ${name} failed:`, err.message);
      require('./sentry').captureException(err, { job: name });
    }
  }
}

// ---------------------------------------------------------------------------
// In-process scheduler (long-running server only)

let slowTimer = null;
let fastTimer = null;
let running = false;

function startScheduler(slowMs = 5 * 60 * 1000, fastMs = 15 * 1000) {
  const slow = async () => {
    try { await runAllJobs(); } catch (err) { console.error('[jobs] pass error:', err.message); }
  };
  const fast = async () => {
    if (running) return; // never overlap a slow external call with the next tick
    running = true;
    try { await runDocumentJobs(); } finally { running = false; }
  };
  slowTimer = setInterval(slow, slowMs);
  fastTimer = setInterval(fast, fastMs);
  if (slowTimer.unref) slowTimer.unref();
  if (fastTimer.unref) fastTimer.unref();
  setTimeout(slow, 5000).unref?.();
}

function stopScheduler() {
  if (slowTimer) clearInterval(slowTimer);
  if (fastTimer) clearInterval(fastTimer);
  slowTimer = null;
  fastTimer = null;
}

module.exports = {
  startScheduler,
  stopScheduler,
  runAllJobs,
  runDocumentJobs,
  sendDocumentReminder,
  runReminderPass,
  runExpiryPass,
  scanPass,
  retentionPass,
  maintenancePass,
};
