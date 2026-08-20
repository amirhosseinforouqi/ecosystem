'use strict';

const { get, all } = require('./db');
const { fullName, parseJsonSafe } = require('./util');

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    phone: user.phone,
    status: user.status,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    mfa_enrolled: !!user.mfa_enrolled_at,
  };
}

function applicantSummary(a) {
  if (!a) return null;
  return {
    id: a.id,
    file_id: a.file_id,
    role: a.role,
    first_name: a.first_name,
    middle_name: a.middle_name,
    last_name: a.last_name,
    preferred_name: a.preferred_name,
    name: fullName(a),
    email: a.email,
    phone: a.phone,
    dob: a.dob,
    address: a.address,
    preferred_contact: a.preferred_contact,
    employment_type: a.employment_type,
    employer_name: a.employer_name,
    job_title: a.job_title,
    employment_notes: a.employment_notes,
    has_portal_access: !!a.portal_user_id,
    portal_user_id: a.portal_user_id,
    shares_documents: a.shares_documents === 1,
  };
}

/** Friendly, client-facing wording for a document request's state. */
function clientDocStatus(request, currentVersion) {
  switch (request.status) {
    case 'approved':
      return { label: 'Approved', kind: 'done' };
    case 'uploaded':
    case 'under_review':
      return { label: 'Received — being reviewed', kind: 'waiting' };
    case 'rejected':
    case 'replacement_requested':
      return {
        label: 'Needs replacement',
        kind: 'action',
        reason: (currentVersion && currentVersion.review_note_client) || request.client_message || '',
      };
    case 'expired':
      return {
        label: 'Needs an updated copy',
        kind: 'action',
        reason: 'This document has expired. Please upload a recent version.',
      };
    case 'waived':
      return { label: 'Not needed', kind: 'done' };
    default:
      if (request.requirement === 'optional') {
        return { label: 'Optional', kind: 'optional', reason: request.client_message || '' };
      }
      return { label: 'Needed', kind: 'action', reason: request.client_message || '' };
  }
}

/**
 * Serialize a document request.
 *
 * Two strictly separate shapes:
 *  - client shape (default): friendly status, no internal notes, no AI
 *    output, no storage locations, no scan detail.
 *  - broker shape (includeInternal): adds internal notes, version history,
 *    AI review, OneDrive location and scan state.
 *
 * `canDownload` controls only whether the response advertises byte access —
 * the actual bytes are gated server-side in the route (audit finding H6).
 */
async function requestFull(requestId, { includeInternal = false, canDownload = false } = {}) {
  const r = await get(
    `SELECT r.*, dt.name AS document_name, dt.category AS document_category, dt.description AS document_description
       FROM document_requests r JOIN document_types dt ON dt.id = r.document_type_id
      WHERE r.id = ?`,
    requestId
  );
  if (!r) return null;
  const applicant = r.applicant_id ? await get('SELECT * FROM applicants WHERE id = ?', r.applicant_id) : null;
  const versions = await all('SELECT * FROM document_versions WHERE request_id = ? ORDER BY version DESC', requestId);
  const current = versions.find((v) => v.id === r.current_version_id) || versions[0] || null;
  const scan = require('./scan');

  const base = {
    id: r.id,
    file_id: r.file_id,
    document_type_id: r.document_type_id,
    document_name: r.document_name,
    document_category: r.document_category,
    document_description: r.document_description,
    applicant_id: r.applicant_id,
    applicant_name: applicant ? fullName(applicant) : null,
    status: r.status,
    requirement: r.requirement,
    due_date: r.due_date,
    client_message: r.client_message,
    client_comment: r.client_comment,
    expires_at: r.expires_at,
    updated_at: r.updated_at,
    created_at: r.created_at,
    client_status: clientDocStatus(r, current),
    current_version: current
      ? {
          id: current.id,
          version: current.version,
          original_name: current.original_name,
          display_name: current.display_name || current.original_name,
          mime: current.mime,
          size: Number(current.size),
          status: current.status,
          uploaded_at: current.uploaded_at,
          review_note_client: current.review_note_client,
          // Advisory only; the route enforces it.
          available: scan.isServable(current),
          can_download: canDownload && scan.isServable(current),
        }
      : null,
  };

  if (includeInternal) {
    const { reviewForVersion } = require('./ai-review');
    base.internal_note = r.internal_note;
    base.source = r.source;
    base.reminders_enabled = r.reminders_enabled;
    base.reminder_count = r.reminder_count;
    base.last_reminder_at = r.last_reminder_at;
    base.expires_days = r.expires_days;
    base.versions = [];
    for (const v of versions) {
      base.versions.push({
        id: v.id,
        version: v.version,
        original_name: v.original_name,
        display_name: v.display_name || v.original_name,
        mime: v.mime,
        size: Number(v.size),
        status: v.status,
        uploaded_at: v.uploaded_at,
        uploaded_by: v.uploaded_by,
        reviewed_at: v.reviewed_at,
        review_note_client: v.review_note_client,
        review_note_internal: v.review_note_internal,
        scan_status: v.scan_status,
        scan_result: v.scan_result,
        onedrive_status: v.onedrive_status,
        onedrive_path: v.onedrive_path,
        onedrive_item_id: v.onedrive_item_id,
        onedrive_error: v.onedrive_error,
        encrypted: !!v.enc_envelope,
        can_download: canDownload && scan.isServable(v),
        ai_review: await reviewForVersion(v.id),
      });
    }
    base.ai_review = current ? await reviewForVersion(current.id) : null;
  }
  return base;
}

/** All requests on a file, in the broker shape. */
async function fileRequests(fileId, opts) {
  const rows = await all('SELECT id FROM document_requests WHERE file_id = ? ORDER BY id', fileId);
  const out = [];
  for (const row of rows) {
    const full = await requestFull(row.id, opts);
    if (full) out.push(full);
  }
  return out;
}

/**
 * Requests visible to a client portal user on a file, scoped to the
 * applicants whose documents they may see (audit finding H3).
 */
async function clientFileRequests(fileId, visibleApplicantIds) {
  const ids = [...visibleApplicantIds];
  const rows = ids.length
    ? await all(
        `SELECT id FROM document_requests
          WHERE file_id = ? AND (applicant_id IS NULL OR applicant_id = ANY(?::int[]))
          ORDER BY id`,
        fileId, ids
      )
    : await all(
        'SELECT id FROM document_requests WHERE file_id = ? AND applicant_id IS NULL ORDER BY id',
        fileId
      );
  const out = [];
  for (const row of rows) {
    const full = await requestFull(row.id, { includeInternal: false, canDownload: true });
    if (full && full.status !== 'waived') out.push(full);
  }
  return out;
}

function messageRow(m) {
  return {
    id: m.id,
    file_id: m.file_id,
    sender_id: m.sender_id,
    sender_kind: m.sender_kind,
    sender_name: m.sender_name || '',
    body: m.body,
    created_at: m.created_at,
    edited_at: m.edited_at,
    read_by_staff_at: m.read_by_staff_at,
    read_by_client_at: m.read_by_client_at,
  };
}

module.exports = {
  publicUser,
  applicantSummary,
  clientDocStatus,
  requestFull,
  fileRequests,
  clientFileRequests,
  messageRow,
};
