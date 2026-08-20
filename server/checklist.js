'use strict';

/**
 * Document requirement engine.
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

/** Evaluate the global rules for an arbitrary service + applicant set. */
async function evaluateRules({ file, typeKey, applicants }) {
  const rules = await all('SELECT * FROM document_rules WHERE active = 1');

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
    const items = await all('SELECT * FROM document_rule_items WHERE rule_id = ?', rule.id);
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

/** Compute the desired rule-driven checklist for a saved file. */
async function desiredChecklist(fileId) {
  const file = await get('SELECT * FROM client_files WHERE id = ?', fileId);
  if (!file) return [];
  const type = file.application_type_id
    ? await get('SELECT * FROM application_types WHERE id = ?', file.application_type_id)
    : null;
  const applicants = await all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', fileId);
  return evaluateRules({ file, typeKey: type ? type.key : null, applicants });
}

/**
 * Rule defaults for a prospective client — the Add Client wizard calls this
 * after the service and employment steps, before any client record exists.
 * Purely read-only: it never writes rules or checklists.
 */
async function previewChecklist(applicationTypeId, employmentType, { fthb = false } = {}) {
  const type = applicationTypeId
    ? await get('SELECT * FROM application_types WHERE id = ?', Number(applicationTypeId))
    : null;
  const pseudoApplicant = { id: -1, employment_type: String(employmentType || '') };
  const entries = await evaluateRules({
    file: { fthb: fthb ? 1 : 0 },
    typeKey: type ? type.key : null,
    applicants: [pseudoApplicant],
  });
  const out = [];
  for (const e of entries) {
    const docType = await get('SELECT * FROM document_types WHERE id = ? AND active = 1', e.document_type_id);
    if (!docType) continue;
    out.push({
      document_type_id: docType.id,
      document_name: docType.name,
      category: docType.category,
      instructions: docType.description,
      requirement: e.requirement,
      per_applicant: e.applicant_id !== null,
      expires_days: e.expires_days,
    });
  }
  return out;
}

async function isExcluded(fileId, documentTypeId, applicantId) {
  const row = await get(
    `SELECT id FROM checklist_exclusions
      WHERE file_id = ? AND document_type_id = ?
        AND COALESCE(applicant_id, -1) = COALESCE(?::int, -1)`,
    fileId, documentTypeId, applicantId ?? null
  );
  return !!row;
}

/** Record a client-specific removal so rule re-sync will not re-add it. */
async function excludeFromChecklist(fileId, documentTypeId, applicantId, actorId = null) {
  await run(
    `INSERT INTO checklist_exclusions (file_id, document_type_id, applicant_id, excluded_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (file_id, document_type_id, COALESCE(applicant_id, -1)) DO NOTHING`,
    fileId, documentTypeId, applicantId ?? null, actorId, now()
  );
}

/**
 * Undo a client-specific removal. Pass an applicantId to restore just that
 * applicant's copy; omit it (undefined) to restore for the whole file.
 */
async function unexcludeFromChecklist(fileId, documentTypeId, applicantId) {
  if (applicantId === undefined) {
    await run('DELETE FROM checklist_exclusions WHERE file_id = ? AND document_type_id = ?', fileId, documentTypeId);
    return;
  }
  await run(
    `DELETE FROM checklist_exclusions
      WHERE file_id = ? AND document_type_id = ? AND COALESCE(applicant_id, -1) = COALESCE(?::int, -1)`,
    fileId, documentTypeId, applicantId ?? null
  );
}

/** Bring the file's stored checklist in line with the rules. */
async function syncChecklist(fileId, actorId = null) {
  const desired = await desiredChecklist(fileId);
  const existing = await all('SELECT * FROM document_requests WHERE file_id = ?', fileId);
  const desiredKeys = new Set(desired.map((d) => `${d.document_type_id}:${d.applicant_id ?? 'file'}`));

  let added = 0;
  let removed = 0;

  for (const want of desired) {
    const match = existing.find(
      (r) => r.document_type_id === want.document_type_id &&
             (r.applicant_id ?? null) === (want.applicant_id ?? null)
    );
    if (match) continue;
    if (await isExcluded(fileId, want.document_type_id, want.applicant_id ?? null)) continue;
    await run(
      `INSERT INTO document_requests
         (file_id, applicant_id, document_type_id, status, requirement, source, rule_id, expires_days, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'rule', ?, ?, ?, ?, ?)`,
      fileId, want.applicant_id, want.document_type_id, 'required',
      want.requirement, want.rule_id, want.expires_days, actorId, now(), now()
    );
    added += 1;
  }

  for (const req of existing) {
    if (req.source !== 'rule') continue;
    const key = `${req.document_type_id}:${req.applicant_id ?? 'file'}`;
    if (desiredKeys.has(key)) continue;
    const hasUploads = await get('SELECT id FROM document_versions WHERE request_id = ? LIMIT 1', req.id);
    if (hasUploads) continue;
    await run('DELETE FROM document_requests WHERE id = ?', req.id);
    removed += 1;
  }

  return { added, removed };
}

/** Aggregate checklist state for a file, in a single query. */
async function checklistProgress(fileId) {
  const row = await get(
    `SELECT
       COUNT(*) FILTER (WHERE requirement = 'required')::int AS total_required,
       COUNT(*) FILTER (WHERE requirement = 'required'
                          AND status IN ('required','rejected','replacement_requested','expired'))::int AS outstanding,
       COUNT(*) FILTER (WHERE requirement = 'required' AND status = 'approved')::int AS approved,
       COUNT(*) FILTER (WHERE status IN ('uploaded','under_review'))::int AS awaiting_review
     FROM document_requests
     WHERE file_id = ? AND status <> 'waived'`,
    fileId
  );
  const totalRequired = row ? row.total_required : 0;
  const outstanding = row ? row.outstanding : 0;
  const approved = row ? row.approved : 0;
  return {
    total_required: totalRequired,
    outstanding,
    approved,
    awaiting_review: row ? row.awaiting_review : 0,
    all_submitted: totalRequired > 0 && outstanding === 0,
    complete: totalRequired > 0 && approved === totalRequired,
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
