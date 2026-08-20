'use strict';

const { run, get, all, tx, getSetting, nextFileNumber, touchFile } = require('../db');
const {
  requireStaff, requirePermission, hasPermission, createAuthToken, STAFF_ROLES,
} = require('../auth');
const {
  ApiError, now, today, addDays, str, num, intOrNull, bool, dateStr, isEmail,
  normalizeEmail, phoneDigits, fullName,
} = require('../util');
const { audit, activity } = require('../log');
const { sendTemplate, portalBaseUrl } = require('../emails');
const { notifyUser, notifyClientsForFile } = require('../notify');
const {
  syncChecklist, checklistProgress, previewChecklist,
  excludeFromChecklist, unexcludeFromChecklist,
} = require('../checklist');
const { clientNextStep, fileAttention, OUTSTANDING_STATUSES } = require('../nextstep');
const { requestFull, fileRequests, applicantSummary, publicUser, messageRow } = require('../serialize');
const { sendDocumentReminder } = require('../reminders');
const { saveRequestBody, openStored } = require('../storage');
const { HANDLED } = require('../router');
const aiReview = require('../ai-review');

// ---------------------------------------------------------------------------
// Helpers

function fileOrThrow(id) {
  const file = get('SELECT * FROM client_files WHERE id = ?', Number(id));
  if (!file) throw new ApiError(404, 'That client file was not found.', 'not_found');
  return file;
}

function fileSummary(file) {
  const stage = file.stage_id ? get('SELECT * FROM stages WHERE id = ?', file.stage_id) : null;
  const type = file.application_type_id ? get('SELECT * FROM application_types WHERE id = ?', file.application_type_id) : null;
  const primary = get("SELECT * FROM applicants WHERE file_id = ? AND role = 'primary' ORDER BY id LIMIT 1", file.id)
    || get('SELECT * FROM applicants WHERE file_id = ? ORDER BY id LIMIT 1', file.id);
  const applicants = all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', file.id);
  const progress = checklistProgress(file.id);
  const unread = get(
    "SELECT COUNT(*) AS n FROM messages WHERE file_id = ? AND sender_kind = 'client' AND read_by_staff_at IS NULL",
    file.id
  ).n;
  const broker = file.assigned_broker_id ? get('SELECT * FROM users WHERE id = ?', file.assigned_broker_id) : null;
  return {
    id: file.id,
    file_number: file.file_number,
    status: file.status,
    client_name: primary ? fullName(primary) : '(no applicant)',
    applicant_names: applicants.map((a) => fullName(a)),
    applicant_count: applicants.length,
    application_type: type ? type.name : null,
    application_type_id: file.application_type_id,
    stage: stage ? { id: stage.id, name: stage.name, color: stage.color, client_label: stage.client_label } : null,
    assigned_broker: broker ? { id: broker.id, name: `${broker.first_name} ${broker.last_name}`.trim() } : null,
    purchase_price: file.purchase_price,
    mortgage_amount: file.mortgage_amount,
    property_address: file.property_address,
    closing_date: file.closing_date,
    fthb: !!file.fthb,
    checklist: progress,
    unread_messages: unread,
    created_at: file.created_at,
    updated_at: file.updated_at,
    last_activity_at: file.last_activity_at,
  };
}

