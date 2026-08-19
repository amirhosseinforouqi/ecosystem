'use strict';

/**
 * Background jobs (in-process scheduler):
 *  - automatic document reminders on the brokerage-configured cadence,
 *    stopping as soon as a document is received, with a hard frequency cap
 *  - marking approved documents as expired when their validity window lapses
 *
 * Runs on an interval; each pass is idempotent and cheap.
 */

const { all, get, run, getSetting } = require('./db');
const { now, today, fullName } = require('./util');
const { sendTemplate } = require('./emails');
const { notifyUser, notifyStaffForFile } = require('./notify');
const { activity } = require('./log');

const REMINDABLE = ['required', 'rejected', 'replacement_requested', 'expired'];

function hoursSince(iso) {
  return (Date.now() - Date.parse(iso)) / 3600000;
}

/**
 * Send a reminder for one outstanding request (manual or automatic).
 * Returns true when a reminder went out.
 */
async function sendDocumentReminder(request, { manual = false, actor = null } = {}) {
  const cfg = getSetting('reminders', {});
  if (!manual) {
    if (cfg.enabled === false) return false;
    if (request.reminders_enabled === 0) return false;
    if ((request.reminder_count || 0) >= (cfg.max_reminders ?? 3)) return false;
  }
  const minHours = cfg.min_hours_between ?? 24;
  if (request.last_reminder_at && hoursSince(request.last_reminder_at) < minHours && !manual) return false;

  const file = get('SELECT * FROM client_files WHERE id = ?', request.file_id);
  if (!file || file.status !== 'active') return false;
  const docType = get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);

  // Who to remind: the applicant the document belongs to, else every portal user on the file.
  let recipients = [];
  if (request.applicant_id) {
    const applicant = get('SELECT * FROM applicants WHERE id = ?', request.applicant_id);
    if (applicant && applicant.portal_user_id) {
      const u = get('SELECT * FROM users WHERE id = ?', applicant.portal_user_id);
      if (u) recipients = [u];
    }
  }
  if (recipients.length === 0) {
    recipients = all(
      `SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id
        WHERE a.file_id = ? GROUP BY u.id`,
      request.file_id
    );
  }
  if (recipients.length === 0) return false;

  for (const user of recipients) {
    notifyUser(
      user.id,
      'document_reminder',
      `Reminder: ${docType.name} still needed`,
      request.client_message || '',
      file.id,
      `#/documents`
    );
    await sendTemplate('document_reminder', {
      toEmail: user.email,
      toName: `${user.first_name} ${user.last_name}`.trim(),
      userId: user.id,
      fileId: file.id,
      vars: { client_first_name: user.first_name, client_last_name: user.last_name, document_name: docType.name },
    });
  }

  run(
    'UPDATE document_requests SET last_reminder_at = ?, reminder_count = reminder_count + 1, updated_at = ? WHERE id = ?',
    now(), now(), request.id
  );
  activity(file.id, actor, 'reminder_sent', `${manual ? 'Reminder' : 'Automatic reminder'} sent for ${docType.name}`);
  return true;
}

async function runReminderPass() {
  const cfg = getSetting('reminders', {});
  if (cfg.enabled === false) return;
  const cadence = (cfg.cadence_days && cfg.cadence_days.length ? cfg.cadence_days : [2, 5, 7])
    .map(Number)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  const outstanding = all(
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
    // Days to wait before the next reminder in the cadence (gap between steps).
    const waitDays = count === 0 ? cadence[0] : cadence[count] - cadence[count - 1];
    if (daysSinceAnchor >= Math.max(waitDays, 1)) {
      try {
        await sendDocumentReminder(request);
      } catch (err) {
        console.error('[reminders] failed for request', request.id, err.message);
      }
    }
  }
}

function runExpiryPass() {
  const expiring = all(
    `SELECT r.*, dt.name AS document_name FROM document_requests r
       JOIN document_types dt ON dt.id = r.document_type_id
       JOIN client_files f ON f.id = r.file_id
      WHERE f.status = 'active' AND r.status = 'approved'
        AND r.expires_at IS NOT NULL AND r.expires_at <= ?`,
    now()
  );
  for (const request of expiring) {
    run("UPDATE document_requests SET status = 'expired', updated_at = ? WHERE id = ?", now(), request.id);
    const file = get('SELECT * FROM client_files WHERE id = ?', request.file_id);
    activity(request.file_id, null, 'document_expired', `${request.document_name} has expired and needs a fresh copy`);
    if (file) {
      notifyStaffForFile(file, 'document_expired', `${request.document_name} expired`, 'A previously approved document has passed its validity window.', '');
    }
  }
}

function overdueTaskPass() {
  // Notify assignees once per day about newly overdue tasks.
  const tasks = all(
    `SELECT t.* FROM tasks t
      WHERE t.status IN ('pending','in_progress') AND t.due_date IS NOT NULL AND t.due_date < ?
        AND t.assigned_to IS NOT NULL`,
    today()
  );
  for (const task of tasks) {
    const already = get(
      `SELECT id FROM notifications WHERE user_id = ? AND kind = 'task_overdue'
        AND link = ? AND created_at > datetime('now', '-1 day') LIMIT 1`,
      task.assigned_to, `task:${task.id}`
    );
    if (already) continue;
    notifyUser(task.assigned_to, 'task_overdue', `Overdue: ${task.title}`, `Was due ${task.due_date}`, task.file_id, `task:${task.id}`);
  }
}

let timer = null;

function startScheduler(intervalMs = 5 * 60 * 1000) {
  const tick = async () => {
    try {
      await runReminderPass();
      runExpiryPass();
      overdueTaskPass();
    } catch (err) {
      console.error('[scheduler] pass failed:', err);
    }
  };
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(tick, 5000).unref?.();
}

function stopScheduler() {
  if (timer) clearInterval(timer);
}

module.exports = { startScheduler, stopScheduler, sendDocumentReminder, runReminderPass, runExpiryPass };
