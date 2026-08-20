'use strict';

const {
  run, get, all, insert, tx, getSetting, nextFileNumber, touchFile,
} = require('../db');
const {
  requireStaff, requirePermission, hasPermission,
} = require('../auth');
const {
  ApiError, now, today, addDays, str, num, intOrNull, bool, dateStr, isEmail,
  normalizeEmail, phoneDigits, fullName, parseJsonSafe,
} = require('../util');
const { audit, activity } = require('../log');
const { sendTemplate, portalBaseUrl } = require('../emails');
const { notifyUser, notifyClientsForFile } = require('../notify');
const {
  syncChecklist, checklistProgress, previewChecklist,
  excludeFromChecklist, unexcludeFromChecklist,
} = require('../checklist');
const { clientNextStep, fileAttention, reasonsFromCounts, OUTSTANDING_STATUSES } = require('../nextstep');
const { requestFull, fileRequests, applicantSummary, publicUser, messageRow } = require('../serialize');
const { sendDocumentReminder } = require('../jobs');
const { saveRequestBody, readStored } = require('../storage');
const { HANDLED } = require('../router');
const scan = require('../scan');
const aiReview = require('../ai-review');

// ---------------------------------------------------------------------------
// Helpers

/** Route params are user input: reject non-numeric ids as 404, never 500. */
function idParam(value) {
  const id = intOrNull(value);
  if (id === null || id <= 0) throw new ApiError(404, 'Not found.', 'not_found');
  return id;
}

async function fileOrThrow(id) {
  const file = await get('SELECT * FROM client_files WHERE id = ?', idParam(id));
  if (!file) throw new ApiError(404, 'That client file was not found.', 'not_found');
  return file;
}

/** Does this staff member get the document bytes at all (audit finding H6)? */
function canDownload(ctx) {
  return hasPermission(ctx.user, 'documents.download');
}

/**
 * Summarize a set of client files.
 *
 * Deliberately set-based (audit finding H1): whatever the page size, this
 * issues a fixed number of queries instead of six per file. The list and
 * dashboard endpoints select a *page* of files in SQL and then call this on
 * the page only, so cost no longer grows with the size of the book.
 */
async function summarize(files) {
  if (!files.length) return [];
  const ids = files.map((f) => f.id);

  const applicantRows = await all(
    'SELECT * FROM applicants WHERE file_id = ANY(?::int[]) ORDER BY file_id, id',
    ids
  );
  const applicantsByFile = new Map();
  for (const a of applicantRows) {
    if (!applicantsByFile.has(a.file_id)) applicantsByFile.set(a.file_id, []);
    applicantsByFile.get(a.file_id).push(a);
  }

  const stageIds = [...new Set(files.map((f) => f.stage_id).filter(Boolean))];
  const typeIds = [...new Set(files.map((f) => f.application_type_id).filter(Boolean))];
  const brokerIds = [...new Set(files.map((f) => f.assigned_broker_id).filter(Boolean))];

  const stages = stageIds.length
    ? await all('SELECT * FROM stages WHERE id = ANY(?::int[])', stageIds) : [];
  const types = typeIds.length
    ? await all('SELECT * FROM application_types WHERE id = ANY(?::int[])', typeIds) : [];
  const brokers = brokerIds.length
    ? await all('SELECT id, first_name, last_name FROM users WHERE id = ANY(?::int[])', brokerIds) : [];

  const stageById = new Map(stages.map((s) => [s.id, s]));
  const typeById = new Map(types.map((t) => [t.id, t]));
  const brokerById = new Map(brokers.map((b) => [b.id, b]));

  const aggRows = await all(
    `SELECT f.id,
       (SELECT COUNT(*) FROM document_requests r
          WHERE r.file_id = f.id AND r.status <> 'waived' AND r.requirement = 'required')::int AS total_required,
       (SELECT COUNT(*) FROM document_requests r
          WHERE r.file_id = f.id AND r.requirement = 'required'
            AND r.status IN ('required','rejected','replacement_requested','expired'))::int AS outstanding,
       (SELECT COUNT(*) FROM document_requests r
          WHERE r.file_id = f.id AND r.requirement = 'required' AND r.status = 'approved')::int AS approved,
       (SELECT COUNT(*) FROM document_requests r
          WHERE r.file_id = f.id AND r.status IN ('uploaded','under_review'))::int AS awaiting_review,
       (SELECT COUNT(*) FROM messages m
          WHERE m.file_id = f.id AND m.sender_kind = 'client' AND m.read_by_staff_at IS NULL)::int AS unread_messages
     FROM client_files f WHERE f.id = ANY(?::int[])`,
    ids
  );
  const aggById = new Map(aggRows.map((r) => [r.id, r]));

  return files.map((file) => {
    const applicants = applicantsByFile.get(file.id) || [];
    const primary = applicants.find((a) => a.role === 'primary') || applicants[0] || null;
    const stage = file.stage_id ? stageById.get(file.stage_id) : null;
    const type = file.application_type_id ? typeById.get(file.application_type_id) : null;
    const broker = file.assigned_broker_id ? brokerById.get(file.assigned_broker_id) : null;
    const agg = aggById.get(file.id) || {
      total_required: 0, outstanding: 0, approved: 0, awaiting_review: 0, unread_messages: 0,
    };

    return {
      id: file.id,
      file_number: file.file_number,
      status: file.status,
      client_name: primary ? fullName(primary) : '(no applicant)',
      applicant_names: applicants.map((a) => fullName(a)),
      applicant_count: applicants.length,
      application_type: type ? type.name : null,
      application_type_id: file.application_type_id,
      stage: stage
        ? { id: stage.id, name: stage.name, color: stage.color, client_label: stage.client_label }
        : null,
      assigned_broker: broker
        ? { id: broker.id, name: `${broker.first_name} ${broker.last_name}`.trim() }
        : null,
      purchase_price: file.purchase_price,
      mortgage_amount: file.mortgage_amount,
      property_address: file.property_address,
      closing_date: file.closing_date,
      fthb: !!file.fthb,
      checklist: {
        total_required: agg.total_required,
        outstanding: agg.outstanding,
        approved: agg.approved,
        awaiting_review: agg.awaiting_review,
        all_submitted: agg.total_required > 0 && agg.outstanding === 0,
        complete: agg.total_required > 0 && agg.approved === agg.total_required,
      },
      unread_messages: agg.unread_messages,
      created_at: file.created_at,
      updated_at: file.updated_at,
      last_activity_at: file.last_activity_at,
    };
  });
}

async function fileSummary(file) {
  const [summary] = await summarize([file]);
  return summary;
}

async function findDuplicates({ email, phone, first_name, last_name }) {
  const results = new Map();
  const fileCache = new Map();

  const push = async (applicant, why) => {
    const key = applicant.file_id;
    if (!results.has(key)) {
      let file = fileCache.get(key);
      if (file === undefined) {
        file = await get('SELECT * FROM client_files WHERE id = ?', applicant.file_id);
        fileCache.set(key, file || null);
      }
      if (!file) return;
      results.set(key, {
        file_id: file.id,
        file_number: file.file_number,
        file_status: file.status,
        name: fullName(applicant),
        email: applicant.email,
        phone: applicant.phone,
        reasons: [],
      });
    }
    const entry = results.get(key);
    if (!entry.reasons.includes(why)) entry.reasons.push(why);
  };

  const normEmail = normalizeEmail(email);
  if (normEmail) {
    for (const a of await all('SELECT * FROM applicants WHERE lower(email) = ?', normEmail)) {
      await push(a, 'Same email');
    }
  }
  const digits = phoneDigits(phone);
  if (digits.length >= 7) {
    // Compared in SQL on the digits only, so formatting differences never
    // hide a duplicate and the whole applicant table is not pulled into memory.
    const tail = digits.slice(-10);
    for (const a of await all(
      `SELECT * FROM applicants
        WHERE phone <> ''
          AND regexp_replace(phone, '[^0-9]', '', 'g') <> ''
          AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 7
          AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE ?`,
      `%${tail}`
    )) {
      await push(a, 'Same phone number');
    }
  }
  if (first_name && last_name) {
    for (const a of await all(
      'SELECT * FROM applicants WHERE lower(first_name) = ? AND lower(last_name) = ?',
      String(first_name).toLowerCase().trim(), String(last_name).toLowerCase().trim()
    )) {
      await push(a, 'Same name');
    }
  }
  return [...results.values()];
}

function applicantFields(input) {
  return {
    role: ['primary', 'co_borrower', 'spouse', 'partner', 'guarantor', 'other'].includes(input.role) ? input.role : 'other',
    first_name: str(input.first_name, 100),
    middle_name: str(input.middle_name, 100),
    last_name: str(input.last_name, 100),
    preferred_name: str(input.preferred_name, 100),
    email: normalizeEmail(input.email),
    phone: str(input.phone, 40),
    dob: dateStr(input.dob),
    address: str(input.address, 400),
    preferred_contact: ['email', 'phone', 'text', 'portal'].includes(input.preferred_contact) ? input.preferred_contact : 'email',
    employment_type: ['employee', 'self_employed', 'retired', 'unemployed', 'other', ''].includes(input.employment_type) ? input.employment_type : '',
    employer_name: str(input.employer_name, 200),
    job_title: str(input.job_title, 200),
    employment_notes: str(input.employment_notes, 1000),
  };
}

