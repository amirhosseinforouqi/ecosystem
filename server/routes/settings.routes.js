'use strict';

const { run, get, all, getSetting, setSetting } = require('../db');
const { requireStaff, requirePermission, createAuthToken, STAFF_ROLES } = require('../auth');
const { ApiError, now, str, intOrNull, bool, isEmail, normalizeEmail, parseJsonSafe } = require('../util');
const { audit } = require('../log');
const { previewTemplate, sendTemplate, portalBaseUrl } = require('../emails');
const { publicUser } = require('../serialize');
const { ALL_PERMISSIONS } = require('../seed');

const manage = requirePermission('settings.manage');
const manageUsers = requirePermission('users.manage');

const EDITABLE_CONFIG_KEYS = [
  'brokerage', 'client_steps', 'reminders', 'automation', 'uploads', 'security', 'retention',
  'role_permissions', 'notifications',
];

function register(router) {
  // Reference data every staff screen needs (no special permission).
  router.get('/api/settings/meta', requireStaff, () => ({
    stages: all('SELECT * FROM stages ORDER BY sort'),
    application_types: all('SELECT * FROM application_types ORDER BY sort'),
    employment_statuses: all('SELECT * FROM employment_statuses ORDER BY sort'),
    document_types: all('SELECT * FROM document_types ORDER BY sort'),
    permissions: ALL_PERMISSIONS,
    staff_roles: STAFF_ROLES,
    integrations: {
      email_transport: process.env.EMAIL_TRANSPORT || 'log',
      microsoft_graph: require('../msgraph').isConfigured(),
      onedrive: require('../onedrive').isEnabled(),
      ai_review: require('../ai-review').isEnabled(),
    },
  }));

  // ------------------------------ Employment statuses ------------------------------
  router.post('/api/settings/employment-statuses', manage, (ctx) => {
    const name = str(ctx.body && ctx.body.name, 100);
    if (!name) throw new ApiError(400, 'The employment status needs a name.', 'missing_field');
    const maxSort = get('SELECT MAX(sort) AS m FROM employment_statuses');
    const key = str(ctx.body.key, 50) || `custom_${Date.now()}`;
    if (get('SELECT id FROM employment_statuses WHERE key = ?', key)) {
      throw new ApiError(400, 'An employment status with that key already exists.', 'duplicate');
    }
    const res = run(
      'INSERT INTO employment_statuses (key, name, sort) VALUES (?, ?, ?)',
      key, name, ((maxSort && maxSort.m) || 0) + 10
    );
    audit(ctx.user.id, 'employment_status_created', 'employment_status', Number(res.lastInsertRowid), ctx.ip);
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  router.patch('/api/settings/employment-statuses/:id', manage, (ctx) => {
    const row = get('SELECT * FROM employment_statuses WHERE id = ?', Number(ctx.params.id));
    if (!row) throw new ApiError(404, 'Employment status not found.', 'not_found');
    const b = ctx.body || {};
    run(
      'UPDATE employment_statuses SET name = ?, active = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 100) || row.name : row.name,
      b.active !== undefined ? bool(b.active) : row.active,
      row.id
    );
    audit(ctx.user.id, 'employment_status_updated', 'employment_status', row.id, ctx.ip);
    return { ok: true };
  });

  router.post('/api/settings/employment-statuses/reorder', manage, (ctx) => {
    const ids = Array.isArray(ctx.body && ctx.body.ids) ? ctx.body.ids : [];
    ids.forEach((id, i) => run('UPDATE employment_statuses SET sort = ? WHERE id = ?', (i + 1) * 10, Number(id)));
    return { ok: true };
  });

  router.post('/api/settings/application-types/reorder', manage, (ctx) => {
    const ids = Array.isArray(ctx.body && ctx.body.ids) ? ctx.body.ids : [];
    ids.forEach((id, i) => run('UPDATE application_types SET sort = ? WHERE id = ?', (i + 1) * 10, Number(id)));
    return { ok: true };
  });

  // ------------------------------ Config blobs ------------------------------
  router.get('/api/settings/config/:key', manage, (ctx) => {
    if (!EDITABLE_CONFIG_KEYS.includes(ctx.params.key)) throw new ApiError(404, 'Unknown setting.', 'not_found');
    return { key: ctx.params.key, value: getSetting(ctx.params.key, null) };
  });

  router.put('/api/settings/config/:key', manage, (ctx) => {
    const key = ctx.params.key;
    if (!EDITABLE_CONFIG_KEYS.includes(key)) throw new ApiError(404, 'Unknown setting.', 'not_found');
    const value = ctx.body && ctx.body.value;
    if (value === undefined || value === null || typeof value !== 'object') {
      throw new ApiError(400, 'A settings object is required.', 'bad_value');
    }
    setSetting(key, value);
    audit(ctx.user.id, 'settings_changed', 'settings', null, ctx.ip, { key });
    return { ok: true };
  });

  // ------------------------------ Stages ------------------------------
  router.post('/api/settings/stages', manage, (ctx) => {
    const b = ctx.body || {};
    const name = str(b.name, 100);
    if (!name) throw new ApiError(400, 'The stage needs a name.', 'missing_field');
    const maxSort = get('SELECT MAX(sort) AS m FROM stages');
    const res = run(
      `INSERT INTO stages (key, name, client_label, client_message, client_step, color, sort, active, send_email, email_template_key, create_task, task_title, is_terminal)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      `custom_${Date.now()}`, name, str(b.client_label, 100) || name, str(b.client_message, 500),
      Math.min(6, Math.max(1, intOrNull(b.client_step) || 1)), str(b.color, 20) || '#4f6ef7',
      ((maxSort && maxSort.m) || 0) + 10,
      bool(b.send_email), b.send_email ? str(b.email_template_key, 50) || 'stage_changed' : null,
      bool(b.create_task), str(b.task_title, 200), bool(b.is_terminal)
    );
    audit(ctx.user.id, 'stage_created', 'stage', Number(res.lastInsertRowid), ctx.ip);
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  router.patch('/api/settings/stages/:id', manage, (ctx) => {
    const stage = get('SELECT * FROM stages WHERE id = ?', Number(ctx.params.id));
    if (!stage) throw new ApiError(404, 'Stage not found.', 'not_found');
    const b = ctx.body || {};
    run(
      `UPDATE stages SET name = ?, client_label = ?, client_message = ?, client_step = ?, color = ?, active = ?,
         send_email = ?, email_template_key = ?, create_task = ?, task_title = ?, is_terminal = ? WHERE id = ?`,
      b.name !== undefined ? str(b.name, 100) || stage.name : stage.name,
      b.client_label !== undefined ? str(b.client_label, 100) : stage.client_label,
      b.client_message !== undefined ? str(b.client_message, 500) : stage.client_message,
      b.client_step !== undefined ? Math.min(6, Math.max(1, intOrNull(b.client_step) || 1)) : stage.client_step,
      b.color !== undefined ? str(b.color, 20) : stage.color,
      b.active !== undefined ? bool(b.active) : stage.active,
      b.send_email !== undefined ? bool(b.send_email) : stage.send_email,
      b.email_template_key !== undefined ? str(b.email_template_key, 50) || null : stage.email_template_key,
      b.create_task !== undefined ? bool(b.create_task) : stage.create_task,
      b.task_title !== undefined ? str(b.task_title, 200) : stage.task_title,
      b.is_terminal !== undefined ? bool(b.is_terminal) : stage.is_terminal,
      stage.id
    );
    audit(ctx.user.id, 'stage_updated', 'stage', stage.id, ctx.ip);
    return { ok: true };
  });

  router.post('/api/settings/stages/reorder', manage, (ctx) => {
    const ids = Array.isArray(ctx.body && ctx.body.ids) ? ctx.body.ids : [];
    ids.forEach((id, i) => run('UPDATE stages SET sort = ? WHERE id = ?', (i + 1) * 10, Number(id)));
    audit(ctx.user.id, 'stages_reordered', 'stage', null, ctx.ip);
    return { ok: true };
  });

  // ------------------------------ Application types ------------------------------
  router.post('/api/settings/application-types', manage, (ctx) => {
    const name = str(ctx.body && ctx.body.name, 100);
    if (!name) throw new ApiError(400, 'The application type needs a name.', 'missing_field');
    const maxSort = get('SELECT MAX(sort) AS m FROM application_types');
    const res = run(
      'INSERT INTO application_types (key, name, sort) VALUES (?, ?, ?)',
      `custom_${Date.now()}`, name, ((maxSort && maxSort.m) || 0) + 10
    );
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  router.patch('/api/settings/application-types/:id', manage, (ctx) => {
    const type = get('SELECT * FROM application_types WHERE id = ?', Number(ctx.params.id));
    if (!type) throw new ApiError(404, 'Application type not found.', 'not_found');
    const b = ctx.body || {};
    run(
      'UPDATE application_types SET name = ?, active = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 100) || type.name : type.name,
      b.active !== undefined ? bool(b.active) : type.active,
      type.id
    );
    return { ok: true };
  });

  // ------------------------------ Document types ------------------------------
  const DOC_CATEGORIES = ['identity', 'credit', 'income', 'property', 'financial', 'corporate', 'other'];

  router.post('/api/settings/document-types', manage, (ctx) => {
    const b = ctx.body || {};
    const name = str(b.name, 150);
    if (!name) throw new ApiError(400, 'The document type needs a name.', 'missing_field');
    const maxSort = get('SELECT MAX(sort) AS m FROM document_types');
    const res = run(
      `INSERT INTO document_types
         (key, name, category, description, sort, default_requirement, default_per_applicant, default_expires_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      `custom_${Date.now()}`, name,
      DOC_CATEGORIES.includes(b.category) ? b.category : 'other',
      str(b.description, 1000), ((maxSort && maxSort.m) || 0) + 10,
      b.default_requirement === 'optional' ? 'optional' : 'required',
      bool(b.default_per_applicant), intOrNull(b.default_expires_days)
    );
    audit(ctx.user.id, 'document_type_created', 'document_type', Number(res.lastInsertRowid), ctx.ip);
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  router.patch('/api/settings/document-types/:id', manage, (ctx) => {
    const type = get('SELECT * FROM document_types WHERE id = ?', Number(ctx.params.id));
    if (!type) throw new ApiError(404, 'Document type not found.', 'not_found');
    const b = ctx.body || {};
    run(
      `UPDATE document_types SET name = ?, category = ?, description = ?, active = ?,
         default_requirement = ?, default_per_applicant = ?, default_expires_days = ? WHERE id = ?`,
      b.name !== undefined ? str(b.name, 150) || type.name : type.name,
      b.category !== undefined && DOC_CATEGORIES.includes(b.category) ? b.category : type.category,
      b.description !== undefined ? str(b.description, 1000) : type.description,
      b.active !== undefined ? bool(b.active) : type.active,
      b.default_requirement === 'optional' ? 'optional' : b.default_requirement === 'required' ? 'required' : type.default_requirement,
      b.default_per_applicant !== undefined ? bool(b.default_per_applicant) : type.default_per_applicant,
      b.default_expires_days !== undefined ? intOrNull(b.default_expires_days) : type.default_expires_days,
      type.id
    );
    audit(ctx.user.id, 'document_type_updated', 'document_type', type.id, ctx.ip);
    return { ok: true };
  });

  /** Catalog search for the "+ Add Document" picker in the Add Client wizard. */
  router.get('/api/settings/document-types/search', requireStaff, (ctx) => {
    const q = str(ctx.query.q, 100).toLowerCase();
    let rows = all('SELECT * FROM document_types WHERE active = 1 ORDER BY sort');
    if (q) {
      rows = rows.filter(
        (r) => r.name.toLowerCase().includes(q) || (r.category || '').toLowerCase().includes(q)
      );
    }
    return { document_types: rows.slice(0, 50) };
  });

  // ------------------------------ Document rules ------------------------------
  router.get('/api/settings/rules', requireStaff, () => ({
    rules: all('SELECT * FROM document_rules ORDER BY id').map((rule) => ({
      ...rule,
      conditions: parseJsonSafe(rule.conditions, {}),
      items: all(
        `SELECT i.*, dt.name AS document_name FROM document_rule_items i
           JOIN document_types dt ON dt.id = i.document_type_id WHERE i.rule_id = ?`,
        rule.id
      ),
    })),
  }));

  function validConditions(input) {
    const c = input && typeof input === 'object' ? input : {};
    const out = {};
    if (Array.isArray(c.application_type_keys) && c.application_type_keys.length) {
      out.application_type_keys = c.application_type_keys.map((k) => str(k, 50)).filter(Boolean).slice(0, 50);
    }
    if (Array.isArray(c.employment_types) && c.employment_types.length) {
      out.employment_types = c.employment_types
        .filter((e) => ['employee', 'self_employed', 'retired', 'unemployed', 'other'].includes(e));
    }
    if (c.fthb === true) out.fthb = true;
    return out;
  }

  function replaceRuleItems(ruleId, items) {
    run('DELETE FROM document_rule_items WHERE rule_id = ?', ruleId);
    for (const item of (Array.isArray(items) ? items : []).slice(0, 50)) {
      const docType = get('SELECT id FROM document_types WHERE id = ?', intOrNull(item.document_type_id));
      if (!docType) continue;
      run(
        'INSERT INTO document_rule_items (rule_id, document_type_id, requirement, per_applicant, expires_days, note) VALUES (?, ?, ?, ?, ?, ?)',
        ruleId, docType.id,
        item.requirement === 'optional' ? 'optional' : 'required',
        bool(item.per_applicant), intOrNull(item.expires_days), str(item.note, 300)
      );
    }
  }

  router.post('/api/settings/rules', manage, (ctx) => {
    const b = ctx.body || {};
    const name = str(b.name, 150);
    if (!name) throw new ApiError(400, 'The rule needs a name.', 'missing_field');
    const res = run(
      'INSERT INTO document_rules (name, active, conditions, created_at, updated_at) VALUES (?, 1, ?, ?, ?)',
      name, JSON.stringify(validConditions(b.conditions)), now(), now()
    );
    const ruleId = Number(res.lastInsertRowid);
    replaceRuleItems(ruleId, b.items);
    audit(ctx.user.id, 'rule_created', 'document_rule', ruleId, ctx.ip);
    return { ok: true, id: ruleId };
  });

  router.patch('/api/settings/rules/:id', manage, (ctx) => {
    const rule = get('SELECT * FROM document_rules WHERE id = ?', Number(ctx.params.id));
    if (!rule) throw new ApiError(404, 'Rule not found.', 'not_found');
    const b = ctx.body || {};
    run(
      'UPDATE document_rules SET name = ?, active = ?, conditions = ?, updated_at = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 150) || rule.name : rule.name,
      b.active !== undefined ? bool(b.active) : rule.active,
      b.conditions !== undefined ? JSON.stringify(validConditions(b.conditions)) : rule.conditions,
      now(), rule.id
    );
    if (b.items !== undefined) replaceRuleItems(rule.id, b.items);
    audit(ctx.user.id, 'rule_updated', 'document_rule', rule.id, ctx.ip);
    return { ok: true };
  });

  router.delete('/api/settings/rules/:id', manage, (ctx) => {
    const rule = get('SELECT * FROM document_rules WHERE id = ?', Number(ctx.params.id));
    if (!rule) throw new ApiError(404, 'Rule not found.', 'not_found');
    run('DELETE FROM document_rules WHERE id = ?', rule.id);
    audit(ctx.user.id, 'rule_deleted', 'document_rule', rule.id, ctx.ip);
    return { ok: true };
  });

  // ------------------------------ Email templates ------------------------------
  router.get('/api/settings/templates', requireStaff, () => ({
    templates: all('SELECT * FROM email_templates ORDER BY key'),
  }));

  router.patch('/api/settings/templates/:key', manage, (ctx) => {
    const template = get('SELECT * FROM email_templates WHERE key = ?', str(ctx.params.key, 50));
    if (!template) throw new ApiError(404, 'Template not found.', 'not_found');
    const b = ctx.body || {};
    run(
      'UPDATE email_templates SET subject = ?, body = ?, active = ?, updated_at = ?, updated_by = ? WHERE key = ?',
      b.subject !== undefined ? str(b.subject, 300) || template.subject : template.subject,
      b.body !== undefined ? String(b.body).slice(0, 10000) : template.body,
      b.active !== undefined ? bool(b.active) : template.active,
      now(), ctx.user.id, template.key
    );
    audit(ctx.user.id, 'template_updated', 'email_template', null, ctx.ip, { key: template.key });
    return { ok: true };
  });

  router.post('/api/settings/templates/preview', requireStaff, (ctx) => {
    const b = ctx.body || {};
    return { preview: previewTemplate(String(b.subject || ''), String(b.body || '')) };
  });

  /** Restore a template to the wording this platform ships with. */
  router.post('/api/settings/templates/:key/reset', manage, (ctx) => {
    const key = str(ctx.params.key, 50);
    const template = get('SELECT * FROM email_templates WHERE key = ?', key);
    if (!template) throw new ApiError(404, 'Template not found.', 'not_found');
    const { DEFAULT_EMAIL_TEMPLATES } = require('../seed');
    const original = DEFAULT_EMAIL_TEMPLATES.find((t) => t.key === key);
    if (!original) throw new ApiError(400, 'This template has no shipped default to restore.', 'no_default');
    run(
      'UPDATE email_templates SET subject = ?, body = ?, updated_at = ?, updated_by = ? WHERE key = ?',
      original.subject, original.body, now(), ctx.user.id, key
    );
    audit(ctx.user.id, 'template_reset', 'email_template', null, ctx.ip, { key });
    return { ok: true, template: get('SELECT * FROM email_templates WHERE key = ?', key) };
  });

  // ------------------------------ Consent forms ------------------------------
  router.get('/api/settings/consent-forms', requireStaff, () => ({
    forms: all('SELECT * FROM consent_forms ORDER BY id DESC'),
  }));

  router.post('/api/settings/consent-forms', manage, (ctx) => {
    const b = ctx.body || {};
    const title = str(b.title, 200);
    const body = String(b.body || '').slice(0, 50000);
    if (!title || !body.trim()) {
      throw new ApiError(400, 'A consent form needs a title and the exact wording your brokerage uses.', 'missing_field');
    }
    const res = run(
      'INSERT INTO consent_forms (title, body, version, active, created_at) VALUES (?, ?, 1, 1, ?)',
      title, body, now()
    );
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  router.patch('/api/settings/consent-forms/:id', manage, (ctx) => {
    const form = get('SELECT * FROM consent_forms WHERE id = ?', Number(ctx.params.id));
    if (!form) throw new ApiError(404, 'Consent form not found.', 'not_found');
    const b = ctx.body || {};
    const newBody = b.body !== undefined ? String(b.body).slice(0, 50000) : form.body;
    // Changing the wording bumps the version — accepted versions stay snapshotted.
    const bump = newBody !== form.body;
    run(
      'UPDATE consent_forms SET title = ?, body = ?, version = ?, active = ?, updated_at = ? WHERE id = ?',
      b.title !== undefined ? str(b.title, 200) || form.title : form.title,
      newBody, bump ? form.version + 1 : form.version,
      b.active !== undefined ? bool(b.active) : form.active,
      now(), form.id
    );
    return { ok: true, version_bumped: bump };
  });

  // ------------------------------ Staff user management ------------------------------
  router.get('/api/settings/users', manageUsers, () => ({
    users: all("SELECT * FROM users WHERE role != 'client' ORDER BY created_at").map(publicUser),
  }));

  router.post('/api/settings/users', manageUsers, async (ctx) => {
    const b = ctx.body || {};
    const email = normalizeEmail(b.email);
    if (!isEmail(email)) throw new ApiError(400, 'A valid email is required.', 'bad_email');
    if (!STAFF_ROLES.includes(b.role)) throw new ApiError(400, 'Choose a valid role.', 'bad_role');
    if (get('SELECT id FROM users WHERE email = ?', email)) {
      throw new ApiError(400, 'A user with that email already exists.', 'email_conflict');
    }
    const res = run(
      `INSERT INTO users (role, email, first_name, last_name, phone, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'invited', ?, ?)`,
      b.role, email, str(b.first_name, 100), str(b.last_name, 100), str(b.phone, 40), now(), now()
    );
    const userId = Number(res.lastInsertRowid);
    const token = createAuthToken(userId, 'activate', 24 * 7);
    const link = `${portalBaseUrl()}/activate?token=${token}`;
    await sendTemplate('welcome', {
      toEmail: email, toName: `${str(b.first_name, 100)} ${str(b.last_name, 100)}`.trim(), userId,
      vars: { client_first_name: str(b.first_name, 100), client_last_name: str(b.last_name, 100), portal_link: link },
    });
    audit(ctx.user.id, 'user_created', 'user', userId, ctx.ip, { role: b.role });
    return { ok: true, id: userId, activation_link: link };
  });

  router.patch('/api/settings/users/:id', manageUsers, (ctx) => {
    const user = get("SELECT * FROM users WHERE id = ? AND role != 'client'", Number(ctx.params.id));
    if (!user) throw new ApiError(404, 'User not found.', 'not_found');
    const b = ctx.body || {};
    if (user.id === ctx.user.id && (b.role !== undefined || b.status === 'disabled')) {
      throw new ApiError(400, 'You cannot change your own role or disable your own account.', 'self_change');
    }
    run(
      'UPDATE users SET role = ?, status = ?, first_name = ?, last_name = ?, phone = ?, updated_at = ? WHERE id = ?',
      b.role !== undefined && STAFF_ROLES.includes(b.role) ? b.role : user.role,
      b.status !== undefined && ['active', 'invited', 'disabled'].includes(b.status) ? b.status : user.status,
      b.first_name !== undefined ? str(b.first_name, 100) || user.first_name : user.first_name,
      b.last_name !== undefined ? str(b.last_name, 100) || user.last_name : user.last_name,
      b.phone !== undefined ? str(b.phone, 40) : user.phone,
      now(), user.id
    );
    if (b.status === 'disabled') {
      const { destroyAllSessions } = require('../auth');
      destroyAllSessions(user.id);
    }
    audit(ctx.user.id, 'permission_change', 'user', user.id, ctx.ip, { role: b.role, status: b.status });
    return { ok: true };
  });
}

module.exports = { register };
