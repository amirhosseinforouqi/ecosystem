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
 *
 * Three layers, kept strictly separate:
 *   1. Document catalog  — document_types, the master list of document kinds
 *   2. Document rules    — document_rules/_items, the global service +
 *                          employment defaults
 *   3. Client checklist  — document_requests for one file, plus
 *                          checklist_exclusions recording per-client removals
 *
 * Editing layer 3 never changes layers 1–2: removing a document from one
 * client's checklist records an exclusion for that file only, so the same
 * service + employment combination still produces the full default list for
 * every other client.
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
 * Evaluate the global rules for an arbitrary service + applicant set.
 * Shared by desiredChecklist (a saved file) and previewChecklist (the Add
 * Client wizard, which needs the defaults before any file exists).
 */
function evaluateRules({ file, typeKey, applicants }) {
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
 * Compute the desired rule-driven checklist for a saved file.
 * Returns entries: { document_type_id, applicant_id|null, requirement, expires_days, rule_id }
 */
function desiredChecklist(fileId) {
  const file = get('SELECT * FROM client_files WHERE id = ?', fileId);
  if (!file) return [];
  const type = file.application_type_id
    ? get('SELECT * FROM application_types WHERE id = ?', file.application_type_id)
    : null;
  const applicants = all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', fileId);
  return evaluateRules({ file, typeKey: type ? type.key : null, applicants });
}

/**
 * Rule defaults for a prospective client — the Add Client wizard calls this
 * after Step 1 (service) and Step 2 (employment status), before any client
 * record exists. Purely read-only: it never writes rules or checklists.
 *
 * Returns catalog-enriched rows the broker can then add to / remove from
 * for this one client without touching the global rules.
 */
function previewChecklist(applicationTypeId, employmentType, { fthb = false } = {}) {
  const type = applicationTypeId
    ? get('SELECT * FROM application_types WHERE id = ?', Number(applicationTypeId))
    : null;
  // A single synthetic applicant stands in for the primary client so
  // per-applicant rules resolve; ids are negative so they can never collide
  // with real applicant ids.
  const pseudoApplicant = { id: -1, employment_type: String(employmentType || '') };
  const entries = evaluateRules({
    file: { fthb: fthb ? 1 : 0 },
    typeKey: type ? type.key : null,
    applicants: [pseudoApplicant],
  });
  return entries
    .map((e) => {
      const docType = get('SELECT * FROM document_types WHERE id = ? AND active = 1', e.document_type_id);
      if (!docType) return null;
      return {
        document_type_id: docType.id,
        document_name: docType.name,
        category: docType.category,
        instructions: docType.description,
        requirement: e.requirement,
        per_applicant: e.applicant_id !== null,
        expires_days: e.expires_days,
      };
    })
    .filter(Boolean);
}

function isExcluded(fileId, documentTypeId, applicantId) {
  return !!get(
    `SELECT id FROM checklist_exclusions
      WHERE file_id = ? AND document_type_id = ?
        AND ((applicant_id IS NULL AND ? IS NULL) OR applicant_id = ?)`,
    fileId, documentTypeId, applicantId ?? null, applicantId ?? null
  );
}

/** Record a client-specific removal so rule re-sync will not re-add it. */
function excludeFromChecklist(fileId, documentTypeId, applicantId, actorId = null) {
  run(
    `INSERT INTO checklist_exclusions (file_id, document_type_id, applicant_id, excluded_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (file_id, document_type_id, applicant_id) DO NOTHING`,
    fileId, documentTypeId, applicantId ?? null, actorId, now()
  );
}

/**
 * Undo a client-specific removal (the next sync restores the item).
 * Pass an applicantId to restore just that applicant's copy; omit it
 * (undefined) to restore the document for the whole file — which is what
 * "restore this document" means to a broker, since a per-applicant rule
 * records one exclusion per applicant.
 */
function unexcludeFromChecklist(fileId, documentTypeId, applicantId) {
  if (applicantId === undefined) {
    run(
      'DELETE FROM checklist_exclusions WHERE file_id = ? AND document_type_id = ?',
      fileId, documentTypeId
    );
    return;
  }
  run(
    `DELETE FROM checklist_exclusions
      WHERE file_id = ? AND document_type_id = ?
        AND ((applicant_id IS NULL AND ? IS NULL) OR applicant_id = ?)`,
    fileId, documentTypeId, applicantId ?? null, applicantId ?? null
  );
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
    // The broker removed this item for this client specifically — honour
    // that instead of re-adding it from the global rule.
    if (isExcluded(fileId, want.document_type_id, want.applicant_id ?? null)) continue;
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

module.exports = {
  desiredChecklist,
  previewChecklist,
  syncChecklist,
  checklistProgress,
  excludeFromChecklist,
  unexcludeFromChecklist,
  isExcluded,
};
