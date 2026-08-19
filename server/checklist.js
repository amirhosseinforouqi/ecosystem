'use strict';

/**
 * Document requirement engine.
 *
 * Brokerage-configured rules (document_rules + document_rule_items) are
 * evaluated against a file and its applicants to produce the document
 * checklist automatically. Rules are combinable: Purchase + Employee + FTHB
 * yields the union of every matching rule's items.
 *
 * Conditions (all present conditions must match — AND across conditions):
 *   application_type_keys: ['purchase', ...]   any-of match on the file's type
 *   fthb: true                                  file is a first-time home buyer file
 *   employment_types: ['employee', ...]         applicant-level; items are created
 *                                               per matching applicant
 *
 * Sync semantics: re-running the engine only ADDS missing items. It never
 * touches broker-created (manual) requests, and it only removes a rule item
 * that no longer applies when nothing was ever uploaded against it.
 */

const { run, get, all } = require('./db');
const { now, parseJsonSafe } = require('./util');

function ruleMatchesFile(conditions, file, typeKey) {
  if (conditions.application_type_keys && conditions.application_type_keys.length > 0) {
    if (!typeKey || !conditions.application_type_keys.includes(typeKey)) return false;
  }
  if (conditions.fthb === true && !file.fthb) return false;
  return true;
}

function applicantMatches(conditions, applicant) {
  if (conditions.employment_types && conditions.employment_types.length > 0) {
    return conditions.employment_types.includes(applicant.employment_type);
  }
  return true;
}

/**
 * Compute the desired rule-driven checklist for a file.
 * Returns entries: { document_type_id, applicant_id|null, requirement, expires_days, rule_id }
 */
function desiredChecklist(fileId) {
  const file = get('SELECT * FROM client_files WHERE id = ?', fileId);
  if (!file) return [];
  const type = file.application_type_id
    ? get('SELECT * FROM application_types WHERE id = ?', file.application_type_id)
    : null;
  const typeKey = type ? type.key : null;
  const applicants = all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', fileId);
  const rules = all('SELECT * FROM document_rules WHERE active = 1');

  // Key: docTypeId:applicantId — dedupe across rules, "required" wins over "optional".
  const desired = new Map();
  const upsert = (docTypeId, applicantId, requirement, expiresDays, ruleId) => {
    const key = `${docTypeId}:${applicantId ?? 'file'}`;
    const existing = desired.get(key);
    if (!existing || (existing.requirement === 'optional' && requirement === 'required')) {
      desired.set(key, {
        document_type_id: docTypeId,
        applicant_id: applicantId,
        requirement,
        expires_days: expiresDays ?? (existing ? existing.expires_days : null),
        rule_id: ruleId,
      });
    }
  };

  for (const rule of rules) {
    const conditions = parseJsonSafe(rule.conditions, {});
    if (!ruleMatchesFile(conditions, file, typeKey)) continue;
    const items = all('SELECT * FROM document_rule_items WHERE rule_id = ?', rule.id);
    const hasApplicantCondition = Array.isArray(conditions.employment_types) && conditions.employment_types.length > 0;

    for (const item of items) {
      if (item.per_applicant || hasApplicantCondition) {
        for (const applicant of applicants) {
          if (!applicantMatches(conditions, applicant)) continue;
          upsert(item.document_type_id, applicant.id, item.requirement, item.expires_days, rule.id);
        }
      } else {
        upsert(item.document_type_id, null, item.requirement, item.expires_days, rule.id);
      }
    }
  }
  return [...desired.values()];
}

/**
 * Bring the file's stored checklist in line with the rules.
 * Returns { added, removed } counts.
 */
function syncChecklist(fileId, actorId = null) {
  const desired = desiredChecklist(fileId);
  const existing = all('SELECT * FROM document_requests WHERE file_id = ?', fileId);
  const desiredKeys = new Set(desired.map((d) => `${d.document_type_id}:${d.applicant_id ?? 'file'}`));

  let added = 0;
  let removed = 0;

  for (const want of desired) {
    const match = existing.find(
      (r) =>
        r.document_type_id === want.document_type_id &&
        (r.applicant_id ?? null) === (want.applicant_id ?? null)
    );
    if (match) continue;
    run(
      `INSERT INTO document_requests
         (file_id, applicant_id, document_type_id, status, requirement, source, rule_id, expires_days, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'rule', ?, ?, ?, ?, ?)`,
      fileId,
      want.applicant_id,
      want.document_type_id,
      'required',
      want.requirement,
      want.rule_id,
      want.expires_days,
      actorId,
      now(),
      now()
    );
    added += 1;
  }

  // Remove rule items that no longer apply, but only if nothing was uploaded.
  for (const req of existing) {
    if (req.source !== 'rule') continue;
    const key = `${req.document_type_id}:${req.applicant_id ?? 'file'}`;
    if (desiredKeys.has(key)) continue;
    const hasUploads = get('SELECT id FROM document_versions WHERE request_id = ? LIMIT 1', req.id);
    if (hasUploads) continue;
    run('DELETE FROM document_requests WHERE id = ?', req.id);
    removed += 1;
  }

  return { added, removed };
}

/** True when every required (non-waived) item on the file is approved or uploaded. */
function checklistProgress(fileId) {
  const rows = all(
    `SELECT status, requirement FROM document_requests WHERE file_id = ? AND status != 'waived'`,
    fileId
  );
  const required = rows.filter((r) => r.requirement === 'required');
  const outstanding = required.filter((r) =>
    ['required', 'rejected', 'replacement_requested', 'expired'].includes(r.status)
  );
  const approved = required.filter((r) => r.status === 'approved');
  const awaitingReview = rows.filter((r) => ['uploaded', 'under_review'].includes(r.status));
  return {
    total_required: required.length,
    outstanding: outstanding.length,
    approved: approved.length,
    awaiting_review: awaitingReview.length,
    all_submitted: required.length > 0 && outstanding.length === 0,
    complete: required.length > 0 && approved.length === required.length,
  };
}

module.exports = { desiredChecklist, syncChecklist, checklistProgress };