function findDuplicates({ email, phone, first_name, last_name }) {
  const results = new Map();
  const push = (applicant, why) => {
    const key = applicant.file_id;
    if (!results.has(key)) {
      const file = get('SELECT * FROM client_files WHERE id = ?', applicant.file_id);
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
    for (const a of all('SELECT * FROM applicants WHERE lower(email) = ?', normEmail)) push(a, 'Same email');
  }
  const digits = phoneDigits(phone);
  if (digits.length >= 7) {
    for (const a of all("SELECT * FROM applicants WHERE phone != ''")) {
      if (phoneDigits(a.phone).endsWith(digits.slice(-10)) && phoneDigits(a.phone).length >= 7) push(a, 'Same phone number');
    }
  }
  if (first_name && last_name) {
    for (const a of all(
      'SELECT * FROM applicants WHERE lower(first_name) = ? AND lower(last_name) = ?',
      String(first_name).toLowerCase().trim(), String(last_name).toLowerCase().trim()
    )) {
      push(a, 'Same name');
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

function insertApplicant(fileId, fields) {
  const res = run(
    `INSERT INTO applicants
       (file_id, role, first_name, middle_name, last_name, preferred_name, email, phone, dob, address,
        preferred_contact, employment_type, employer_name, job_title, employment_notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fileId, fields.role, fields.first_name, fields.middle_name, fields.last_name, fields.preferred_name,
    fields.email, fields.phone, fields.dob, fields.address, fields.preferred_contact,
    fields.employment_type, fields.employer_name, fields.job_title, fields.employment_notes, now(), now()
  );
  return Number(res.lastInsertRowid);
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
  const applicant = get('SELECT * FROM applicants WHERE id = ?', applicantId);
  if (!applicant) throw new ApiError(404, 'Applicant not found.', 'not_found');
  if (!isEmail(applicant.email)) {
    throw new ApiError(400, 'This applicant needs a valid email address before they can be invited to the portal.', 'no_email');
  }
  let user = get('SELECT * FROM users WHERE email = ?', applicant.email);
  if (user && user.role !== 'client') {
    throw new ApiError(400, 'That email belongs to a brokerage staff account and cannot be used for a client portal login.', 'email_conflict');
  }

  const { generateTemporaryPassword, hashPassword } = require('../auth');
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = hashPassword(temporaryPassword);

  if (!user) {
    const res = run(
      `INSERT INTO users (role, email, first_name, last_name, phone, password_hash, status, must_change_password, created_at, updated_at)
       VALUES ('client', ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      applicant.email, applicant.first_name, applicant.last_name, applicant.phone, passwordHash, now(), now()
    );
    user = get('SELECT * FROM users WHERE id = ?', Number(res.lastInsertRowid));
  } else {
    // Re-issuing credentials for an existing portal account: new temporary
    // password, forced change again, and every existing session dropped.
    const { destroyAllSessions } = require('../auth');
    run(
      `UPDATE users SET password_hash = ?, status = 'active', must_change_password = 1,
         failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      passwordHash, now(), user.id
    );
    destroyAllSessions(user.id);
    user = get('SELECT * FROM users WHERE id = ?', user.id);
  }
  run('UPDATE applicants SET portal_user_id = ?, updated_at = ? WHERE id = ?', user.id, now(), applicant.id);

  const file = get('SELECT * FROM client_files WHERE id = ?', applicant.file_id);
  const appType = file && file.application_type_id
    ? get('SELECT * FROM application_types WHERE id = ?', file.application_type_id)
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
    activity(applicant.file_id, actor, 'email_sent', `Welcome email with portal credentials sent to ${fullName(applicant)}`);
  }
  audit(actor ? actor.id : null, 'portal_account_created', 'applicant', applicant.id, ctx ? ctx.ip : null, { user_id: user.id });
  return { user, username: user.email, temporary_password: temporaryPassword, portal_link: link };
}

function staffList() {
  return all("SELECT * FROM users WHERE role != 'client' AND status != 'disabled' ORDER BY first_name, last_name")
    .map(publicUser);
}

async function changeStage(file, stageId, note, actor, ctx) {
  const stage = get('SELECT * FROM stages WHERE id = ? AND active = 1', Number(stageId));
  if (!stage) throw new ApiError(400, 'That stage is not available.', 'bad_stage');
  if (file.stage_id === stage.id) return { ok: true, unchanged: true };

  const fromStage = file.stage_id ? get('SELECT * FROM stages WHERE id = ?', file.stage_id) : null;
  run('UPDATE client_files SET stage_id = ?, updated_at = ? WHERE id = ?', stage.id, now(), file.id);
  run(
    'INSERT INTO stage_history (file_id, from_stage_id, to_stage_id, changed_by, note, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
    file.id, file.stage_id, stage.id, actor ? actor.id : null, str(note, 500), now()
  );
  activity(file.id, actor, 'stage_changed', `Stage changed${fromStage ? ` from "${fromStage.name}"` : ''} to "${stage.name}"`, {}, true);
  audit(actor ? actor.id : null, 'stage_change', 'client_file', file.id, ctx ? ctx.ip : null, { to: stage.key });

  notifyClientsForFile(file.id, 'stage_changed', 'Your application has moved forward', stage.client_message || stage.client_label, '#/home');

  if (stage.send_email) {
    const users = all(
      `SELECT u.*, a.first_name AS a_first, a.last_name AS a_last FROM users u
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
    if (users.length) activity(file.id, null, 'email_sent', `Stage update email sent (${stage.name})`);
  }

  if (stage.create_task) {
    run(
      `INSERT INTO tasks (file_id, title, description, due_date, priority, status, assigned_to, source, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'normal', 'pending', ?, 'auto', ?, ?, ?)`,
      file.id,
      stage.task_title || `Review file — ${stage.name}`,
      `Created automatically when the file entered "${stage.name}".`,
      today(),
      file.assigned_broker_id, actor ? actor.id : null, now(), now()
    );
    activity(file.id, null, 'task_created', `Task created automatically: ${stage.task_title || `Review file — ${stage.name}`}`);
  }
  return { ok: true };
}

/** After an upload: statuses, notifications and (optionally) the auto review task. */
function afterClientUpload(file, request, docName, uploader) {
  activity(file.id, uploader, 'document_uploaded', `${docName} uploaded`, {}, true);
  const { notifyStaffForFile } = require('../notify');
  notifyStaffForFile(file, 'document_uploaded', `${docName} uploaded`, `File ${file.file_number}`, `#/files/${file.id}/documents`);

  const progress = checklistProgress(file.id);
  if (progress.all_submitted && getSetting('automation', {}).task_on_all_docs_uploaded !== false) {
    const open = get(
      `SELECT id FROM tasks WHERE file_id = ? AND source = 'auto' AND title = ? AND status IN ('pending','in_progress')`,
      file.id, "Review the client's document package"
    );
    if (!open) {
      run(
        `INSERT INTO tasks (file_id, title, description, due_date, priority, status, assigned_to, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'high', 'pending', ?, 'auto', ?, ?)`,
        file.id, "Review the client's document package",
        'Every required document has been submitted.', today(), file.assigned_broker_id, now(), now()
      );
      activity(file.id, null, 'task_created', "Task created automatically: Review the client's document package");
    }
  }
}

// ---------------------------------------------------------------------------

function register(router) {
  // ------------------------------ Dashboard ------------------------------
  router.get('/api/broker/dashboard', requirePermission('clients.view'), (ctx) => {
    const mine = ctx.query.mine === '1' ? ctx.user.id : null;
    const scope = mine ? 'AND f.assigned_broker_id = ' + Number(mine) : '';
    const files = all(`SELECT f.* FROM client_files f WHERE f.status = 'active' ${scope}`);

    const cards = {
      documents_awaiting_review: 0,
      documents_outstanding_files: 0,
      unread_messages: 0,
      tasks_today: 0,
      tasks_overdue: 0,
      active_clients: files.length,
    };
    const attention = [];

    for (const file of files) {
      const reasons = fileAttention(file);
      if (reasons.length) {
        const summary = fileSummary(file);
        attention.push({
          file_id: file.id,
          file_number: file.file_number,
          client_name: summary.client_name,
          stage: summary.stage,
          reasons,
          score: reasons.reduce((s, r) => s + r.weight, 0),
        });
      }
      for (const r of reasons) {
        if (r.kind === 'review') cards.documents_awaiting_review += parseInt(r.text, 10) || 0;
        if (r.kind === 'outstanding') cards.documents_outstanding_files += 1;
        if (r.kind === 'message') cards.unread_messages += 1;
      }
    }
    attention.sort((a, b) => b.score - a.score);

    const taskScope = mine ? 'AND (t.assigned_to = ' + Number(mine) + ' OR t.assigned_to IS NULL)' : '';
    cards.tasks_today = get(
      `SELECT COUNT(*) AS n FROM tasks t WHERE t.status IN ('pending','in_progress') AND t.due_date = ? ${taskScope}`, today()
    ).n;
    cards.tasks_overdue = get(
      `SELECT COUNT(*) AS n FROM tasks t WHERE t.status IN ('pending','in_progress') AND t.due_date < ? ${taskScope}`, today()
    ).n;

    const todayTasks = all(
      `SELECT t.*, f.file_number FROM tasks t LEFT JOIN client_files f ON f.id = t.file_id
        WHERE t.status IN ('pending','in_progress') AND t.due_date <= ? ${taskScope}
        ORDER BY t.due_date, t.priority = 'high' DESC LIMIT 20`, today()
    );

    const recent = all(
      `SELECT * FROM client_files WHERE status = 'active' ${mine ? 'AND assigned_broker_id = ' + Number(mine) : ''}
        ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT 6`
    ).map(fileSummary);

    return { cards, attention: attention.slice(0, 25), tasks: todayTasks, recent };
  });

  // ------------------------------ Clients ------------------------------
  router.get('/api/broker/clients', requirePermission('clients.view'), (ctx) => {
    const q = ctx.query;
    const where = [];
    const params = [];
    const status = ['active', 'archived', 'completed', 'cancelled', 'all'].includes(q.status) ? q.status : 'active';
    if (status !== 'all') { where.push('f.status = ?'); params.push(status); }
    if (q.stage_id) { where.push('f.stage_id = ?'); params.push(Number(q.stage_id)); }
    if (q.type_id) { where.push('f.application_type_id = ?'); params.push(Number(q.type_id)); }
    if (q.assigned_to) { where.push('f.assigned_broker_id = ?'); params.push(Number(q.assigned_to)); }
    if (q.closing_before) { where.push('f.closing_date IS NOT NULL AND f.closing_date <= ?'); params.push(dateStr(q.closing_before)); }

    let files = all(
      `SELECT f.* FROM client_files f ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(f.last_activity_at, f.updated_at) DESC`,
      ...params
    );

    const query = str(q.q, 100).toLowerCase();
    let summaries = files.map(fileSummary);
    if (query) {
      summaries = summaries.filter((s) =>
        s.client_name.toLowerCase().includes(query) ||
        s.applicant_names.some((n) => n.toLowerCase().includes(query)) ||
        s.file_number.toLowerCase().includes(query) ||
        (s.property_address || '').toLowerCase().includes(query)
      );
    }
    if (q.filter === 'outstanding_docs') summaries = summaries.filter((s) => s.checklist.outstanding > 0);
    if (q.filter === 'awaiting_review') summaries = summaries.filter((s) => s.checklist.awaiting_review > 0);
    if (q.filter === 'unread_messages') summaries = summaries.filter((s) => s.unread_messages > 0);
    if (q.filter === 'closing_month') {
      const end = addDays(now(), 31).slice(0, 10);
      summaries = summaries.filter((s) => s.closing_date && s.closing_date <= end);
    }
    if (q.filter === 'stale') {
      const cutoff = addDays(now(), -7);
      summaries = summaries.filter((s) => (s.last_activity_at || s.updated_at) < cutoff);
    }

    const page = Math.max(1, Number(q.page) || 1);
    const perPage = 25;
    return {
      total: summaries.length,
      page,
      per_page: perPage,
      clients: summaries.slice((page - 1) * perPage, page * perPage),
    };
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
    if (typeId && !get('SELECT id FROM application_types WHERE id = ? AND active = 1', typeId)) {
      throw new ApiError(400, 'That application type is not available.', 'bad_type');
    }

    if (!body.ignore_duplicates) {
      const duplicates = findDuplicates(client);
      if (duplicates.length) {
        ctx.status = 409;
        return { ok: false, code: 'possible_duplicate', message: 'Possible existing client found.', duplicates };
      }
    }

    const firstStage = get('SELECT * FROM stages WHERE active = 1 ORDER BY sort LIMIT 1');
    const created = tx(() => {
      const fileNumber = nextFileNumber();
      const res = run(
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
      const fileId = Number(res.lastInsertRowid);
      const primaryId = insertApplicant(fileId, { ...client, role: 'primary' });
      const coIds = [];
      for (const co of Array.isArray(body.co_applicants) ? body.co_applicants : []) {
        const fields = applicantFields(co);
        if (!fields.first_name || !fields.last_name) continue;
        if (fields.role === 'primary') fields.role = 'co_borrower';
        coIds.push({ id: insertApplicant(fileId, fields), invite: !!co.invite });
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
      for (const want of previewChecklist(typeId, client.employment_type, { fthb: bool(app.fthb) })) {
        if (!keptTypeIds.has(want.document_type_id)) {
          excludeFromChecklist(created.fileId, want.document_type_id, null, ctx.user.id);
          excludeFromChecklist(created.fileId, want.document_type_id, created.primaryId, ctx.user.id);
        }
      }
    }

    const { added } = syncChecklist(created.fileId, ctx.user.id);

    // Apply per-item customizations and add anything the rules did not cover.
    if (customChecklist) {
      for (const item of customChecklist.slice(0, 100)) {
        const docTypeId = intOrNull(item.document_type_id);
        if (!docTypeId) continue;
        const docType = get('SELECT * FROM document_types WHERE id = ?', docTypeId);
        if (!docType) continue;
        const requirement = item.requirement === 'optional' ? 'optional' : 'required';
        const message = item.instructions !== undefined ? str(item.instructions, 1000) : docType.description;
        const existing = get(
          'SELECT * FROM document_requests WHERE file_id = ? AND document_type_id = ? ORDER BY id LIMIT 1',
          created.fileId, docTypeId
        );
        if (existing) {
          run(
            'UPDATE document_requests SET requirement = ?, client_message = ?, due_date = ?, updated_at = ? WHERE id = ?',
            requirement, message, dateStr(item.due_date), now(), existing.id
          );
        } else {
          run(
            `INSERT INTO document_requests
               (file_id, applicant_id, document_type_id, status, requirement, source, due_date, client_message, expires_days, created_by, created_at, updated_at)
             VALUES (?, NULL, ?, 'required', ?, 'manual', ?, ?, ?, ?, ?, ?)`,
            created.fileId, docTypeId, requirement, dateStr(item.due_date), message,
            docType.default_expires_days ?? null, ctx.user.id, now(), now()
          );
        }
      }
    }

    activity(created.fileId, ctx.user, 'client_created', `Client file created (${created.fileNumber})`);
    const finalCount = get(
      'SELECT COUNT(*) AS n FROM document_requests WHERE file_id = ?', created.fileId
    ).n;
    if (finalCount) {
      activity(created.fileId, ctx.user, 'checklist_created', `Document checklist created (${finalCount} item${finalCount > 1 ? 's' : ''})`);
    }
    audit(ctx.user.id, 'client_created', 'client_file', created.fileId, ctx.ip);

    // Create the client's OneDrive folder tree in the background.
    require('../onedrive').queueFolderCreation(created.fileId);

    // Portal account + welcome email with temporary credentials. Automatic —
    // the broker never has to send this by hand — but the brokerage can turn
    // auto-send off in Settings → Notifications.
    const autoSend = getSetting('notifications', {}).auto_send_welcome !== false;
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

    return { ok: true, file: fileSummary(fileOrThrow(created.fileId)), invites };
  });

  // ------------------------------ File detail ------------------------------
  router.get('/api/broker/files/:id', requirePermission('clients.view'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const applicants = all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', file.id).map(applicantSummary);
    const type = file.application_type_id ? get('SELECT * FROM application_types WHERE id = ?', file.application_type_id) : null;
    return {
      file: {
        ...fileSummary(file),
        down_payment: file.down_payment,
        property_type: file.property_type,
        purpose: file.purpose,
        extra_info: file.extra_info,
        application_type: type ? type.name : null,
      },
      applicants,
      next_step: clientNextStep(file),
      attention: fileAttention(file),
      stage_history: all(
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

  router.patch('/api/broker/files/:id', requirePermission('clients.edit'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const b = ctx.body || {};
    const typeId = b.application_type_id !== undefined ? intOrNull(b.application_type_id) : file.application_type_id;
    if (typeId && !get('SELECT id FROM application_types WHERE id = ?', typeId)) {
      throw new ApiError(400, 'That application type is not available.', 'bad_type');
    }
    run(
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
    const sync = syncChecklist(file.id, ctx.user.id);
    activity(file.id, ctx.user, 'file_updated', 'Application details updated');
    audit(ctx.user.id, 'client_updated', 'client_file', file.id, ctx.ip);
    if (sync.added || sync.removed) {
      activity(file.id, ctx.user, 'checklist_updated', `Document checklist updated (${sync.added} added, ${sync.removed} removed)`);
    }
    return { ok: true, checklist_sync: sync };
  });

  router.post('/api/broker/files/:id/stage', requirePermission('stage.change'), async (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    return changeStage(file, ctx.body && ctx.body.stage_id, ctx.body && ctx.body.note, ctx.user, ctx);
  });

  router.post('/api/broker/files/:id/status', requirePermission('clients.archive'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const status = ctx.body && ctx.body.status;
    if (!['active', 'archived', 'completed', 'cancelled'].includes(status)) {
      throw new ApiError(400, 'That status is not available.', 'bad_status');
    }
    run('UPDATE client_files SET status = ?, updated_at = ? WHERE id = ?', status, now(), file.id);
    activity(file.id, ctx.user, 'status_changed', `File marked as ${status}`);
    audit(ctx.user.id, 'file_status_change', 'client_file', file.id, ctx.ip, { status });
    return { ok: true };
  });

  router.post('/api/broker/files/:id/assign', requirePermission('clients.edit'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const brokerId = intOrNull(ctx.body && ctx.body.broker_id);
    if (brokerId) {
      const broker = get("SELECT * FROM users WHERE id = ? AND role != 'client' AND status = 'active'", brokerId);
      if (!broker) throw new ApiError(400, 'That team member was not found.', 'bad_user');
    }
    run('UPDATE client_files SET assigned_broker_id = ?, updated_at = ? WHERE id = ?', brokerId, now(), file.id);
    activity(file.id, ctx.user, 'assigned', brokerId ? 'File assigned to a team member' : 'File unassigned');
    if (brokerId && brokerId !== ctx.user.id) {
      notifyUser(brokerId, 'file_assigned', `A file was assigned to you`, `File ${file.file_number}`, file.id, `#/files/${file.id}`);
    }
    return { ok: true };
  });

  // ------------------------------ Applicants ------------------------------
  router.post('/api/broker/files/:id/applicants', requirePermission('clients.edit'), async (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const fields = applicantFields(ctx.body || {});
    if (!fields.first_name || !fields.last_name) {
      throw new ApiError(400, 'The applicant needs at least a first and last name.', 'missing_field');
    }
    if (fields.role === 'primary' && get("SELECT id FROM applicants WHERE file_id = ? AND role = 'primary'", file.id)) {
      fields.role = 'co_borrower';
    }
    const id = insertApplicant(file.id, fields);
    const sync = syncChecklist(file.id, ctx.user.id);
    activity(file.id, ctx.user, 'applicant_added', `${fields.first_name} ${fields.last_name} added to the file (${fields.role.replace('_', '-')})`);
    let invite = null;
    if (ctx.body && ctx.body.invite) {
      try {
        const inv = await inviteApplicant(id, ctx.user, ctx);
        invite = { username: inv.username, temporary_password: inv.temporary_password, portal_link: inv.portal_link };
      } catch (err) { invite = { error: err.message }; }
    }
    return { ok: true, applicant_id: id, checklist_sync: sync, invite };
  });

  router.patch('/api/broker/applicants/:id', requirePermission('clients.edit'), (ctx) => {
    const applicant = get('SELECT * FROM applicants WHERE id = ?', Number(ctx.params.id));
    if (!applicant) throw new ApiError(404, 'Applicant not found.', 'not_found');
    const merged = applicantFields({ ...applicant, ...(ctx.body || {}) });
    if (applicant.role === 'primary') merged.role = 'primary';
    run(
      `UPDATE applicants SET role = ?, first_name = ?, middle_name = ?, last_name = ?, preferred_name = ?,
         email = ?, phone = ?, dob = ?, address = ?, preferred_contact = ?, employment_type = ?,
         employer_name = ?, job_title = ?, employment_notes = ?, updated_at = ?
       WHERE id = ?`,
      merged.role, merged.first_name, merged.middle_name, merged.last_name, merged.preferred_name,
      merged.email, merged.phone, merged.dob, merged.address, merged.preferred_contact,
      merged.employment_type, merged.employer_name, merged.job_title, merged.employment_notes,
      now(), applicant.id
    );
    const sync = syncChecklist(applicant.file_id, ctx.user.id);
    activity(applicant.file_id, ctx.user, 'applicant_updated', `${merged.first_name} ${merged.last_name}'s details updated`);
    audit(ctx.user.id, 'applicant_updated', 'applicant', applicant.id, ctx.ip);
    return { ok: true, checklist_sync: sync };
  });

  router.delete('/api/broker/applicants/:id', requirePermission('clients.edit'), (ctx) => {
    const applicant = get('SELECT * FROM applicants WHERE id = ?', Number(ctx.params.id));
    if (!applicant) throw new ApiError(404, 'Applicant not found.', 'not_found');
    if (applicant.role === 'primary') {
      throw new ApiError(400, 'The primary applicant cannot be removed from the file.', 'primary_locked');
    }
    const uploads = get(
      `SELECT v.id FROM document_versions v JOIN document_requests r ON r.id = v.request_id
        WHERE r.applicant_id = ? LIMIT 1`,
      applicant.id
    );
    if (uploads) {
      throw new ApiError(400, 'This applicant has uploaded documents on file, so they cannot be removed. Archive the file instead if it is no longer proceeding.', 'has_documents');
    }
    run('DELETE FROM document_requests WHERE applicant_id = ?', applicant.id);
    run('DELETE FROM applicants WHERE id = ?', applicant.id);
    syncChecklist(applicant.file_id, ctx.user.id);
    activity(applicant.file_id, ctx.user, 'applicant_removed', `${fullName(applicant)} removed from the file`);
    audit(ctx.user.id, 'applicant_removed', 'applicant', applicant.id, ctx.ip);
    return { ok: true };
  });

  router.post('/api/broker/applicants/:id/invite', requirePermission('clients.edit'), async (ctx) => {
    const applicant = get('SELECT * FROM applicants WHERE id = ?', Number(ctx.params.id));
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
  router.get('/api/broker/files/:id/documents', requirePermission('documents.view'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    return { requests: fileRequests(file.id, { includeInternal: true }), progress: checklistProgress(file.id) };
  });

  router.post('/api/broker/files/:id/requests', requirePermission('documents.request'), async (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const b = ctx.body || {};
    const docType = get('SELECT * FROM document_types WHERE id = ?', intOrNull(b.document_type_id));
    if (!docType) throw new ApiError(400, 'Please choose a document type.', 'bad_type');
    let applicantId = intOrNull(b.applicant_id);
    if (applicantId && !get('SELECT id FROM applicants WHERE id = ? AND file_id = ?', applicantId, file.id)) {
      throw new ApiError(400, 'That applicant is not on this file.', 'bad_applicant');
    }
    const res = run(
      `INSERT INTO document_requests
         (file_id, applicant_id, document_type_id, status, requirement, source, due_date, client_message, internal_note,
          expires_days, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'required', ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
      file.id, applicantId, docType.id,
      b.requirement === 'optional' ? 'optional' : 'required',
      dateStr(b.due_date), str(b.client_message, 1000), str(b.internal_note, 1000),
      intOrNull(b.expires_days), ctx.user.id, now(), now()
    );
    const requestId = Number(res.lastInsertRowid);
    activity(file.id, ctx.user, 'document_requested', `${docType.name} requested`, {}, true);
    audit(ctx.user.id, 'document_requested', 'document_request', requestId, ctx.ip);

    notifyClientsForFile(file.id, 'document_requested', `New document requested: ${docType.name}`, str(b.client_message, 300), '#/documents');
    if (b.send_email !== false) {
      const users = all(
        `SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id
          WHERE a.file_id = ? ${applicantId ? 'AND a.id = ' + applicantId : ''} GROUP BY u.id`,
        file.id
      );
      for (const u of users) {
        await sendTemplate('document_requested', {
          toEmail: u.email, toName: `${u.first_name} ${u.last_name}`.trim(), userId: u.id, fileId: file.id,
          vars: { client_first_name: u.first_name, client_last_name: u.last_name, document_name: docType.name },
        });
      }
      if (users.length) activity(file.id, null, 'email_sent', `Document request email sent (${docType.name})`);
    }
    return { ok: true, request: requestFull(requestId, { includeInternal: true }) };
  });

  router.patch('/api/broker/requests/:id', requirePermission('documents.request'), (ctx) => {
    const request = get('SELECT * FROM document_requests WHERE id = ?', Number(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    const b = ctx.body || {};
    let docTypeId = request.document_type_id;
    if (b.document_type_id !== undefined) {
      const t = get('SELECT id FROM document_types WHERE id = ?', intOrNull(b.document_type_id));
      if (!t) throw new ApiError(400, 'That document type is not available.', 'bad_type');
      docTypeId = t.id;
    }
    let applicantId = request.applicant_id;
    if (b.applicant_id !== undefined) {
      applicantId = intOrNull(b.applicant_id);
      if (applicantId && !get('SELECT id FROM applicants WHERE id = ? AND file_id = ?', applicantId, request.file_id)) {
        throw new ApiError(400, 'That applicant is not on this file.', 'bad_applicant');
      }
    }
    run(
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
      const docType = get('SELECT * FROM document_types WHERE id = ?', docTypeId);
      activity(request.file_id, ctx.user, 'document_classified', `A document was reclassified as ${docType.name}`);
      audit(ctx.user.id, 'document_classified', 'document_request', request.id, ctx.ip);
    }
    return { ok: true, request: requestFull(request.id, { includeInternal: true }) };
  });

  router.delete('/api/broker/requests/:id', requirePermission('documents.request'), (ctx) => {
    const request = get('SELECT * FROM document_requests WHERE id = ?', Number(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    // Removing a rule-generated item is a decision about THIS client only:
    // record an exclusion so re-syncing the global rules never re-adds it,
    // while every other client keeps the same default.
    if (request.source === 'rule') {
      excludeFromChecklist(request.file_id, request.document_type_id, request.applicant_id ?? null, ctx.user.id);
    }
    const hasUploads = get('SELECT id FROM document_versions WHERE request_id = ? LIMIT 1', request.id);
    if (hasUploads) {
      // History is never silently destroyed — waive instead of delete.
      run("UPDATE document_requests SET status = 'waived', updated_at = ? WHERE id = ?", now(), request.id);
      activity(request.file_id, ctx.user, 'document_waived', 'A document request was marked as no longer needed');
      return { ok: true, waived: true };
    }
    run('DELETE FROM document_requests WHERE id = ?', request.id);
    activity(request.file_id, ctx.user, 'document_request_removed', 'A document request was removed for this client');
    return { ok: true };
  });

  /**
   * Wizard step 3: default checklist for a service + employment status,
   * computed from the global rules. Read-only — nothing is written, and no
   * client record needs to exist yet.
   */
  router.get('/api/broker/checklist-preview', requirePermission('clients.create'), (ctx) => {
    const documents = previewChecklist(
      intOrNull(ctx.query.application_type_id),
      str(ctx.query.employment_type, 50),
      { fthb: ctx.query.fthb === '1' || ctx.query.fthb === 'true' }
    );
    return { documents };
  });

  /** Restore a previously removed rule item for this client. */
  router.post('/api/broker/files/:id/checklist/restore', requirePermission('documents.request'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const docTypeId = intOrNull(ctx.body && ctx.body.document_type_id);
    if (!docTypeId) throw new ApiError(400, 'Choose a document to restore.', 'missing_field');
    const scopedApplicant = ctx.body && ctx.body.applicant_id !== undefined
      ? intOrNull(ctx.body.applicant_id)
      : undefined; // undefined = restore for the whole file
    unexcludeFromChecklist(file.id, docTypeId, scopedApplicant);
    const sync = syncChecklist(file.id, ctx.user.id);
    activity(file.id, ctx.user, 'checklist_updated', 'A removed document was restored to this checklist');
    return { ok: true, checklist_sync: sync };
  });

  /** Documents the broker removed for this client (so the UI can offer restore). */
  router.get('/api/broker/files/:id/checklist/exclusions', requirePermission('documents.view'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    return {
      exclusions: all(
        `SELECT e.*, dt.name AS document_name, dt.category
           FROM checklist_exclusions e JOIN document_types dt ON dt.id = e.document_type_id
          WHERE e.file_id = ? ORDER BY dt.name`,
        file.id
      ),
    };
  });

  router.post('/api/broker/requests/:id/review', requirePermission('documents.review'), async (ctx) => {
    const request = get('SELECT * FROM document_requests WHERE id = ?', Number(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    const file = fileOrThrow(request.file_id);
    const docType = get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
    const b = ctx.body || {};
    const action = b.action;
    if (!['approve', 'reject', 'request_replacement'].includes(action)) {
      throw new ApiError(400, 'Unknown review action.', 'bad_action');
    }
    const version = request.current_version_id
      ? get('SELECT * FROM document_versions WHERE id = ?', request.current_version_id)
      : get('SELECT * FROM document_versions WHERE request_id = ? ORDER BY version DESC LIMIT 1', request.id);
    if (!version) throw new ApiError(400, 'There is no uploaded document to review yet.', 'no_upload');

    const clientNote = str(b.client_note, 1000);
    const internalNote = str(b.internal_note, 1000);
    if (action !== 'approve' && !clientNote) {
      throw new ApiError(400, 'Please tell the client what to fix — add a short client-facing note.', 'note_required');
    }

    const versionStatus = action === 'approve' ? 'approved' : 'rejected';
    const requestStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'replacement_requested';
    run(
      `UPDATE document_versions SET status = ?, review_note_client = ?, review_note_internal = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ?`,
      versionStatus, clientNote, internalNote, ctx.user.id, now(), version.id
    );
    const expiresAt = action === 'approve' && request.expires_days ? addDays(now(), request.expires_days) : null;
    run(
      'UPDATE document_requests SET status = ?, expires_at = ?, updated_at = ? WHERE id = ?',
      requestStatus, expiresAt, now(), request.id
    );

    const verb = action === 'approve' ? 'approved' : 'not approved';
    activity(file.id, ctx.user, `document_${action === 'approve' ? 'approved' : 'rejected'}`, `${docType.name} ${verb}${clientNote ? ` — "${clientNote}"` : ''}`, {}, true);
    audit(ctx.user.id, `document_${action === 'approve' ? 'approved' : 'rejected'}`, 'document_version', version.id, ctx.ip);

    if (action === 'approve') {
      notifyClientsForFile(file.id, 'document_approved', `${docType.name} approved`, '', '#/documents');
    } else {
      notifyClientsForFile(file.id, 'document_rejected', `${docType.name} needs a replacement`, clientNote, '#/documents');
    }
    if (b.send_email !== false) {
      const users = all(
        `SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id WHERE a.file_id = ? GROUP BY u.id`,
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

    const progress = checklistProgress(file.id);
    if (progress.complete) {
      const { notifyStaffForFile } = require('../notify');
      notifyStaffForFile(file, 'checklist_complete', 'Document checklist complete', `Every required document on ${file.file_number} is approved.`, `#/files/${file.id}/documents`);
      activity(file.id, null, 'checklist_complete', 'Every required document has been approved', {}, true);
    }
    return { ok: true, request: requestFull(request.id, { includeInternal: true }), progress };
  });

  /** Retry a failed AI review (internal-only result). */
  router.post('/api/broker/ai-reviews/:id/retry', requirePermission('documents.review'), (ctx) => {
    const { get: dbGet } = require('../db');
    const review = dbGet('SELECT * FROM ai_reviews WHERE id = ?', Number(ctx.params.id));
    if (!review) throw new ApiError(404, 'That AI review was not found.', 'not_found');
    if (!aiReview.isEnabled()) {
      throw new ApiError(400, 'AI document review is not configured on this server.', 'ai_disabled');
    }
    aiReview.retryReview(review.id);
    return { ok: true };
  });

  /**
   * Email the client a single summary of everything still outstanding.
   * The same items are already visible in their portal — this is the
   * notification layer, not the source of truth.
   */
  router.post('/api/broker/files/:id/request-outstanding', requirePermission('documents.request'), async (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const outstanding = all(
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
    const users = all(
      `SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id WHERE a.file_id = ? GROUP BY u.id`,
      file.id
    );
    if (users.length === 0) {
      throw new ApiError(400, 'This client does not have portal access yet — create their account first.', 'no_recipient');
    }
    const list = outstanding
      .map((r) => `- ${r.document_name}${r.client_message ? ` (${r.client_message})` : ''}`)
      .join('\n');
    for (const u of users) {
      notifyUser(u.id, 'documents_outstanding', 'Documents still needed', `${outstanding.length} item${outstanding.length > 1 ? 's' : ''} outstanding`, file.id, '#/documents');
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
    activity(file.id, ctx.user, 'email_sent', `Outstanding documents email sent (${outstanding.length} item${outstanding.length > 1 ? 's' : ''})`);
    return { ok: true, sent: users.length, documents: outstanding.length };
  });

  router.post('/api/broker/requests/:id/remind', requirePermission('documents.request'), async (ctx) => {
    const request = get('SELECT * FROM document_requests WHERE id = ?', Number(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    if (!OUTSTANDING_STATUSES.includes(request.status)) {
      throw new ApiError(400, 'This document has already been received, so no reminder is needed.', 'not_outstanding');
    }
    const sent = await sendDocumentReminder(request, { manual: true, actor: ctx.user });
    if (!sent) throw new ApiError(400, 'No portal user is connected to this document yet — invite the applicant first.', 'no_recipient');
    return { ok: true };
  });

  router.post('/api/broker/requests/:id/upload', requirePermission('documents.upload'), async (ctx) => {
    const request = get('SELECT * FROM document_requests WHERE id = ?', Number(ctx.params.id));
    if (!request) throw new ApiError(404, 'Document request not found.', 'not_found');
    const file = fileOrThrow(request.file_id);
    const filename = str(ctx.req.headers['x-filename'] ? decodeURIComponent(ctx.req.headers['x-filename']) : '', 300);
    const saved = await saveRequestBody(ctx.req, filename);
    const docType = get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
    const versionId = recordVersion(request, saved, filename, ctx.user);
    activity(file.id, ctx.user, 'document_uploaded', `${docType.name} uploaded by the brokerage`, {}, true);
    audit(ctx.user.id, 'document_uploaded', 'document_version', versionId, ctx.ip);
    return { ok: true, request: requestFull(request.id, { includeInternal: true }) };
  }).raw();

  router.get('/api/broker/versions/:id/file', requirePermission('documents.view'), (ctx) => {
    const version = get('SELECT * FROM document_versions WHERE id = ?', Number(ctx.params.id));
    if (!version) throw new ApiError(404, 'File not found.', 'not_found');
    const wantsDownload = ctx.query.disposition === 'attachment';
    if (wantsDownload && !hasPermission(ctx.user, 'documents.download')) {
      throw new ApiError(403, 'You do not have permission to download documents.', 'forbidden');
    }
    const { stream, size } = openStored(version.stored_name);
    audit(ctx.user.id, wantsDownload ? 'document_downloaded' : 'document_previewed', 'document_version', version.id, ctx.ip);
    ctx.res.writeHead(200, {
      'Content-Type': version.mime,
      'Content-Length': size,
      'Content-Disposition': `${wantsDownload ? 'attachment' : 'inline'}; filename="${(version.display_name || version.original_name).replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    stream.pipe(ctx.res);
    return HANDLED;
  });

  // ------------------------------ Messages ------------------------------
  router.get('/api/broker/files/:id/messages', requirePermission('clients.view'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const after = intOrNull(ctx.query.after) || 0;
    const search = str(ctx.query.q, 100).toLowerCase();
    let rows = all(
      `SELECT m.*, u.first_name || ' ' || u.last_name AS sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.file_id = ? AND m.id > ? ORDER BY m.id LIMIT 200`,
      file.id, after
    );
    if (search) rows = rows.filter((m) => m.body.toLowerCase().includes(search));
    return { messages: rows.map(messageRow) };
  });

  router.post('/api/broker/files/:id/messages', requirePermission('chat.send'), async (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const body = str(ctx.body && ctx.body.body, 4000);
    if (!body) throw new ApiError(400, 'The message was empty.', 'empty');
    const res = run(
      `INSERT INTO messages (file_id, sender_id, sender_kind, body, created_at, read_by_staff_at)
       VALUES (?, ?, 'staff', ?, ?, ?)`,
      file.id, ctx.user.id, body, now(), now()
    );
    touchFile(file.id);
    audit(ctx.user.id, 'message_sent', 'client_file', file.id, ctx.ip);
    notifyClientsForFile(file.id, 'new_message', `New message from your broker`, body.slice(0, 120), '#/messages');
    if (ctx.body && ctx.body.send_email) {
      const users = all(
        `SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id WHERE a.file_id = ? GROUP BY u.id`,
        file.id
      );
      for (const u of users) {
        await sendTemplate('new_message', {
          toEmail: u.email, toName: `${u.first_name} ${u.last_name}`.trim(), userId: u.id, fileId: file.id,
          vars: { client_first_name: u.first_name, client_last_name: u.last_name },
        });
      }
    }
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  router.post('/api/broker/files/:id/messages/read', requirePermission('clients.view'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    run(
      "UPDATE messages SET read_by_staff_at = ? WHERE file_id = ? AND sender_kind = 'client' AND read_by_staff_at IS NULL",
      now(), file.id
    );
    return { ok: true };
  });

  router.patch('/api/broker/messages/:id', requirePermission('chat.send'), (ctx) => {
    const message = get('SELECT * FROM messages WHERE id = ?', Number(ctx.params.id));
    if (!message || message.sender_id !== ctx.user.id) {
      throw new ApiError(404, 'Message not found.', 'not_found');
    }
    const body = str(ctx.body && ctx.body.body, 4000);
    if (!body) throw new ApiError(400, 'The message was empty.', 'empty');
    run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', body, now(), message.id);
    return { ok: true };
  });

  // ------------------------------ Tasks ------------------------------
  router.get('/api/broker/tasks', requirePermission('tasks.manage'), (ctx) => {
    const q = ctx.query;
    const where = [];
    const params = [];
    if (q.file_id) { where.push('t.file_id = ?'); params.push(Number(q.file_id)); }
    if (q.assigned_to) { where.push('t.assigned_to = ?'); params.push(Number(q.assigned_to)); }
    if (q.status) { where.push('t.status = ?'); params.push(str(q.status, 20)); }
    else if (q.filter !== 'all') { where.push("t.status IN ('pending','in_progress')"); }
    if (q.filter === 'today') { where.push('t.due_date = ?'); params.push(today()); }
    if (q.filter === 'overdue') { where.push('t.due_date < ?'); params.push(today()); }
    if (q.filter === 'upcoming') { where.push('(t.due_date IS NULL OR t.due_date >= ?)'); params.push(today()); }
    const rows = all(
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

  router.post('/api/broker/tasks', requirePermission('tasks.manage'), (ctx) => {
    const b = ctx.body || {};
    const title = str(b.title, 200);
    if (!title) throw new ApiError(400, 'The task needs a title.', 'missing_field');
    let fileId = intOrNull(b.file_id);
    if (fileId) fileOrThrow(fileId);
    const assignedTo = intOrNull(b.assigned_to) || ctx.user.id;
    const res = run(
      `INSERT INTO tasks (file_id, title, description, due_date, priority, status, assigned_to, source, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, 'manual', ?, ?, ?)`,
      fileId, title, str(b.description, 2000), dateStr(b.due_date),
      ['low', 'normal', 'high'].includes(b.priority) ? b.priority : 'normal',
      assignedTo, ctx.user.id, now(), now()
    );
    if (fileId) activity(fileId, ctx.user, 'task_created', `Task created: ${title}`);
    if (assignedTo !== ctx.user.id) {
      notifyUser(assignedTo, 'task_assigned', `New task: ${title}`, b.due_date ? `Due ${b.due_date}` : '', fileId, `task:${Number(res.lastInsertRowid)}`);
    }
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  router.patch('/api/broker/tasks/:id', requirePermission('tasks.manage'), (ctx) => {
    const task = get('SELECT * FROM tasks WHERE id = ?', Number(ctx.params.id));
    if (!task) throw new ApiError(404, 'Task not found.', 'not_found');
    const b = ctx.body || {};
    const status = ['pending', 'in_progress', 'completed', 'cancelled'].includes(b.status) ? b.status : task.status;
    run(
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
      activity(task.file_id, ctx.user, 'task_completed', `Task completed: ${task.title}`);
    }
    return { ok: true };
  });

  // ------------------------------ Notes ------------------------------
  router.get('/api/broker/files/:id/notes', requirePermission('notes.manage'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    return {
      notes: all(
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

  router.post('/api/broker/files/:id/notes', requirePermission('notes.manage'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const body = str(ctx.body && ctx.body.body, 4000);
    if (!body) throw new ApiError(400, 'The note was empty.', 'empty');
    const res = run(
      'INSERT INTO notes (file_id, body, pinned, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      file.id, body, bool(ctx.body.pinned), ctx.user.id, now()
    );
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  router.patch('/api/broker/notes/:id', requirePermission('notes.manage'), (ctx) => {
    const note = get('SELECT * FROM notes WHERE id = ?', Number(ctx.params.id));
    if (!note) throw new ApiError(404, 'Note not found.', 'not_found');
    const b = ctx.body || {};
    run(
      'UPDATE notes SET body = ?, pinned = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      b.body !== undefined ? str(b.body, 4000) || note.body : note.body,
      b.pinned !== undefined ? bool(b.pinned) : note.pinned,
      ctx.user.id, now(), note.id
    );
    return { ok: true };
  });

  router.delete('/api/broker/notes/:id', requirePermission('notes.manage'), (ctx) => {
    const note = get('SELECT * FROM notes WHERE id = ?', Number(ctx.params.id));
    if (!note) throw new ApiError(404, 'Note not found.', 'not_found');
    run('DELETE FROM notes WHERE id = ?', note.id);
    audit(ctx.user.id, 'note_deleted', 'note', note.id, ctx.ip);
    return { ok: true };
  });

  // ------------------------------ Activity & emails ------------------------------
  router.get('/api/broker/files/:id/activity', requirePermission('clients.view'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    return {
      activity: all('SELECT * FROM activity_log WHERE file_id = ? ORDER BY id DESC LIMIT 200', file.id),
    };
  });

  router.get('/api/broker/files/:id/emails', requirePermission('emails.view'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    return {
      emails: all(
        'SELECT id, to_email, to_name, template_key, subject, status, created_at, sent_at FROM email_log WHERE file_id = ? ORDER BY id DESC LIMIT 100',
        file.id
      ),
    };
  });

  router.get('/api/broker/emails/:id', requirePermission('emails.view'), (ctx) => {
    const email = get('SELECT * FROM email_log WHERE id = ?', Number(ctx.params.id));
    if (!email) throw new ApiError(404, 'Email not found.', 'not_found');
    return { email };
  });

  // ------------------------------ Notifications ------------------------------
  router.get('/api/broker/notifications', requireStaff, (ctx) => {
    const unreadOnly = ctx.query.unread === '1';
    return {
      notifications: all(
        `SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 100`,
        ctx.user.id
      ),
    };
  });

  router.post('/api/broker/notifications/read', requireStaff, (ctx) => {
    const b = ctx.body || {};
    if (b.all) {
      run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), ctx.user.id);
    } else if (Array.isArray(b.ids)) {
      for (const id of b.ids.slice(0, 100)) {
        run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', now(), Number(id), ctx.user.id);
      }
    }
    return { ok: true };
  });

  // ------------------------------ Search ------------------------------
  router.get('/api/broker/search', requirePermission('clients.view'), (ctx) => {
    const q = str(ctx.query.q, 100).toLowerCase();
    if (q.length < 2) return { results: [] };
    const like = `%${q}%`;
    const rows = all(
      `SELECT DISTINCT f.id FROM client_files f
         JOIN applicants a ON a.file_id = f.id
        WHERE lower(a.first_name || ' ' || a.last_name) LIKE ?
           OR lower(a.preferred_name) LIKE ?
           OR lower(a.email) LIKE ?
           OR replace(replace(replace(a.phone, '-', ''), ' ', ''), '(', '') LIKE ?
           OR lower(f.file_number) LIKE ?
           OR lower(f.property_address) LIKE ?
        LIMIT 20`,
      like, like, like, `%${phoneDigits(q) || q}%`, like, like
    );
    return { results: rows.map((r) => fileSummary(get('SELECT * FROM client_files WHERE id = ?', r.id))) };
  });

  // ------------------------------ Reports ------------------------------
  router.get('/api/broker/reports', requirePermission('reports.view'), (ctx) => {
    const year = new Date().getUTCFullYear();
    const byStage = all(
      `SELECT s.id, s.name, s.color, COUNT(f.id) AS n
         FROM stages s LEFT JOIN client_files f ON f.stage_id = s.id AND f.status = 'active'
        WHERE s.active = 1 GROUP BY s.id ORDER BY s.sort`
    );
    const outstandingDocs = get(
      `SELECT COUNT(*) AS n FROM document_requests r JOIN client_files f ON f.id = r.file_id
        WHERE f.status = 'active' AND r.requirement = 'required'
          AND r.status IN (${OUTSTANDING_STATUSES.map(() => '?').join(',')})`,
      ...OUTSTANDING_STATUSES
    ).n;
    const awaitingReview = get(
      `SELECT COUNT(*) AS n FROM document_requests r JOIN client_files f ON f.id = r.file_id
        WHERE f.status = 'active' AND r.status IN ('uploaded','under_review')`
    ).n;
    const funded = get(
      `SELECT COUNT(*) AS n FROM stage_history h JOIN stages s ON s.id = h.to_stage_id
        WHERE s.key = 'funded' AND h.changed_at >= ?`, `${year}-01-01`
    ).n;
    const cancelled = get(`SELECT COUNT(*) AS n FROM client_files WHERE status = 'cancelled'`).n;
    const upcomingClosings = all(
      `SELECT f.id, f.file_number, f.closing_date FROM client_files f
        WHERE f.status = 'active' AND f.closing_date IS NOT NULL AND f.closing_date BETWEEN ? AND ?
        ORDER BY f.closing_date LIMIT 20`,
      today(), addDays(now(), 45).slice(0, 10)
    ).map((f) => ({ ...fileSummary(get('SELECT * FROM client_files WHERE id = ?', f.id)) }));
    const overdueFollowups = get(
      `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending','in_progress') AND due_date < ?`, today()
    ).n;
    // Average days the current active files have spent in their current stage.
    const stageAges = all(
      `SELECT f.id, MAX(h.changed_at) AS entered FROM client_files f
         JOIN stage_history h ON h.file_id = f.id AND h.to_stage_id = f.stage_id
        WHERE f.status = 'active' GROUP BY f.id`
    );
    const avgDaysInStage = stageAges.length
      ? Math.round(stageAges.reduce((s, r) => s + (Date.now() - Date.parse(r.entered)) / 86400000, 0) / stageAges.length)
      : null;

    return {
      active_clients: get(`SELECT COUNT(*) AS n FROM client_files WHERE status = 'active'`).n,
      by_stage: byStage,
      documents_outstanding: outstandingDocs,
      documents_awaiting_review: awaitingReview,
      funded_this_year: funded,
      cancelled_total: cancelled,
      upcoming_closings: upcomingClosings,
      overdue_followups: overdueFollowups,
      avg_days_in_stage: avgDaysInStage,
    };
  });

  // ------------------------------ Bulk actions ------------------------------
  router.post('/api/broker/bulk', requireStaff, async (ctx) => {
    const b = ctx.body || {};
    const action = b.action;
    if (action === 'remind') {
      requirePermission('documents.request')(ctx);
      let sent = 0;
      for (const fileId of (b.file_ids || []).slice(0, 100)) {
        const requests = all(
          `SELECT * FROM document_requests WHERE file_id = ? AND requirement = 'required'
            AND status IN (${OUTSTANDING_STATUSES.map(() => '?').join(',')})`,
          Number(fileId), ...OUTSTANDING_STATUSES
        );
        for (const request of requests) {
          if (await sendDocumentReminder(request, { actor: ctx.user })) sent += 1;
        }
      }
      return { ok: true, sent };
    }
    if (action === 'assign') {
      requirePermission('clients.edit')(ctx);
      const brokerId = intOrNull(b.broker_id);
      if (brokerId && !get("SELECT id FROM users WHERE id = ? AND role != 'client'", brokerId)) {
        throw new ApiError(400, 'That team member was not found.', 'bad_user');
      }
      let updated = 0;
      for (const fileId of (b.file_ids || []).slice(0, 100)) {
        const file = get('SELECT * FROM client_files WHERE id = ?', Number(fileId));
        if (!file) continue;
        run('UPDATE client_files SET assigned_broker_id = ?, updated_at = ? WHERE id = ?', brokerId, now(), file.id);
        activity(file.id, ctx.user, 'assigned', 'File reassigned (bulk action)');
        updated += 1;
      }
      return { ok: true, updated };
    }
    if (action === 'task_status') {
      requirePermission('tasks.manage')(ctx);
      const status = ['pending', 'in_progress', 'completed', 'cancelled'].includes(b.status) ? b.status : null;
      if (!status) throw new ApiError(400, 'Choose a status for the selected tasks.', 'bad_status');
      let updated = 0;
      for (const taskId of (b.task_ids || []).slice(0, 200)) {
        const res = run(
          'UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?',
          status, now(), status === 'completed' ? now() : null, Number(taskId)
        );
        updated += res.changes;
      }
      return { ok: true, updated };
    }
    throw new ApiError(400, 'Unknown bulk action.', 'bad_action');
  });

  // ------------------------------ Consents ------------------------------
  router.get('/api/broker/files/:id/consents', requirePermission('clients.view'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    return { consents: all('SELECT * FROM consents WHERE file_id = ? ORDER BY id DESC', file.id) };
  });

  router.post('/api/broker/files/:id/consents', requirePermission('clients.edit'), (ctx) => {
    const file = fileOrThrow(ctx.params.id);
    const form = get('SELECT * FROM consent_forms WHERE id = ? AND active = 1', intOrNull(ctx.body && ctx.body.form_id));
    if (!form) throw new ApiError(400, 'Choose an active consent form. Forms are configured in Settings.', 'bad_form');
    let applicantId = intOrNull(ctx.body && ctx.body.applicant_id);
    if (applicantId && !get('SELECT id FROM applicants WHERE id = ? AND file_id = ?', applicantId, file.id)) {
      throw new ApiError(400, 'That applicant is not on this file.', 'bad_applicant');
    }
    const res = run(
      `INSERT INTO consents (file_id, applicant_id, form_id, form_title, form_version, form_body_snapshot, status, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
      file.id, applicantId, form.id, form.title, form.version, form.body, ctx.user.id, now()
    );
    activity(file.id, ctx.user, 'consent_requested', `Consent requested: ${form.title}`, {}, true);
    notifyClientsForFile(file.id, 'consent_requested', `Please review: ${form.title}`, '', '#/home');
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  // ------------------------------ Staff & audit ------------------------------
  router.get('/api/broker/staff', requireStaff, () => ({ staff: staffList() }));

  router.get('/api/broker/audit', requirePermission('audit.view'), (ctx) => {
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const perPage = 50;
    const rows = all(
      `SELECT a.*, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      perPage, (page - 1) * perPage
    );
    return { page, audit: rows };
  });
}

// Shared by broker + client upload endpoints.
function recordVersion(request, saved, filename, uploader) {
  const last = get('SELECT MAX(version) AS v FROM document_versions WHERE request_id = ?', request.id);
  const versionNumber = ((last && last.v) || 0) + 1;
  // A superseded upload that was never reviewed becomes "replaced"; reviewed
  // versions keep their final status so history stays truthful.
  if (request.current_version_id) {
    run(
      "UPDATE document_versions SET status = 'replaced' WHERE id = ? AND status = 'uploaded'",
      request.current_version_id
    );
  }
  const res = run(
    `INSERT INTO document_versions (request_id, version, original_name, stored_name, mime, size, status, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`,
    request.id, versionNumber, filename || `document.${saved.ext}`, saved.storedName, saved.mime, saved.size, uploader.id, now()
  );
  const versionId = Number(res.lastInsertRowid);
  run(
    "UPDATE document_requests SET status = 'uploaded', current_version_id = ?, expires_at = NULL, updated_at = ? WHERE id = ?",
    versionId, now(), request.id
  );
  // Both of these are queued, never awaited: the upload is already durable on
  // disk and the client's request returns immediately. The scheduler picks
  // them up and retries on failure, so a Claude or Graph outage can never
  // lose a document.
  aiReview.queueReview(versionId);
  require('../onedrive').queueVersionSync(versionId);
  return versionId;
}

module.exports = { register, fileOrThrow, fileSummary, recordVersion, afterClientUpload, inviteApplicant, changeStage };
