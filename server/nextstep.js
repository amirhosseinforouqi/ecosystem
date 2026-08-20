'use strict';

/**
 * Derives the guided experience: the client's single clear "next step" and
 * the broker's "what needs my attention" reasons, computed live from the
 * file's real state (never stored, so it can't go stale).
 */

const { get, all } = require('./db');
const { today } = require('./util');

const OUTSTANDING_STATUSES = ['required', 'rejected', 'replacement_requested', 'expired'];

/**
 * Client-facing next step. Scoped to the documents this portal user is
 * actually responsible for (audit finding H3) — a guarantor is not told to
 * upload the primary borrower's pay stub.
 */
async function clientNextStep(file, visibleApplicantIds = null) {
  const params = [file.id, ...OUTSTANDING_STATUSES];
  let applicantFilter = '';
  if (visibleApplicantIds) {
    const ids = [...visibleApplicantIds];
    applicantFilter = ids.length
      ? ` AND (r.applicant_id IS NULL OR r.applicant_id = ANY(?::int[]))`
      : ' AND r.applicant_id IS NULL';
    if (ids.length) params.push(ids);
  }

  const outstanding = await all(
    `SELECT r.id, dt.name AS document_name
       FROM document_requests r JOIN document_types dt ON dt.id = r.document_type_id
      WHERE r.file_id = ? AND r.requirement = 'required'
        AND r.status IN (${OUTSTANDING_STATUSES.map(() => '?').join(',')})${applicantFilter}
      ORDER BY r.updated_at DESC`,
    ...params
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

  const inReview = await get(
    `SELECT COUNT(*)::int AS n FROM document_requests WHERE file_id = ? AND status IN ('uploaded','under_review')`,
    file.id
  );
  if (inReview && inReview.n > 0) {
    return { kind: 'wait', text: 'Your documents are being reviewed. Nothing is needed from you right now.' };
  }
  const stage = file.stage_id ? await get('SELECT * FROM stages WHERE id = ?', file.stage_id) : null;
  if (stage && stage.client_message) {
    return { kind: 'stage', text: stage.client_message };
  }
  return { kind: 'wait', text: 'Your broker will contact you when anything is needed. You are all caught up.' };
}

/**
 * Attention reasons for one file. Used on the file page; the dashboard uses
 * the set-based query in broker.routes instead of calling this per file.
 */
async function fileAttention(file) {
  const reasons = [];

  const counts = await get(
    `SELECT
       (SELECT COUNT(*) FROM document_requests
          WHERE file_id = $1 AND status IN ('uploaded','under_review'))::int AS to_review,
       (SELECT COUNT(*) FROM document_requests
          WHERE file_id = $1 AND requirement = 'required'
            AND status IN ('required','rejected','replacement_requested','expired'))::int AS outstanding,
       (SELECT COUNT(*) FROM messages
          WHERE file_id = $1 AND sender_kind = 'client' AND read_by_staff_at IS NULL)::int AS unread,
       (SELECT MAX(created_at) FROM messages
          WHERE file_id = $1 AND sender_kind = 'client' AND read_by_staff_at IS NULL) AS latest_message,
       (SELECT COUNT(*) FROM tasks
          WHERE file_id = $1 AND status IN ('pending','in_progress')
            AND due_date IS NOT NULL AND due_date < $2)::int AS overdue,
       (SELECT COUNT(*) FROM tasks
          WHERE file_id = $1 AND status IN ('pending','in_progress') AND due_date = $2)::int AS due_today`,
    file.id, today()
  );

  if (counts.to_review > 0) {
    reasons.push({ kind: 'review', text: `${counts.to_review} document${counts.to_review > 1 ? 's' : ''} awaiting review`, weight: 3, count: counts.to_review });
  }
  if (counts.unread > 0) {
    reasons.push({ kind: 'message', text: 'New message from the client', latest: counts.latest_message, weight: 4, count: counts.unread });
  }
  if (counts.outstanding > 0) {
    reasons.push({ kind: 'outstanding', text: `${counts.outstanding} document${counts.outstanding > 1 ? 's' : ''} outstanding from the client`, weight: 1, count: counts.outstanding });
  }
  if (counts.overdue > 0) {
    reasons.push({ kind: 'task_overdue', text: `${counts.overdue} follow-up${counts.overdue > 1 ? 's' : ''} overdue`, weight: 3, count: counts.overdue });
  }
  if (counts.due_today > 0) {
    reasons.push({ kind: 'task_today', text: `${counts.due_today} follow-up${counts.due_today > 1 ? 's' : ''} due today`, weight: 2, count: counts.due_today });
  }
  return reasons;
}

/** Build the same reason list from a pre-aggregated dashboard row. */
function reasonsFromCounts(row) {
  const reasons = [];
  if (row.to_review > 0) reasons.push({ kind: 'review', text: `${row.to_review} document${row.to_review > 1 ? 's' : ''} awaiting review`, weight: 3, count: row.to_review });
  if (row.unread > 0) reasons.push({ kind: 'message', text: 'New message from the client', latest: row.latest_message, weight: 4, count: row.unread });
  if (row.outstanding > 0) reasons.push({ kind: 'outstanding', text: `${row.outstanding} document${row.outstanding > 1 ? 's' : ''} outstanding from the client`, weight: 1, count: row.outstanding });
  if (row.overdue > 0) reasons.push({ kind: 'task_overdue', text: `${row.overdue} follow-up${row.overdue > 1 ? 's' : ''} overdue`, weight: 3, count: row.overdue });
  if (row.due_today > 0) reasons.push({ kind: 'task_today', text: `${row.due_today} follow-up${row.due_today > 1 ? 's' : ''} due today`, weight: 2, count: row.due_today });
  return reasons;
}

module.exports = { clientNextStep, fileAttention, reasonsFromCounts, OUTSTANDING_STATUSES };
