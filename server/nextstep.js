'use strict';

/**
 * Derives the guided experience: the client's single clear "next step" and
 * the broker's "what needs my attention" reasons, computed live from the
 * file's real state (never stored, so it can't go stale).
 */

const { get, all } = require('./db');
const { today } = require('./util');

const OUTSTANDING_STATUSES = ['required', 'rejected', 'replacement_requested', 'expired'];

/** Client-facing next step for a file. */
function clientNextStep(file) {
  const outstanding = all(
    `SELECT r.*, dt.name AS document_name
       FROM document_requests r JOIN document_types dt ON dt.id = r.document_type_id
      WHERE r.file_id = ? AND r.requirement = 'required'
        AND r.status IN (${OUTSTANDING_STATUSES.map(() => '?').join(',')})
      ORDER BY r.updated_at DESC`,
    file.id, ...OUTSTANDING_STATUSES
  );
  if (outstanding.length === 1) {
    return { kind: 'upload', text: `Upload your ${outstanding[0].document_name}.`, request_id: outstanding[0].id };
  }
  if (outstanding.length > 1) {
    return {
      kind: 'upload',
      text: `Upload ${outstanding.length} documents — starting with your ${outstanding[0].document_name}.`,
      request_id: outstanding[0].id,
    };
  }
  const inReview = get(
    `SELECT COUNT(*) AS n FROM document_requests WHERE file_id = ? AND status IN ('uploaded','under_review')`,
    file.id
  );
  if (inReview && inReview.n > 0) {
    return { kind: 'wait', text: 'Your documents are being reviewed. Nothing is needed from you right now.' };
  }
  const stage = file.stage_id ? get('SELECT * FROM stages WHERE id = ?', file.stage_id) : null;
  if (stage && stage.client_message) {
    return { kind: 'stage', text: stage.client_message };
  }
  return { kind: 'wait', text: 'Your broker will contact you when anything is needed. You are all caught up.' };
}

/** Attention reasons for a file, for the broker dashboard. */
function fileAttention(file) {
  const reasons = [];

  const toReview = get(
    `SELECT COUNT(*) AS n FROM document_requests WHERE file_id = ? AND status IN ('uploaded','under_review')`,
    file.id
  ).n;
  if (toReview > 0) {
    reasons.push({ kind: 'review', text: `${toReview} document${toReview > 1 ? 's' : ''} awaiting review`, weight: 3 });
  }

  const unread = get(
    `SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM messages
      WHERE file_id = ? AND sender_kind = 'client' AND read_by_staff_at IS NULL`,
    file.id
  );
  if (unread && unread.n > 0) {
    reasons.push({ kind: 'message', text: `New message from the client`, latest: unread.latest, weight: 4 });
  }

  const outstanding = get(
    `SELECT COUNT(*) AS n FROM document_requests
      WHERE file_id = ? AND requirement = 'required'
        AND status IN (${OUTSTANDING_STATUSES.map(() => '?').join(',')})`,
    file.id, ...OUTSTANDING_STATUSES
  ).n;
  if (outstanding > 0) {
    reasons.push({ kind: 'outstanding', text: `${outstanding} document${outstanding > 1 ? 's' : ''} outstanding from the client`, weight: 1 });
  }

  const overdueTasks = get(
    `SELECT COUNT(*) AS n FROM tasks
      WHERE file_id = ? AND status IN ('pending','in_progress') AND due_date IS NOT NULL AND due_date < ?`,
    file.id, today()
  ).n;
  if (overdueTasks > 0) {
    reasons.push({ kind: 'task_overdue', text: `${overdueTasks} follow-up${overdueTasks > 1 ? 's' : ''} overdue`, weight: 3 });
  }

  const dueToday = get(
    `SELECT COUNT(*) AS n FROM tasks
      WHERE file_id = ? AND status IN ('pending','in_progress') AND due_date = ?`,
    file.id, today()
  ).n;
  if (dueToday > 0) {
    reasons.push({ kind: 'task_today', text: `${dueToday} follow-up${dueToday > 1 ? 's' : ''} due today`, weight: 2 });
  }

  return reasons;
}

module.exports = { clientNextStep, fileAttention, OUTSTANDING_STATUSES };