async function insertApplicant(fileId, fields) {
  return insert(
    `INSERT INTO applicants
       (file_id, role, first_name, middle_name, last_name, preferred_name, email, phone, dob, address,
        preferred_contact, employment_type, employer_name, job_title, employment_notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fileId, fields.role, fields.first_name, fields.middle_name, fields.last_name, fields.preferred_name,
    fields.email, fields.phone, fields.dob, fields.address, fields.preferred_contact,
    fields.employment_type, fields.employer_name, fields.job_title, fields.employment_notes, now(), now()
  );
}

/**
 * Create (or re-issue) a portal account for an applicant and send the
 * welcome email carrying the temporary credentials.
 *
 * The username is the applicant's email address. A fresh temporary password
 * is generated, hashed with scrypt, and stored only as that hash — the
 * plaintext exists in memory long enough to render the email and is returned
 * to the caller solely so the broker can read it back to a client who never
 * received the email. It is redacted from the stored email_log copy.
 */
async function inviteApplicant(applicantId, actor, ctx, { sendEmail = true } = {}) {
  const applicant = await get('SELECT * FROM applicants WHERE id = ?', applicantId);
  if (!applicant) throw new ApiError(404, 'Applicant not found.', 'not_found');
  if (!isEmail(applicant.email)) {
    throw new ApiError(400, 'This applicant needs a valid email address before they can be invited to the portal.', 'no_email');
  }
  let user = await get('SELECT * FROM users WHERE email = ?', applicant.email);
  if (user && user.role !== 'client') {
    throw new ApiError(400, 'That email belongs to a brokerage staff account and cannot be used for a client portal login.', 'email_conflict');
  }

  const { generateTemporaryPassword, hashPassword, destroyAllSessions } = require('../auth');
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  if (!user) {
    const userId = await insert(
      `INSERT INTO users (role, email, first_name, last_name, phone, password_hash, status, must_change_password, created_at, updated_at)
       VALUES ('client', ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      applicant.email, applicant.first_name, applicant.last_name, applicant.phone, passwordHash, now(), now()
    );
    user = await get('SELECT * FROM users WHERE id = ?', userId);
  } else {
    // Re-issuing credentials for an existing portal account: new temporary
    // password, forced change again, and every existing session dropped.
    await run(
      `UPDATE users SET password_hash = ?, status = 'active', must_change_password = 1,
         failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      passwordHash, now(), user.id
    );
    await destroyAllSessions(user.id);
    user = await get('SELECT * FROM users WHERE id = ?', user.id);
  }
  await run('UPDATE applicants SET portal_user_id = ?, updated_at = ? WHERE id = ?', user.id, now(), applicant.id);

  const file = await get('SELECT * FROM client_files WHERE id = ?', applicant.file_id);
  const appType = file && file.application_type_id
    ? await get('SELECT * FROM application_types WHERE id = ?', file.application_type_id)
    : null;
  const link = `${portalBaseUrl()}/login`;

  if (sendEmail) {
    await sendTemplate('welcome', {
      toEmail: user.email,
      toName: fullName(applicant),
      userId: user.id,
      fileId: applicant.file_id,
      vars: {
        client_first_name: applicant.first_name,
        client_last_name: applicant.last_name,
        portal_link: link,
        username: user.email,
        temporary_password: temporaryPassword,
        application_number: file ? file.file_number : '',
        service_type: appType ? appType.name : '',
        closing_date: file && file.closing_date ? file.closing_date : '',
      },
      redact: [temporaryPassword],
    });
    await activity(applicant.file_id, actor, 'email_sent', `Welcome email with portal credentials sent to ${fullName(applicant)}`);
  }
  await audit(actor ? actor.id : null, 'portal_account_created', 'applicant', applicant.id, ctx ? ctx.ip : null, { user_id: user.id });
  return { user, username: user.email, temporary_password: temporaryPassword, portal_link: link };
}

async function staffList() {
  const rows = await all(
    "SELECT * FROM users WHERE role != 'client' AND status != 'disabled' ORDER BY first_name, last_name"
  );
  return rows.map(publicUser);
}

async function changeStage(file, stageId, note, actor, ctx) {
  const stage = await get('SELECT * FROM stages WHERE id = ? AND active = 1', intOrNull(stageId));
  if (!stage) throw new ApiError(400, 'That stage is not available.', 'bad_stage');
  if (file.stage_id === stage.id) return { ok: true, unchanged: true };

  const fromStage = file.stage_id ? await get('SELECT * FROM stages WHERE id = ?', file.stage_id) : null;
  await run('UPDATE client_files SET stage_id = ?, updated_at = ? WHERE id = ?', stage.id, now(), file.id);
  await run(
    'INSERT INTO stage_history (file_id, from_stage_id, to_stage_id, changed_by, note, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
    file.id, file.stage_id, stage.id, actor ? actor.id : null, str(note, 500), now()
  );
  await activity(file.id, actor, 'stage_changed', `Stage changed${fromStage ? ` from "${fromStage.name}"` : ''} to "${stage.name}"`, {}, true);
  await audit(actor ? actor.id : null, 'stage_change', 'client_file', file.id, ctx ? ctx.ip : null, { to: stage.key });

  await notifyClientsForFile(file.id, 'stage_changed', 'Your application has moved forward', stage.client_message || stage.client_label, '#/home');

  if (stage.send_email) {
    const users = await all(
      `SELECT u.* FROM users u
         JOIN applicants a ON a.portal_user_id = u.id WHERE a.file_id = ? GROUP BY u.id`,
      file.id
    );
    for (const u of users) {
      await sendTemplate(stage.email_template_key || 'stage_changed', {
        toEmail: u.email,
        toName: `${u.first_name} ${u.last_name}`.trim(),
        userId: u.id,
        fileId: file.id,
        vars: {
          client_first_name: u.first_name,
          client_last_name: u.last_name,
          application_stage: stage.client_label || stage.name,
          closing_date: file.closing_date || '',
        },
      });
    }
    if (users.length) await activity(file.id, null, 'email_sent', `Stage update email sent (${stage.name})`);
  }

  if (stage.create_task) {
    await run(
      `INSERT INTO tasks (file_id, title, description, due_date, priority, status, assigned_to, source, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'normal', 'pending', ?, 'auto', ?, ?, ?)`,
      file.id,
      stage.task_title || `Review file — ${stage.name}`,
      `Created automatically when the file entered "${stage.name}".`,
      today(),
      file.assigned_broker_id, actor ? actor.id : null, now(), now()
    );
    await activity(file.id, null, 'task_created', `Task created automatically: ${stage.task_title || `Review file — ${stage.name}`}`);
  }
  return { ok: true };
}

/** After an upload: statuses, notifications and (optionally) the auto review task. */
async function afterClientUpload(file, request, docName, uploader) {
  await activity(file.id, uploader, 'document_uploaded', `${docName} uploaded`, {}, true);
  const { notifyStaffForFile } = require('../notify');
  await notifyStaffForFile(file, 'document_uploaded', `${docName} uploaded`, `File ${file.file_number}`, `#/files/${file.id}/documents`);

  const progress = await checklistProgress(file.id);
  const automation = await getSetting('automation', {});
  if (progress.all_submitted && automation.task_on_all_docs_uploaded !== false) {
    const open = await get(
      `SELECT id FROM tasks WHERE file_id = ? AND source = 'auto' AND title = ? AND status IN ('pending','in_progress')`,
      file.id, "Review the client's document package"
    );
    if (!open) {
      await run(
        `INSERT INTO tasks (file_id, title, description, due_date, priority, status, assigned_to, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'high', 'pending', ?, 'auto', ?, ?)`,
        file.id, "Review the client's document package",
        'Every required document has been submitted.', today(), file.assigned_broker_id, now(), now()
      );
      await activity(file.id, null, 'task_created', "Task created automatically: Review the client's document package");
    }
  }
}

// ---------------------------------------------------------------------------

function register(router) {
  // ------------------------------ Dashboard ------------------------------
  router.get('/api/broker/dashboard', requirePermission('clients.view'), async (ctx) => {
    const mine = ctx.query.mine === '1' ? ctx.user.id : null;
    // Scoping is parameterized; `mine` is only ever this session's own id.
    const fileScope = mine ? 'AND f.assigned_broker_id = ?' : '';
    const fileScopeParams = mine ? [mine] : [];
    const taskScope = mine ? 'AND (t.assigned_to = ? OR t.assigned_to IS NULL)' : '';
    const taskScopeParams = mine ? [mine] : [];

    // Every card is a set-based aggregate: the dashboard never loads the
    // client book into memory (audit finding H1).
    const cards = {
      documents_awaiting_review: (await get(
        `SELECT COUNT(*)::int AS n FROM document_requests r
           JOIN client_files f ON f.id = r.file_id
          WHERE f.status = 'active' AND r.status IN ('uploaded','under_review') ${fileScope}`,
        ...fileScopeParams
      )).n,
      documents_outstanding_files: (await get(
        `SELECT COUNT(DISTINCT r.file_id)::int AS n FROM document_requests r
           JOIN client_files f ON f.id = r.file_id
          WHERE f.status = 'active' AND r.requirement = 'required'
            AND r.status IN ('required','rejected','replacement_requested','expired') ${fileScope}`,
        ...fileScopeParams
      )).n,
      unread_messages: (await get(
        `SELECT COUNT(DISTINCT m.file_id)::int AS n FROM messages m
           JOIN client_files f ON f.id = m.file_id
          WHERE f.status = 'active' AND m.sender_kind = 'client' AND m.read_by_staff_at IS NULL ${fileScope}`,
        ...fileScopeParams
      )).n,
      tasks_today: (await get(
        `SELECT COUNT(*)::int AS n FROM tasks t
          WHERE t.status IN ('pending','in_progress') AND t.due_date = ? ${taskScope}`,
        today(), ...taskScopeParams
      )).n,
      tasks_overdue: (await get(
        `SELECT COUNT(*)::int AS n FROM tasks t
          WHERE t.status IN ('pending','in_progress') AND t.due_date < ? ${taskScope}`,
        today(), ...taskScopeParams
      )).n,
      active_clients: (await get(
        `SELECT COUNT(*)::int AS n FROM client_files f WHERE f.status = 'active' ${fileScope}`,
        ...fileScopeParams
      )).n,
    };

    // "Needs attention": scored and ranked in SQL, then only the top rows are
    // hydrated. Previously this loaded every active file and scored in JS.
    const attentionRows = await all(
      `WITH counts AS (
         SELECT f.id AS file_id, f.file_number, f.stage_id,
           (SELECT COUNT(*) FROM document_requests r
              WHERE r.file_id = f.id AND r.status IN ('uploaded','under_review'))::int AS to_review,
           (SELECT COUNT(*) FROM document_requests r
              WHERE r.file_id = f.id AND r.requirement = 'required'
                AND r.status IN ('required','rejected','replacement_requested','expired'))::int AS outstanding,
           (SELECT COUNT(*) FROM messages m
              WHERE m.file_id = f.id AND m.sender_kind = 'client' AND m.read_by_staff_at IS NULL)::int AS unread,
           (SELECT MAX(m.created_at) FROM messages m
              WHERE m.file_id = f.id AND m.sender_kind = 'client' AND m.read_by_staff_at IS NULL) AS latest_message,
           (SELECT COUNT(*) FROM tasks t
              WHERE t.file_id = f.id AND t.status IN ('pending','in_progress')
                AND t.due_date IS NOT NULL AND t.due_date < ?)::int AS overdue,
           (SELECT COUNT(*) FROM tasks t
              WHERE t.file_id = f.id AND t.status IN ('pending','in_progress') AND t.due_date = ?)::int AS due_today
         FROM client_files f
        WHERE f.status = 'active' ${fileScope}
       )
       SELECT *,
              (CASE WHEN to_review > 0 THEN 3 ELSE 0 END)
            + (CASE WHEN unread > 0 THEN 4 ELSE 0 END)
            + (CASE WHEN outstanding > 0 THEN 1 ELSE 0 END)
            + (CASE WHEN overdue > 0 THEN 3 ELSE 0 END)
            + (CASE WHEN due_today > 0 THEN 2 ELSE 0 END) AS score
         FROM counts
        WHERE to_review > 0 OR unread > 0 OR outstanding > 0 OR overdue > 0 OR due_today > 0
        ORDER BY score DESC, file_id
        LIMIT 25`,
      today(), today(), ...fileScopeParams
    );

    const attentionFiles = attentionRows.length
      ? await all('SELECT * FROM client_files WHERE id = ANY(?::int[])', attentionRows.map((r) => r.file_id))
      : [];
    const attentionSummaries = new Map(
      (await summarize(attentionFiles)).map((s) => [s.id, s])
    );
    const attention = attentionRows.map((row) => {
      const summary = attentionSummaries.get(row.file_id);
      return {
        file_id: row.file_id,
        file_number: row.file_number,
        client_name: summary ? summary.client_name : '',
        stage: summary ? summary.stage : null,
        reasons: reasonsFromCounts(row),
        score: row.score,
      };
    });

    const tasks = await all(
      `SELECT t.*, f.file_number FROM tasks t LEFT JOIN client_files f ON f.id = t.file_id
        WHERE t.status IN ('pending','in_progress') AND t.due_date <= ? ${taskScope}
        ORDER BY t.due_date, t.priority = 'high' DESC LIMIT 20`,
      today(), ...taskScopeParams
    );

    const recentFiles = await all(
      `SELECT f.* FROM client_files f WHERE f.status = 'active' ${fileScope}
        ORDER BY COALESCE(f.last_activity_at, f.updated_at) DESC LIMIT 6`,
      ...fileScopeParams
    );

    return { cards, attention, tasks, recent: await summarize(recentFiles) };
  });

  // ------------------------------ Clients ------------------------------
  /**
   * Client list.
   *
   * Every filter, the search and the sort run in SQL, and only one page of
   * rows is ever materialized (audit finding H1). `total` comes from a
   * COUNT over the same predicate, not from the length of a loaded array.
   */
  router.get('/api/broker/clients', requirePermission('clients.view'), async (ctx) => {
    const q = ctx.query;
    const where = [];
    const params = [];

    const status = ['active', 'archived', 'completed', 'cancelled', 'all'].includes(q.status) ? q.status : 'active';
    if (status !== 'all') { where.push('f.status = ?'); params.push(status); }
    if (q.stage_id) { where.push('f.stage_id = ?'); params.push(idParam(q.stage_id)); }
    if (q.type_id) { where.push('f.application_type_id = ?'); params.push(idParam(q.type_id)); }
    if (q.assigned_to) { where.push('f.assigned_broker_id = ?'); params.push(idParam(q.assigned_to)); }
    if (q.closing_before) {
      where.push('f.closing_date IS NOT NULL AND f.closing_date <= ?');
      params.push(dateStr(q.closing_before));
    }

    const query = str(q.q, 100).toLowerCase();
    if (query) {
      const like = `%${query}%`;
      const digits = phoneDigits(query);
      where.push(
        `(lower(f.file_number) LIKE ?
          OR lower(COALESCE(f.property_address, '')) LIKE ?
          OR EXISTS (
               SELECT 1 FROM applicants a WHERE a.file_id = f.id AND (
                 lower(COALESCE(a.first_name,'') || ' ' || COALESCE(a.last_name,'')) LIKE ?
                 OR lower(COALESCE(a.preferred_name,'')) LIKE ?
                 OR lower(COALESCE(a.email,'')) LIKE ?
                 OR (? <> '' AND regexp_replace(COALESCE(a.phone,''), '[^0-9]', '', 'g') LIKE ?)
               )))`
      );
      params.push(like, like, like, like, like, digits, `%${digits}%`);
    }

    if (q.filter === 'outstanding_docs') {
      where.push(`EXISTS (SELECT 1 FROM document_requests r WHERE r.file_id = f.id
                    AND r.requirement = 'required'
                    AND r.status IN ('required','rejected','replacement_requested','expired'))`);
    }
    if (q.filter === 'awaiting_review') {
      where.push(`EXISTS (SELECT 1 FROM document_requests r WHERE r.file_id = f.id
                    AND r.status IN ('uploaded','under_review'))`);
    }
    if (q.filter === 'unread_messages') {
      where.push(`EXISTS (SELECT 1 FROM messages m WHERE m.file_id = f.id
                    AND m.sender_kind = 'client' AND m.read_by_staff_at IS NULL)`);
    }
    if (q.filter === 'closing_month') {
      where.push('f.closing_date IS NOT NULL AND f.closing_date <= ?');
      params.push(addDays(now(), 31).slice(0, 10));
    }
    if (q.filter === 'stale') {
      where.push('COALESCE(f.last_activity_at, f.updated_at) < ?');
      params.push(addDays(now(), -7));
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (await get(
      `SELECT COUNT(*)::int AS n FROM client_files f ${whereSql}`, ...params
    )).n;

    const perPage = 25;
    const page = Math.min(Math.max(1, Number(q.page) || 1), Math.max(1, Math.ceil(total / perPage)));
    const files = await all(
      `SELECT f.* FROM client_files f ${whereSql}
        ORDER BY COALESCE(f.last_activity_at, f.updated_at) DESC, f.id DESC
        LIMIT ? OFFSET ?`,
      ...params, perPage, (page - 1) * perPage
    );

    return { total, page, per_page: perPage, clients: await summarize(files) };
  });

  router.post('/api/broker/clients', requirePermission('clients.create'), async (ctx) => {
    const body = ctx.body || {};
    const client = applicantFields(body.client || {});
    if (!client.first_name || !client.last_name) {
      throw new ApiError(400, 'The client needs at least a first and last name.', 'missing_field');
    }
    if (client.email && !isEmail(client.email)) {
      throw new ApiError(400, 'That email address does not look valid.', 'bad_email');
    }
    const app = body.application || {};
    const typeId = intOrNull(app.application_type_id);
    if (typeId && !(await get('SELECT id FROM application_types WHERE id = ? AND active = 1', typeId))) {
      throw new ApiError(400, 'That application type is not available.', 'bad_type');
    }

    if (!body.ignore_duplicates) {
      const duplicates = await findDuplicates(client);
      if (duplicates.length) {
        ctx.status = 409;
        return { ok: false, code: 'possible_duplicate', message: 'Possible existing client found.', duplicates };
      }
    }

    const firstStage = await get('SELECT * FROM stages WHERE active = 1 ORDER BY sort LIMIT 1');
    const created = await tx(async () => {
      const fileNumber = await nextFileNumber();
      const fileId = await insert(
        `INSERT INTO client_files
           (file_number, application_type_id, stage_id, assigned_broker_id, purchase_price, down_payment,
            mortgage_amount, property_address, property_type, closing_date, fthb, purpose, extra_info,
            status, created_by, created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        fileNumber, typeId, firstStage ? firstStage.id : null,
        intOrNull(app.assigned_broker_id) || ctx.user.id,
        num(app.purchase_price), num(app.down_payment), num(app.mortgage_amount),
        str(app.property_address, 400), str(app.property_type, 100), dateStr(app.closing_date),
        bool(app.fthb), str(app.purpose, 1000), str(app.extra_info, 2000),
        ctx.user.id, now(), now(), now()
      );
      const primaryId = await insertApplicant(fileId, { ...client, role: 'primary' });
      const coIds = [];
      for (const co of Array.isArray(body.co_applicants) ? body.co_applicants : []) {
        const fields = applicantFields(co);
        if (!fields.first_name || !fields.last_name) continue;
        if (fields.role === 'primary') fields.role = 'co_borrower';
        coIds.push({ id: await insertApplicant(fileId, fields), invite: !!co.invite });
      }
      return { fileId, primaryId, coIds, fileNumber };
    });

    // The wizard sends the checklist the broker actually approved. Anything
    // the rules would have added but the broker removed is excluded for THIS
    // file only; anything they added beyond the rules is created as a manual
    // item. Global rules are never touched.
    const customChecklist = Array.isArray(body.checklist) ? body.checklist : null;
    if (customChecklist) {
      const keptTypeIds = new Set(
        customChecklist.map((c) => intOrNull(c.document_type_id)).filter(Boolean)
      );
      const wanted = await previewChecklist(typeId, client.employment_type, { fthb: bool(app.fthb) });
      for (const want of wanted) {
        if (!keptTypeIds.has(want.document_type_id)) {
          await excludeFromChecklist(created.fileId, want.document_type_id, null, ctx.user.id);
          await excludeFromChecklist(created.fileId, want.document_type_id, created.primaryId, ctx.user.id);
        }
      }
    }

    await syncChecklist(created.fileId, ctx.user.id);

    // Apply per-item customizations and add anything the rules did not cover.
    if (customChecklist) {
      for (const item of customChecklist.slice(0, 100)) {
        const docTypeId = intOrNull(item.document_type_id);
        if (!docTypeId) continue;
        const docType = await get('SELECT * FROM document_types WHERE id = ?', docTypeId);
        if (!docType) continue;
        const requirement = item.requirement === 'optional' ? 'optional' : 'required';
        const message = item.instructions !== undefined ? str(item.instructions, 1000) : docType.description;
        const existing = await get(
          'SELECT * FROM document_requests WHERE file_id = ? AND document_type_id = ? ORDER BY id LIMIT 1',
          created.fileId, docTypeId
        );
        if (existing) {
          await run(
            'UPDATE document_requests SET requirement = ?, client_message = ?, due_date = ?, updated_at = ? WHERE id = ?',
            requirement, message, dateStr(item.due_date), now(), existing.id
          );
        } else {
          await run(
            `INSERT INTO document_requests
               (file_id, applicant_id, document_type_id, status, requirement, source, due_date, client_message, expires_days, created_by, created_at, updated_at)
             VALUES (?, NULL, ?, 'required', ?, 'manual', ?, ?, ?, ?, ?, ?)`,
            created.fileId, docTypeId, requirement, dateStr(item.due_date), message,
            docType.default_expires_days ?? null, ctx.user.id, now(), now()
          );
        }
      }
    }

    await activity(created.fileId, ctx.user, 'client_created', `Client file created (${created.fileNumber})`);
    const finalCount = (await get(
      'SELECT COUNT(*)::int AS n FROM document_requests WHERE file_id = ?', created.fileId
    )).n;
    if (finalCount) {
      await activity(created.fileId, ctx.user, 'checklist_created', `Document checklist created (${finalCount} item${finalCount > 1 ? 's' : ''})`);
    }
    await audit(ctx.user.id, 'client_created', 'client_file', created.fileId, ctx.ip);

    // Create the client's OneDrive folder tree in the background.
    await require('../onedrive').queueFolderCreation(created.fileId);

    // Portal account + welcome email with temporary credentials. Automatic —
    // the broker never has to send this by hand — but the brokerage can turn
    // auto-send off in Settings → Notifications.
    const autoSend = (await getSetting('notifications', {})).auto_send_welcome !== false;
    const wantWelcome = body.send_welcome !== false && autoSend;
    const invites = [];
    if (client.email) {
      try {
        const inv = await inviteApplicant(created.primaryId, ctx.user, ctx, { sendEmail: wantWelcome });
        invites.push({
          applicant_id: created.primaryId,
          email: client.email,
          username: inv.username,
          temporary_password: inv.temporary_password,
          portal_link: inv.portal_link,
          emailed: wantWelcome,
        });
      } catch (err) {
        invites.push({ applicant_id: created.primaryId, error: err.message });
      }
    }
    for (const co of created.coIds) {
      if (!co.invite) continue;
      try {
        const inv = await inviteApplicant(co.id, ctx.user, ctx, { sendEmail: wantWelcome });
        invites.push({
          applicant_id: co.id,
          username: inv.username,
          temporary_password: inv.temporary_password,
          portal_link: inv.portal_link,
          emailed: wantWelcome,
        });
      } catch (err) {
        invites.push({ applicant_id: co.id, error: err.message });
      }
    }

    return { ok: true, file: await fileSummary(await fileOrThrow(created.fileId)), invites };
  });

  // ------------------------------ File detail ------------------------------
  router.get('/api/broker/files/:id', requirePermission('clients.view'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const applicantRows = await all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', file.id);
    const type = file.application_type_id
      ? await get('SELECT * FROM application_types WHERE id = ?', file.application_type_id)
      : null;
    return {
      file: {
        ...(await fileSummary(file)),
        down_payment: file.down_payment,
        property_type: file.property_type,
        purpose: file.purpose,
        extra_info: file.extra_info,
        application_type: type ? type.name : null,
        ai_consent: file.ai_consent === 1,
        ai_consent_at: file.ai_consent_at,
        onedrive_status: file.onedrive_status,
        onedrive_folder_path: file.onedrive_folder_path,
      },
      applicants: applicantRows.map(applicantSummary),
      next_step: await clientNextStep(file),
      attention: await fileAttention(file),
      stage_history: await all(
        `SELECT h.*, s1.name AS from_name, s2.name AS to_name,
                u.first_name || ' ' || u.last_name AS changed_by_name
           FROM stage_history h
           LEFT JOIN stages s1 ON s1.id = h.from_stage_id
           LEFT JOIN stages s2 ON s2.id = h.to_stage_id
           LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.file_id = ? ORDER BY h.changed_at DESC LIMIT 50`,
        file.id
      ),
    };
  });

  router.patch('/api/broker/files/:id', requirePermission('clients.edit'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const b = ctx.body || {};
    const typeId = b.application_type_id !== undefined ? intOrNull(b.application_type_id) : file.application_type_id;
    if (typeId && !(await get('SELECT id FROM application_types WHERE id = ?', typeId))) {
      throw new ApiError(400, 'That application type is not available.', 'bad_type');
    }
    await run(
      `UPDATE client_files SET application_type_id = ?, purchase_price = ?, down_payment = ?, mortgage_amount = ?,
         property_address = ?, property_type = ?, closing_date = ?, fthb = ?, purpose = ?, extra_info = ?, updated_at = ?
       WHERE id = ?`,
      typeId,
      b.purchase_price !== undefined ? num(b.purchase_price) : file.purchase_price,
      b.down_payment !== undefined ? num(b.down_payment) : file.down_payment,
      b.mortgage_amount !== undefined ? num(b.mortgage_amount) : file.mortgage_amount,
      b.property_address !== undefined ? str(b.property_address, 400) : file.property_address,
      b.property_type !== undefined ? str(b.property_type, 100) : file.property_type,
      b.closing_date !== undefined ? dateStr(b.closing_date) : file.closing_date,
      b.fthb !== undefined ? bool(b.fthb) : file.fthb,
      b.purpose !== undefined ? str(b.purpose, 1000) : file.purpose,
      b.extra_info !== undefined ? str(b.extra_info, 2000) : file.extra_info,
      now(), file.id
    );
    const sync = await syncChecklist(file.id, ctx.user.id);
    await activity(file.id, ctx.user, 'file_updated', 'Application details updated');
    await audit(ctx.user.id, 'client_updated', 'client_file', file.id, ctx.ip);
    if (sync.added || sync.removed) {
      await activity(file.id, ctx.user, 'checklist_updated', `Document checklist updated (${sync.added} added, ${sync.removed} removed)`);
    }
    return { ok: true, checklist_sync: sync };
  });

  router.post('/api/broker/files/:id/stage', requirePermission('stage.change'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    return changeStage(file, ctx.body && ctx.body.stage_id, ctx.body && ctx.body.note, ctx.user, ctx);
  });

  router.post('/api/broker/files/:id/status', requirePermission('clients.archive'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const status = ctx.body && ctx.body.status;
    if (!['active', 'archived', 'completed', 'cancelled'].includes(status)) {
      throw new ApiError(400, 'That status is not available.', 'bad_status');
    }
    await run('UPDATE client_files SET status = ?, updated_at = ? WHERE id = ?', status, now(), file.id);
    await activity(file.id, ctx.user, 'status_changed', `File marked as ${status}`);
    await audit(ctx.user.id, 'file_status_change', 'client_file', file.id, ctx.ip, { status });
    return { ok: true };
  });

  router.post('/api/broker/files/:id/assign', requirePermission('clients.edit'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const brokerId = intOrNull(ctx.body && ctx.body.broker_id);
    if (brokerId) {
      const broker = await get("SELECT * FROM users WHERE id = ? AND role != 'client' AND status = 'active'", brokerId);
      if (!broker) throw new ApiError(400, 'That team member was not found.', 'bad_user');
    }
    await run('UPDATE client_files SET assigned_broker_id = ?, updated_at = ? WHERE id = ?', brokerId, now(), file.id);
    await activity(file.id, ctx.user, 'assigned', brokerId ? 'File assigned to a team member' : 'File unassigned');
    if (brokerId && brokerId !== ctx.user.id) {
      await notifyUser(brokerId, 'file_assigned', 'A file was assigned to you', `File ${file.file_number}`, file.id, `#/files/${file.id}`);
    }
    return { ok: true };
  });

  // ------------------------------ Applicants ------------------------------
  router.post('/api/broker/files/:id/applicants', requirePermission('clients.edit'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const fields = applicantFields(ctx.body || {});
    if (!fields.first_name || !fields.last_name) {
      throw new ApiError(400, 'The applicant needs at least a first and last name.', 'missing_field');
    }
    if (fields.role === 'primary' && await get("SELECT id FROM applicants WHERE file_id = ? AND role = 'primary'", file.id)) {
      fields.role = 'co_borrower';
    }
    const id = await insertApplicant(file.id, fields);
    const sync = await syncChecklist(file.id, ctx.user.id);
    await activity(file.id, ctx.user, 'applicant_added', `${fields.first_name} ${fields.last_name} added to the file (${fields.role.replace('_', '-')})`);
    let invite = null;
    if (ctx.body && ctx.body.invite) {
      try {
        const inv = await inviteApplicant(id, ctx.user, ctx);
        invite = { username: inv.username, temporary_password: inv.temporary_password, portal_link: inv.portal_link };
      } catch (err) { invite = { error: err.message }; }
    }
    return { ok: true, applicant_id: id, checklist_sync: sync, invite };
  });

  router.patch('/api/broker/applicants/:id', requirePermission('clients.edit'), async (ctx) => {
    const applicant = await get('SELECT * FROM applicants WHERE id = ?', idParam(ctx.params.id));
    if (!applicant) throw new ApiError(404, 'Applicant not found.', 'not_found');
    const merged = applicantFields({ ...applicant, ...(ctx.body || {}) });
    if (applicant.role === 'primary') merged.role = 'primary';
    // Whether a co-applicant's documents are visible to the other portal
    // users on the file is a deliberate broker decision (audit finding H3),
    // defaulting to private.
    const shares = ctx.body && ctx.body.shares_documents !== undefined
      ? bool(ctx.body.shares_documents)
      : applicant.shares_documents;
    await run(
      `UPDATE applicants SET role = ?, first_name = ?, middle_name = ?, last_name = ?, preferred_name = ?,
         email = ?, phone = ?, dob = ?, address = ?, preferred_contact = ?, employment_type = ?,
         employer_name = ?, job_title = ?, employment_notes = ?, shares_documents = ?, updated_at = ?
       WHERE id = ?`,
      merged.role, merged.first_name, merged.middle_name, merged.last_name, merged.preferred_name,
      merged.email, merged.phone, merged.dob, merged.address, merged.preferred_contact,
      merged.employment_type, merged.employer_name, merged.job_title, merged.employment_notes,
      shares, now(), applicant.id
    );
    const sync = await syncChecklist(applicant.file_id, ctx.user.id);
    await activity(applicant.file_id, ctx.user, 'applicant_updated', `${merged.first_name} ${merged.last_name}'s details updated`);
    if (shares !== applicant.shares_documents) {
      await audit(ctx.user.id, 'applicant_sharing_changed', 'applicant', applicant.id, ctx.ip, { shares_documents: shares });
    }
    await audit(ctx.user.id, 'applicant_updated', 'applicant', applicant.id, ctx.ip);
    return { ok: true, checklist_sync: sync };
  });

  router.delete('/api/broker/applicants/:id', requirePermission('clients.edit'), async (ctx) => {
    const applicant = await get('SELECT * FROM applicants WHERE id = ?', idParam(ctx.params.id));
    if (!applicant) throw new ApiError(404, 'Applicant not found.', 'not_found');
    if (applicant.role === 'primary') {
      throw new ApiError(400, 'The primary applicant cannot be removed from the file.', 'primary_locked');
    }
    const uploads = await get(
      `SELECT v.id FROM document_versions v JOIN document_requests r ON r.id = v.request_id
        WHERE r.applicant_id = ? LIMIT 1`,
      applicant.id
    );
    if (uploads) {
      throw new ApiError(400, 'This applicant has uploaded documents on file, so they cannot be removed. Archive the file instead if it is no longer proceeding.', 'has_documents');
    }
    await run('DELETE FROM document_requests WHERE applicant_id = ?', applicant.id);
    await run('DELETE FROM applicants WHERE id = ?', applicant.id);
    await syncChecklist(applicant.file_id, ctx.user.id);
    await activity(applicant.file_id, ctx.user, 'applicant_removed', `${fullName(applicant)} removed from the file`);
    await audit(ctx.user.id, 'applicant_removed', 'applicant', applicant.id, ctx.ip);
    return { ok: true };
  });

  router.post('/api/broker/applicants/:id/invite', requirePermission('clients.edit'), async (ctx) => {
    const applicant = await get('SELECT * FROM applicants WHERE id = ?', idParam(ctx.params.id));
    if (!applicant) throw new ApiError(404, 'Applicant not found.', 'not_found');
    const result = await inviteApplicant(applicant.id, ctx.user, ctx);
    return {
      ok: true,
      username: result.username,
      temporary_password: result.temporary_password,
      portal_link: result.portal_link,
    };
  });

  // ------------------------------ Documents ------------------------------
  router.get('/api/broker/files/:id/documents', requirePermission('documents.view'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const dl = await canDownload(ctx);
    return {
      requests: await fileRequests(file.id, { includeInternal: true, canDownload: dl }),
      progress: await checklistProgress(file.id),
      can_download: dl,
    };
  });

  /**
   * Record (or withdraw) this client's consent to automated document review.
   *
   * Audit finding C6: the AI feature has three independent gates — the
   * server switch, the brokerage setting, and this per-file consent. Nothing
   * is sent to Anthropic unless all three are on, and withdrawing consent
   * here stops future reviews immediately.
   */
  router.post('/api/broker/files/:id/ai-consent', requirePermission('clients.edit'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const consent = bool(ctx.body && ctx.body.consent);
    const source = str(ctx.body && ctx.body.source, 200) || 'Recorded by brokerage staff';
    await run(
      'UPDATE client_files SET ai_consent = ?, ai_consent_at = ?, ai_consent_source = ?, updated_at = ? WHERE id = ?',
      consent, consent ? now() : null, consent ? source : null, now(), file.id
    );
    await activity(
      file.id, ctx.user, 'ai_consent_changed',
      consent
        ? 'Client consent recorded for automated document review'
        : 'Client consent for automated document review withdrawn'
    );
    await audit(ctx.user.id, 'ai_consent_changed', 'client_file', file.id, ctx.ip, { consent });
    return { ok: true, ai_consent: consent === 1 };
  });

  router.post('/api/broker/files/:id/requests', requirePermission('documents.request'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const b = ctx.body || {};
    const docType = await get('SELECT * FROM document_types WHERE id = ?', intOrNull(b.document_type_id));
    if (!docType) throw new ApiError(400, 'Please choose a document type.', 'bad_type');
    const applicantId = intOrNull(b.applicant_id);
    if (applicantId && !(await get('SELECT id FROM applicants WHERE id = ? AND file_id = ?', applicantId, file.id))) {
      throw new ApiError(400, 'That applicant is not on this file.', 'bad_applicant');
    }
    const requestId = await insert(
      `INSERT INTO document_requests
         (file_id, applicant_id, document_type_id, status, requirement, source, due_date, client_message, internal_note,
          expires_days, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'required', ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
      file.id, applicantId, docType.id,
      b.requirement === 'optional' ? 'optional' : 'required',
      dateStr(b.due_date), str(b.client_message, 1000), str(b.internal_note, 1000),
      intOrNull(b.expires_days), ctx.user.id, now(), now()
    );
    await activity(file.id, ctx.user, 'document_requested', `${docType.name} requested`, {}, true);
    await audit(ctx.user.id, 'document_requested', 'document_request', requestId, ctx.ip);

    await notifyClientsForFile(file.id, 'document_requested', `New document requested: ${docType.name}`, str(b.client_message, 300), '#/documents');
    if (b.send_email !== false) {
      const users = applicantId
        ? await all(
            `SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id
              WHERE a.file_id = ? AND a.id = ? GROUP BY u.id`,
            file.id, applicantId
          )
        : await all(
            `SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id
              WHERE a.file_id = ? GROUP BY u.id`,
            file.id
          );
      for (const u of users) {
        await sendTemplate('document_requested', {
          toEmail: u.email, toName: `${u.first_name} ${u.last_name}`.trim(), userId: u.id, fileId: file.id,
          vars: { client_first_name: u.first_name, client_last_name: u.last_name, document_name: docType.name },
        });
      }
      if (users.length) await activity(file.id, null, 'email_sent', `Document request email sent (${docType.name})`);
    }
    return { ok: true, request: await requestFull(requestId, { includeInternal: true, canDownload: await canDownload(ctx) }) };
  });

  router.patch('/api/broker/requests/:id', requirePermission('documents.request'), async (ctx) => {
    const request = await get('SELECT * FROM document_requests WHERE id = ?', idParam(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    const b = ctx.body || {};
    let docTypeId = request.document_type_id;
    if (b.document_type_id !== undefined) {
      const t = await get('SELECT id FROM document_types WHERE id = ?', intOrNull(b.document_type_id));
      if (!t) throw new ApiError(400, 'That document type is not available.', 'bad_type');
      docTypeId = t.id;
    }
    let applicantId = request.applicant_id;
    if (b.applicant_id !== undefined) {
      applicantId = intOrNull(b.applicant_id);
      if (applicantId && !(await get('SELECT id FROM applicants WHERE id = ? AND file_id = ?', applicantId, request.file_id))) {
        throw new ApiError(400, 'That applicant is not on this file.', 'bad_applicant');
      }
    }
    await run(
      `UPDATE document_requests SET document_type_id = ?, applicant_id = ?, due_date = ?, client_message = ?,
         internal_note = ?, requirement = ?, reminders_enabled = ?, expires_days = ?, updated_at = ?
       WHERE id = ?`,
      docTypeId, applicantId,
      b.due_date !== undefined ? dateStr(b.due_date) : request.due_date,
      b.client_message !== undefined ? str(b.client_message, 1000) : request.client_message,
      b.internal_note !== undefined ? str(b.internal_note, 1000) : request.internal_note,
      b.requirement === 'optional' ? 'optional' : b.requirement === 'required' ? 'required' : request.requirement,
      b.reminders_enabled !== undefined ? bool(b.reminders_enabled) : request.reminders_enabled,
      b.expires_days !== undefined ? intOrNull(b.expires_days) : request.expires_days,
      now(), request.id
    );
    if (docTypeId !== request.document_type_id || applicantId !== request.applicant_id) {
      const docType = await get('SELECT * FROM document_types WHERE id = ?', docTypeId);
      await activity(request.file_id, ctx.user, 'document_classified', `A document was reclassified as ${docType.name}`);
      await audit(ctx.user.id, 'document_classified', 'document_request', request.id, ctx.ip);
    }
    return { ok: true, request: await requestFull(request.id, { includeInternal: true, canDownload: await canDownload(ctx) }) };
  });

  router.delete('/api/broker/requests/:id', requirePermission('documents.request'), async (ctx) => {
    const request = await get('SELECT * FROM document_requests WHERE id = ?', idParam(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    // Removing a rule-generated item is a decision about THIS client only:
    // record an exclusion so re-syncing the global rules never re-adds it,
    // while every other client keeps the same default.
    if (request.source === 'rule') {
      await excludeFromChecklist(request.file_id, request.document_type_id, request.applicant_id ?? null, ctx.user.id);
    }
    const hasUploads = await get('SELECT id FROM document_versions WHERE request_id = ? LIMIT 1', request.id);
    if (hasUploads) {
      // History is never silently destroyed — waive instead of delete.
      await run("UPDATE document_requests SET status = 'waived', updated_at = ? WHERE id = ?", now(), request.id);
      await activity(request.file_id, ctx.user, 'document_waived', 'A document request was marked as no longer needed');
      return { ok: true, waived: true };
    }
    await run('DELETE FROM document_requests WHERE id = ?', request.id);
    await activity(request.file_id, ctx.user, 'document_request_removed', 'A document request was removed for this client');
    return { ok: true };
  });

  /**
   * Wizard step 3: default checklist for a service + employment status,
   * computed from the global rules. Read-only — nothing is written, and no
   * client record needs to exist yet.
   */
  router.get('/api/broker/checklist-preview', requirePermission('clients.create'), async (ctx) => {
    const documents = await previewChecklist(
      intOrNull(ctx.query.application_type_id),
      str(ctx.query.employment_type, 50),
      { fthb: ctx.query.fthb === '1' || ctx.query.fthb === 'true' }
    );
    return { documents };
  });

  /** Restore a previously removed rule item for this client. */
  router.post('/api/broker/files/:id/checklist/restore', requirePermission('documents.request'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const docTypeId = intOrNull(ctx.body && ctx.body.document_type_id);
    if (!docTypeId) throw new ApiError(400, 'Choose a document to restore.', 'missing_field');
    const scopedApplicant = ctx.body && ctx.body.applicant_id !== undefined
      ? intOrNull(ctx.body.applicant_id)
      : undefined; // undefined = restore for the whole file
    await unexcludeFromChecklist(file.id, docTypeId, scopedApplicant);
    const sync = await syncChecklist(file.id, ctx.user.id);
    await activity(file.id, ctx.user, 'checklist_updated', 'A removed document was restored to this checklist');
    return { ok: true, checklist_sync: sync };
  });

  /** Documents the broker removed for this client (so the UI can offer restore). */
  router.get('/api/broker/files/:id/checklist/exclusions', requirePermission('documents.view'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    return {
      exclusions: await all(
        `SELECT e.*, dt.name AS document_name, dt.category
           FROM checklist_exclusions e JOIN document_types dt ON dt.id = e.document_type_id
          WHERE e.file_id = ? ORDER BY dt.name`,
        file.id
      ),
    };
  });

  router.post('/api/broker/requests/:id/review', requirePermission('documents.review'), async (ctx) => {
    const request = await get('SELECT * FROM document_requests WHERE id = ?', idParam(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    const file = await fileOrThrow(request.file_id);
    const docType = await get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
    const b = ctx.body || {};
    const action = b.action;
    if (!['approve', 'reject', 'request_replacement'].includes(action)) {
      throw new ApiError(400, 'Unknown review action.', 'bad_action');
    }
    const version = request.current_version_id
      ? await get('SELECT * FROM document_versions WHERE id = ?', request.current_version_id)
      : await get('SELECT * FROM document_versions WHERE request_id = ? ORDER BY version DESC LIMIT 1', request.id);
    if (!version) throw new ApiError(400, 'There is no uploaded document to review yet.', 'no_upload');
    const clientNote = str(b.client_note, 1000);
    const internalNote = str(b.internal_note, 1000);
    if (action !== 'approve' && !clientNote) {
      throw new ApiError(400, 'Please tell the client what to fix — add a short client-facing note.', 'note_required');
    }

    const versionStatus = action === 'approve' ? 'approved' : 'rejected';
    const requestStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'replacement_requested';
    await run(
      `UPDATE document_versions SET status = ?, review_note_client = ?, review_note_internal = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ?`,
      versionStatus, clientNote, internalNote, ctx.user.id, now(), version.id
    );
    const expiresAt = action === 'approve' && request.expires_days ? addDays(now(), request.expires_days) : null;
    await run(
      'UPDATE document_requests SET status = ?, expires_at = ?, updated_at = ? WHERE id = ?',
      requestStatus, expiresAt, now(), request.id
    );

    const verb = action === 'approve' ? 'approved' : 'not approved';
    await activity(file.id, ctx.user, `document_${action === 'approve' ? 'approved' : 'rejected'}`, `${docType.name} ${verb}${clientNote ? ` — "${clientNote}"` : ''}`, {}, true);
    await audit(ctx.user.id, `document_${action === 'approve' ? 'approved' : 'rejected'}`, 'document_version', version.id, ctx.ip);

    if (action === 'approve') {
      await notifyClientsForFile(file.id, 'document_approved', `${docType.name} approved`, '', '#/documents');
    } else {
      await notifyClientsForFile(file.id, 'document_rejected', `${docType.name} needs a replacement`, clientNote, '#/documents');
    }
    if (b.send_email !== false) {
      const users = await all(
        'SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id WHERE a.file_id = ? GROUP BY u.id',
        file.id
      );
      const templateKey = action === 'approve' ? 'document_approved' : 'document_rejected';
      for (const u of users) {
        await sendTemplate(templateKey, {
          toEmail: u.email, toName: `${u.first_name} ${u.last_name}`.trim(), userId: u.id, fileId: file.id,
          vars: { client_first_name: u.first_name, client_last_name: u.last_name, document_name: docType.name },
        });
      }
    }

    const progress = await checklistProgress(file.id);
    if (progress.complete) {
      const { notifyStaffForFile } = require('../notify');
      await notifyStaffForFile(file, 'checklist_complete', 'Document checklist complete', `Every required document on ${file.file_number} is approved.`, `#/files/${file.id}/documents`);
      await activity(file.id, null, 'checklist_complete', 'Every required document has been approved', {}, true);
    }
    return {
      ok: true,
      request: await requestFull(request.id, { includeInternal: true, canDownload: await canDownload(ctx) }),
      progress,
    };
  });

  /** Retry a failed AI review (internal-only result). */
  router.post('/api/broker/ai-reviews/:id/retry', requirePermission('documents.review'), async (ctx) => {
    const review = await get('SELECT * FROM ai_reviews WHERE id = ?', idParam(ctx.params.id));
    if (!review) throw new ApiError(404, 'That AI review was not found.', 'not_found');
    // Re-check both gates before re-queueing: the server switch and this
    // file's own consent (audit finding C6). A retry must never be the way a
    // document reaches Anthropic after the feature was turned off.
    const reviewFile = await get('SELECT * FROM client_files WHERE id = ?', review.file_id);
    if (!(await aiReview.isEnabledForFile(reviewFile))) {
      throw new ApiError(
        400,
        aiReview.disabledReason() || 'AI review is switched off for this client, or their consent has not been recorded.',
        'ai_disabled'
      );
    }
    await aiReview.retryReview(review.id);
    return { ok: true };
  });

  /**
   * Email the client a single summary of everything still outstanding.
   * The same items are already visible in their portal — this is the
   * notification layer, not the source of truth.
   */
  router.post('/api/broker/files/:id/request-outstanding', requirePermission('documents.request'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const outstanding = await all(
      `SELECT r.*, dt.name AS document_name FROM document_requests r
         JOIN document_types dt ON dt.id = r.document_type_id
        WHERE r.file_id = ? AND r.requirement = 'required'
          AND r.status IN (${OUTSTANDING_STATUSES.map(() => '?').join(',')})
        ORDER BY dt.sort`,
      file.id, ...OUTSTANDING_STATUSES
    );
    if (outstanding.length === 0) {
      throw new ApiError(400, 'Nothing is outstanding for this client right now.', 'nothing_outstanding');
    }
    const users = await all(
      'SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id WHERE a.file_id = ? GROUP BY u.id',
      file.id
    );
    if (users.length === 0) {
      throw new ApiError(400, 'This client does not have portal access yet — create their account first.', 'no_recipient');
    }
    const list = outstanding
      .map((r) => `- ${r.document_name}${r.client_message ? ` (${r.client_message})` : ''}`)
      .join('\n');
    for (const u of users) {
      await notifyUser(u.id, 'documents_outstanding', 'Documents still needed', `${outstanding.length} item${outstanding.length > 1 ? 's' : ''} outstanding`, file.id, '#/documents');
      await sendTemplate('documents_outstanding', {
        toEmail: u.email, toName: `${u.first_name} ${u.last_name}`.trim(), userId: u.id, fileId: file.id,
        vars: {
          client_first_name: u.first_name,
          client_last_name: u.last_name,
          document_list: list,
          application_number: file.file_number,
        },
      });
    }
    await activity(file.id, ctx.user, 'email_sent', `Outstanding documents email sent (${outstanding.length} item${outstanding.length > 1 ? 's' : ''})`);
    return { ok: true, sent: users.length, documents: outstanding.length };
  });

  router.post('/api/broker/requests/:id/remind', requirePermission('documents.request'), async (ctx) => {
    const request = await get('SELECT * FROM document_requests WHERE id = ?', idParam(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    if (!OUTSTANDING_STATUSES.includes(request.status)) {
      throw new ApiError(400, 'This document has already been received, so no reminder is needed.', 'not_outstanding');
    }
    const sent = await sendDocumentReminder(request, { manual: true, actor: ctx.user });
    if (!sent) throw new ApiError(400, 'No portal user is connected to this document yet — invite the applicant first.', 'no_recipient');
    return { ok: true };
  });

  router.post('/api/broker/requests/:id/upload', requirePermission('documents.upload'), async (ctx) => {
    const request = await get('SELECT * FROM document_requests WHERE id = ?', idParam(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    const file = await fileOrThrow(request.file_id);
    let filename = '';
    try {
      filename = str(ctx.req.headers['x-filename'] ? decodeURIComponent(ctx.req.headers['x-filename']) : '', 300);
    } catch {
      throw new ApiError(400, 'The file name could not be read. Please rename the file and try again.', 'bad_filename');
    }
    const saved = await saveRequestBody(ctx.req, filename);
    const docType = await get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
    const versionId = await recordVersion(request, saved, filename, ctx.user);
    await activity(file.id, ctx.user, 'document_uploaded', `${docType.name} uploaded by the brokerage`, {}, true);
    await audit(ctx.user.id, 'document_uploaded', 'document_version', versionId, ctx.ip);
    return { ok: true, request: await requestFull(request.id, { includeInternal: true, canDownload: await canDownload(ctx) }) };
  }).raw();

  /**
   * Document bytes.
   *
   * Audit finding H6: this endpoint requires `documents.download` whatever
   * the `disposition` query parameter says. Serving the same bytes inline is
   * not a lesser action than serving them as an attachment — a role without
   * download rights previously got the whole document by dropping one query
   * parameter. `documents.view` now means "see that the document exists and
   * its review state"; `documents.download` means "obtain the contents".
   */
  router.get('/api/broker/versions/:id/file', requirePermission('documents.download'), async (ctx) => {
    const version = await get('SELECT * FROM document_versions WHERE id = ?', idParam(ctx.params.id));
    if (!version) throw new ApiError(404, 'File not found.', 'not_found');
    if (!scan.isServable(version)) {
      throw new ApiError(409, 'This document is still being checked by the malware scanner, or has been quarantined.', 'not_available');
    }
    const wantsDownload = ctx.query.disposition === 'attachment';
    const bytes = await readStored(version.stored_name, parseJsonSafe(version.enc_envelope, null));
    await audit(ctx.user.id, wantsDownload ? 'document_downloaded' : 'document_previewed', 'document_version', version.id, ctx.ip);
    ctx.res.writeHead(200, {
      'Content-Type': version.mime,
      'Content-Length': bytes.length,
      'Content-Disposition': `${wantsDownload ? 'attachment' : 'inline'}; filename="${(version.display_name || version.original_name).replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // The application-wide DENY is correct for pages, but this response is
      // framed by our own preview modal. Framing is still restricted to this
      // origin, and the document itself is sandboxed.
      'X-Frame-Options': 'SAMEORIGIN',
      // A malicious PDF/SVG rendered inline must not be able to reach back
      // into the application origin.
      'Content-Security-Policy':
        "default-src 'none'; object-src 'none'; script-src 'none'; " +
        "frame-ancestors 'self'; sandbox",
    });
    ctx.res.end(bytes);
    return HANDLED;
  });

  // ------------------------------ Messages ------------------------------
  router.get('/api/broker/files/:id/messages', requirePermission('clients.view'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const after = intOrNull(ctx.query.after) || 0;
    const search = str(ctx.query.q, 100).toLowerCase();
    const params = [file.id, after];
    let searchSql = '';
    if (search) {
      searchSql = ' AND lower(m.body) LIKE ?';
      params.push(`%${search}%`);
    }
    const rows = await all(
      `SELECT m.*, u.first_name || ' ' || u.last_name AS sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.file_id = ? AND m.id > ?${searchSql} ORDER BY m.id LIMIT 200`,
      ...params
    );
    return { messages: rows.map(messageRow) };
  });

  router.post('/api/broker/files/:id/messages', requirePermission('chat.send'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const body = str(ctx.body && ctx.body.body, 4000);
    if (!body) throw new ApiError(400, 'The message was empty.', 'empty');
    const id = await insert(
      `INSERT INTO messages (file_id, sender_id, sender_kind, body, created_at, read_by_staff_at)
       VALUES (?, ?, 'staff', ?, ?, ?)`,
      file.id, ctx.user.id, body, now(), now()
    );
    await touchFile(file.id);
    await audit(ctx.user.id, 'message_sent', 'client_file', file.id, ctx.ip);
    await notifyClientsForFile(file.id, 'new_message', 'New message from your broker', body.slice(0, 120), '#/messages');
    if (ctx.body && ctx.body.send_email) {
      const users = await all(
        'SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id WHERE a.file_id = ? GROUP BY u.id',
        file.id
      );
      for (const u of users) {
        await sendTemplate('new_message', {
          toEmail: u.email, toName: `${u.first_name} ${u.last_name}`.trim(), userId: u.id, fileId: file.id,
          vars: { client_first_name: u.first_name, client_last_name: u.last_name },
        });
      }
    }
    return { ok: true, id };
  });

  router.post('/api/broker/files/:id/messages/read', requirePermission('clients.view'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    await run(
      "UPDATE messages SET read_by_staff_at = ? WHERE file_id = ? AND sender_kind = 'client' AND read_by_staff_at IS NULL",
      now(), file.id
    );
    return { ok: true };
  });

  router.patch('/api/broker/messages/:id', requirePermission('chat.send'), async (ctx) => {
    const message = await get('SELECT * FROM messages WHERE id = ?', idParam(ctx.params.id));
    if (!message || message.sender_id !== ctx.user.id) {
      throw new ApiError(404, 'Message not found.', 'not_found');
    }
    const body = str(ctx.body && ctx.body.body, 4000);
    if (!body) throw new ApiError(400, 'The message was empty.', 'empty');
    await run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', body, now(), message.id);
    return { ok: true };
  });

  // ------------------------------ Tasks ------------------------------
  router.get('/api/broker/tasks', requirePermission('tasks.manage'), async (ctx) => {
    const q = ctx.query;
    const where = [];
    const params = [];
    if (q.file_id) { where.push('t.file_id = ?'); params.push(idParam(q.file_id)); }
    if (q.assigned_to) { where.push('t.assigned_to = ?'); params.push(idParam(q.assigned_to)); }
    if (q.status) { where.push('t.status = ?'); params.push(str(q.status, 20)); }
    else if (q.filter !== 'all') { where.push("t.status IN ('pending','in_progress')"); }
    if (q.filter === 'today') { where.push('t.due_date = ?'); params.push(today()); }
    if (q.filter === 'overdue') { where.push('t.due_date < ?'); params.push(today()); }
    if (q.filter === 'upcoming') { where.push('(t.due_date IS NULL OR t.due_date >= ?)'); params.push(today()); }
    const rows = await all(
      `SELECT t.*, f.file_number, u.first_name || ' ' || u.last_name AS assigned_name
         FROM tasks t
         LEFT JOIN client_files f ON f.id = t.file_id
         LEFT JOIN users u ON u.id = t.assigned_to
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.priority = 'high' DESC, t.id DESC
        LIMIT 200`,
      ...params
    );
    return { tasks: rows };
  });

  router.post('/api/broker/tasks', requirePermission('tasks.manage'), async (ctx) => {
    const b = ctx.body || {};
    const title = str(b.title, 200);
    if (!title) throw new ApiError(400, 'The task needs a title.', 'missing_field');
    const fileId = intOrNull(b.file_id);
    if (fileId) await fileOrThrow(fileId);
    const assignedTo = intOrNull(b.assigned_to) || ctx.user.id;
    const id = await insert(
      `INSERT INTO tasks (file_id, title, description, due_date, priority, status, assigned_to, source, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, 'manual', ?, ?, ?)`,
      fileId, title, str(b.description, 2000), dateStr(b.due_date),
      ['low', 'normal', 'high'].includes(b.priority) ? b.priority : 'normal',
      assignedTo, ctx.user.id, now(), now()
    );
    if (fileId) await activity(fileId, ctx.user, 'task_created', `Task created: ${title}`);
    if (assignedTo !== ctx.user.id) {
      await notifyUser(assignedTo, 'task_assigned', `New task: ${title}`, b.due_date ? `Due ${b.due_date}` : '', fileId, `task:${id}`);
    }
    return { ok: true, id };
  });

  router.patch('/api/broker/tasks/:id', requirePermission('tasks.manage'), async (ctx) => {
    const task = await get('SELECT * FROM tasks WHERE id = ?', idParam(ctx.params.id));
    if (!task) throw new ApiError(404, 'Task not found.', 'not_found');
    const b = ctx.body || {};
    const status = ['pending', 'in_progress', 'completed', 'cancelled'].includes(b.status) ? b.status : task.status;
    await run(
      `UPDATE tasks SET title = ?, description = ?, due_date = ?, priority = ?, status = ?, assigned_to = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      b.title !== undefined ? str(b.title, 200) || task.title : task.title,
      b.description !== undefined ? str(b.description, 2000) : task.description,
      b.due_date !== undefined ? dateStr(b.due_date) : task.due_date,
      ['low', 'normal', 'high'].includes(b.priority) ? b.priority : task.priority,
      status,
      b.assigned_to !== undefined ? intOrNull(b.assigned_to) : task.assigned_to,
      now(),
      status === 'completed' ? (task.completed_at || now()) : null,
      task.id
    );
    if (status === 'completed' && task.status !== 'completed' && task.file_id) {
      await activity(task.file_id, ctx.user, 'task_completed', `Task completed: ${task.title}`);
    }
    return { ok: true };
  });

  // ------------------------------ Notes ------------------------------
  router.get('/api/broker/files/:id/notes', requirePermission('notes.manage'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    return {
      notes: await all(
        `SELECT n.*, cu.first_name || ' ' || cu.last_name AS created_by_name,
                uu.first_name || ' ' || uu.last_name AS updated_by_name
           FROM notes n
           LEFT JOIN users cu ON cu.id = n.created_by
           LEFT JOIN users uu ON uu.id = n.updated_by
          WHERE n.file_id = ? ORDER BY n.pinned DESC, n.created_at DESC`,
        file.id
      ),
    };
  });

  router.post('/api/broker/files/:id/notes', requirePermission('notes.manage'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const body = str(ctx.body && ctx.body.body, 4000);
    if (!body) throw new ApiError(400, 'The note was empty.', 'empty');
    const id = await insert(
      'INSERT INTO notes (file_id, body, pinned, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      file.id, body, bool(ctx.body.pinned), ctx.user.id, now()
    );
    return { ok: true, id };
  });

  router.patch('/api/broker/notes/:id', requirePermission('notes.manage'), async (ctx) => {
    const note = await get('SELECT * FROM notes WHERE id = ?', idParam(ctx.params.id));
    if (!note) throw new ApiError(404, 'Note not found.', 'not_found');
    const b = ctx.body || {};
    await run(
      'UPDATE notes SET body = ?, pinned = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      b.body !== undefined ? str(b.body, 4000) || note.body : note.body,
      b.pinned !== undefined ? bool(b.pinned) : note.pinned,
      ctx.user.id, now(), note.id
    );
    return { ok: true };
  });

  router.delete('/api/broker/notes/:id', requirePermission('notes.manage'), async (ctx) => {
    const note = await get('SELECT * FROM notes WHERE id = ?', idParam(ctx.params.id));
    if (!note) throw new ApiError(404, 'Note not found.', 'not_found');
    await run('DELETE FROM notes WHERE id = ?', note.id);
    await audit(ctx.user.id, 'note_deleted', 'note', note.id, ctx.ip);
    return { ok: true };
  });

  // ------------------------------ Activity & emails ------------------------------
  router.get('/api/broker/files/:id/activity', requirePermission('clients.view'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    return {
      activity: await all('SELECT * FROM activity_log WHERE file_id = ? ORDER BY id DESC LIMIT 200', file.id),
    };
  });

  router.get('/api/broker/files/:id/emails', requirePermission('emails.view'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    return {
      emails: await all(
        'SELECT id, to_email, to_name, template_key, subject, status, created_at, sent_at FROM email_log WHERE file_id = ? ORDER BY id DESC LIMIT 100',
        file.id
      ),
    };
  });

  router.get('/api/broker/emails/:id', requirePermission('emails.view'), async (ctx) => {
    const email = await get('SELECT * FROM email_log WHERE id = ?', idParam(ctx.params.id));
    if (!email) throw new ApiError(404, 'Email not found.', 'not_found');
    return { email };
  });

  // ------------------------------ Notifications ------------------------------
  router.get('/api/broker/notifications', requireStaff, async (ctx) => {
    const unreadOnly = ctx.query.unread === '1';
    return {
      notifications: await all(
        `SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 100`,
        ctx.user.id
      ),
    };
  });

  router.post('/api/broker/notifications/read', requireStaff, async (ctx) => {
    const b = ctx.body || {};
    if (b.all) {
      await run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), ctx.user.id);
    } else if (Array.isArray(b.ids)) {
      const ids = b.ids.slice(0, 100).map((v) => intOrNull(v)).filter((v) => v !== null);
      if (ids.length) {
        await run(
          'UPDATE notifications SET read_at = ? WHERE id = ANY(?::int[]) AND user_id = ?',
          now(), ids, ctx.user.id
        );
      }
    }
    return { ok: true };
  });

  // ------------------------------ Search ------------------------------
  router.get('/api/broker/search', requirePermission('clients.view'), async (ctx) => {
    const q = str(ctx.query.q, 100).toLowerCase();
    if (q.length < 2) return { results: [] };
    const like = `%${q}%`;
    const digits = phoneDigits(q);
    const files = await all(
      `SELECT f.* FROM client_files f
        WHERE lower(f.file_number) LIKE ?
           OR lower(COALESCE(f.property_address, '')) LIKE ?
           OR EXISTS (
                SELECT 1 FROM applicants a WHERE a.file_id = f.id AND (
                  lower(COALESCE(a.first_name,'') || ' ' || COALESCE(a.last_name,'')) LIKE ?
                  OR lower(COALESCE(a.preferred_name,'')) LIKE ?
                  OR lower(COALESCE(a.email,'')) LIKE ?
                  OR (? <> '' AND regexp_replace(COALESCE(a.phone,''), '[^0-9]', '', 'g') LIKE ?)
                ))
        ORDER BY COALESCE(f.last_activity_at, f.updated_at) DESC
        LIMIT 20`,
      like, like, like, like, like, digits, `%${digits}%`
    );
    return { results: await summarize(files) };
  });

  // ------------------------------ Reports ------------------------------
  router.get('/api/broker/reports', requirePermission('reports.view'), async (ctx) => {
    const year = new Date().getUTCFullYear();
    const byStage = await all(
      `SELECT s.id, s.name, s.color, COUNT(f.id)::int AS n
         FROM stages s LEFT JOIN client_files f ON f.stage_id = s.id AND f.status = 'active'
        WHERE s.active = 1 GROUP BY s.id, s.name, s.color, s.sort ORDER BY s.sort`
    );
    const outstandingDocs = (await get(
      `SELECT COUNT(*)::int AS n FROM document_requests r JOIN client_files f ON f.id = r.file_id
        WHERE f.status = 'active' AND r.requirement = 'required'
          AND r.status IN (${OUTSTANDING_STATUSES.map(() => '?').join(',')})`,
      ...OUTSTANDING_STATUSES
    )).n;
    const awaitingReview = (await get(
      `SELECT COUNT(*)::int AS n FROM document_requests r JOIN client_files f ON f.id = r.file_id
        WHERE f.status = 'active' AND r.status IN ('uploaded','under_review')`
    )).n;
    const funded = (await get(
      `SELECT COUNT(*)::int AS n FROM stage_history h JOIN stages s ON s.id = h.to_stage_id
        WHERE s.key = 'funded' AND h.changed_at >= ?`, `${year}-01-01`
    )).n;
    const cancelled = (await get("SELECT COUNT(*)::int AS n FROM client_files WHERE status = 'cancelled'")).n;
    const upcomingFiles = await all(
      `SELECT f.* FROM client_files f
        WHERE f.status = 'active' AND f.closing_date IS NOT NULL AND f.closing_date BETWEEN ? AND ?
        ORDER BY f.closing_date LIMIT 20`,
      today(), addDays(now(), 45).slice(0, 10)
    );
    const overdueFollowups = (await get(
      "SELECT COUNT(*)::int AS n FROM tasks WHERE status IN ('pending','in_progress') AND due_date < ?", today()
    )).n;
    // Average days the current active files have spent in their current
    // stage — averaged in SQL rather than by pulling every row into memory.
    const avgRow = await get(
      `SELECT AVG(EXTRACT(EPOCH FROM (now() - entered::timestamptz)) / 86400) AS days FROM (
         SELECT MAX(h.changed_at) AS entered FROM client_files f
           JOIN stage_history h ON h.file_id = f.id AND h.to_stage_id = f.stage_id
          WHERE f.status = 'active' GROUP BY f.id
       ) t`
    );

    return {
      active_clients: (await get("SELECT COUNT(*)::int AS n FROM client_files WHERE status = 'active'")).n,
      by_stage: byStage,
      documents_outstanding: outstandingDocs,
      documents_awaiting_review: awaitingReview,
      funded_this_year: funded,
      cancelled_total: cancelled,
      upcoming_closings: await summarize(upcomingFiles),
      overdue_followups: overdueFollowups,
      avg_days_in_stage: avgRow && avgRow.days !== null ? Math.round(Number(avgRow.days)) : null,
    };
  });

  // ------------------------------ Bulk actions ------------------------------
  router.post('/api/broker/bulk', requireStaff, async (ctx) => {
    const b = ctx.body || {};
    const action = b.action;
    const fileIds = (Array.isArray(b.file_ids) ? b.file_ids : []).slice(0, 100)
      .map((v) => intOrNull(v)).filter((v) => v !== null);

    if (action === 'remind') {
      await requirePermission('documents.request')(ctx);
      let sent = 0;
      for (const fileId of fileIds) {
        const requests = await all(
          `SELECT * FROM document_requests WHERE file_id = ? AND requirement = 'required'
            AND status IN (${OUTSTANDING_STATUSES.map(() => '?').join(',')})`,
          fileId, ...OUTSTANDING_STATUSES
        );
        for (const request of requests) {
          if (await sendDocumentReminder(request, { actor: ctx.user })) sent += 1;
        }
      }
      return { ok: true, sent };
    }
    if (action === 'assign') {
      await requirePermission('clients.edit')(ctx);
      const brokerId = intOrNull(b.broker_id);
      if (brokerId && !(await get("SELECT id FROM users WHERE id = ? AND role != 'client'", brokerId))) {
        throw new ApiError(400, 'That team member was not found.', 'bad_user');
      }
      let updated = 0;
      for (const fileId of fileIds) {
        const file = await get('SELECT * FROM client_files WHERE id = ?', fileId);
        if (!file) continue;
        await run('UPDATE client_files SET assigned_broker_id = ?, updated_at = ? WHERE id = ?', brokerId, now(), file.id);
        await activity(file.id, ctx.user, 'assigned', 'File reassigned (bulk action)');
        updated += 1;
      }
      return { ok: true, updated };
    }
    if (action === 'task_status') {
      await requirePermission('tasks.manage')(ctx);
      const status = ['pending', 'in_progress', 'completed', 'cancelled'].includes(b.status) ? b.status : null;
      if (!status) throw new ApiError(400, 'Choose a status for the selected tasks.', 'bad_status');
      const taskIds = (Array.isArray(b.task_ids) ? b.task_ids : []).slice(0, 200)
        .map((v) => intOrNull(v)).filter((v) => v !== null);
      if (!taskIds.length) return { ok: true, updated: 0 };
      const res = await run(
        'UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ANY(?::int[])',
        status, now(), status === 'completed' ? now() : null, taskIds
      );
      return { ok: true, updated: res.changes };
    }
    throw new ApiError(400, 'Unknown bulk action.', 'bad_action');
  });

  // ------------------------------ Consents ------------------------------
  router.get('/api/broker/files/:id/consents', requirePermission('clients.view'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    return { consents: await all('SELECT * FROM consents WHERE file_id = ? ORDER BY id DESC', file.id) };
  });

  router.post('/api/broker/files/:id/consents', requirePermission('clients.edit'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const form = await get('SELECT * FROM consent_forms WHERE id = ? AND active = 1', intOrNull(ctx.body && ctx.body.form_id));
    if (!form) throw new ApiError(400, 'Choose an active consent form. Forms are configured in Settings.', 'bad_form');
    const applicantId = intOrNull(ctx.body && ctx.body.applicant_id);
    if (applicantId && !(await get('SELECT id FROM applicants WHERE id = ? AND file_id = ?', applicantId, file.id))) {
      throw new ApiError(400, 'That applicant is not on this file.', 'bad_applicant');
    }
    const id = await insert(
      `INSERT INTO consents (file_id, applicant_id, form_id, form_title, form_version, form_body_snapshot, status, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
      file.id, applicantId, form.id, form.title, form.version, form.body, ctx.user.id, now()
    );
    await activity(file.id, ctx.user, 'consent_requested', `Consent requested: ${form.title}`, {}, true);
    await notifyClientsForFile(file.id, 'consent_requested', `Please review: ${form.title}`, '', '#/home');
    return { ok: true, id };
  });

  // ------------------------------ Staff & audit ------------------------------
  router.get('/api/broker/staff', requireStaff, async () => ({ staff: await staffList() }));

  router.get('/api/broker/audit', requirePermission('audit.view'), async (ctx) => {
    const perPage = 50;
    const total = (await get('SELECT COUNT(*)::int AS n FROM audit_log')).n;
    const page = Math.min(Math.max(1, Number(ctx.query.page) || 1), Math.max(1, Math.ceil(total / perPage)));
    const rows = await all(
      `SELECT a.*, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      perPage, (page - 1) * perPage
    );
    return { page, per_page: perPage, total, audit: rows };
  });

  /** Tamper-evidence check over the audit hash chain. */
  router.get('/api/broker/audit/verify', requirePermission('audit.view'), async () => {
    const { verifyAuditChain } = require('../log');
    return verifyAuditChain();
  });
}

// Shared by broker + client upload endpoints.
async function recordVersion(request, saved, filename, uploader) {
  const last = await get('SELECT MAX(version) AS v FROM document_versions WHERE request_id = ?', request.id);
  const versionNumber = ((last && last.v) || 0) + 1;
  // A superseded upload that was never reviewed becomes "replaced"; reviewed
  // versions keep their final status so history stays truthful.
  if (request.current_version_id) {
    await run(
      "UPDATE document_versions SET status = 'replaced' WHERE id = ? AND status = 'uploaded'",
      request.current_version_id
    );
  }
  const versionId = await insert(
    `INSERT INTO document_versions
       (request_id, version, original_name, stored_name, mime, size, status, enc_envelope, scan_status, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?, ?, ?)`,
    request.id, versionNumber, filename || `document.${saved.ext}`, saved.storedName, saved.mime, saved.size,
    saved.envelope ? JSON.stringify(saved.envelope) : null,
    scan.isEnabled() ? 'pending' : 'skipped',
    uploader.id, now()
  );
  await run(
    "UPDATE document_requests SET status = 'uploaded', current_version_id = ?, expires_at = NULL, updated_at = ? WHERE id = ?",
    versionId, now(), request.id
  );
  // Both of these are queued, never awaited past the enqueue: the upload is
  // already durable and the client's request returns immediately. The
  // scheduler picks them up and retries on failure, so a Claude or Graph
  // outage can never lose a document.
  await aiReview.queueReview(versionId);
  await require('../onedrive').queueVersionSync(versionId);
  return versionId;
}

module.exports = {
  register,
  fileOrThrow,
  fileSummary,
  summarize,
  recordVersion,
  afterClientUpload,
  inviteApplicant,
  changeStage,
};
