'use strict';

const { run, get, all, insert, getSetting, setSetting } = require('../db');
const {
  requireStaff, requirePermission, createAuthToken, STAFF_ROLES, destroyAllSessions,
} = require('../auth');
const { ApiError, now, str, intOrNull, bool, isEmail, normalizeEmail, parseJsonSafe } = require('../util');
const { audit } = require('../log');
const { previewTemplate, sendTemplate, portalBaseUrl, transportName } = require('../emails');
const { publicUser } = require('../serialize');
const { ALL_PERMISSIONS } = require('../seed');
const mfa = require('../mfa');

const manage = requirePermission('settings.manage');
const manageUsers = requirePermission('users.manage');

const EDITABLE_CONFIG_KEYS = [
  'brokerage', 'client_steps', 'reminders', 'automation', 'uploads', 'security', 'retention',
  'role_permissions', 'notifications', 'ai_review',
];

/** Route params are user input: reject non-numeric ids as 404, never 500. */
function idParam(value) {
  const id = intOrNull(value);
  if (id === null || id <= 0) throw new ApiError(404, 'Not found.', 'not_found');
  return id;
}

/**
 * Settings blobs are stored as JSON, so a typo used to be persisted silently
 * and then quietly ignored at read time (audit finding M11). Each key that
 * carries a security decision is validated here instead.
 */
function validateConfig(key, value) {
  if (key === 'role_permissions') {
    const out = {};
    for (const [role, perms] of Object.entries(value)) {
      if (!STAFF_ROLES.includes(role)) {
        throw new ApiError(400, `"${role}" is not one of this brokerage's roles.`, 'bad_role');
      }
      if (!Array.isArray(perms)) {
        throw new ApiError(400, `Permissions for "${role}" must be a list.`, 'bad_value');
      }
      const unknown = perms.filter((p) => !ALL_PERMISSIONS.includes(p));
      if (unknown.length) {
        throw new ApiError(
          400,
          `Unknown permission${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. A misspelled key would silently grant nothing.`,
          'bad_permission'
        );
      }
      out[role] = [...new Set(perms)];
    }
    // An administrator who can no longer manage users or settings locks the
    // whole brokerage out of its own configuration.
    const admin = out.admin || ALL_PERMISSIONS;
    for (const required of ['users.manage', 'settings.manage']) {
      if (!admin.includes(required)) {
        throw new ApiError(400, `The administrator role must keep "${required}".`, 'admin_lockout');
      }
    }
    return out;
  }

  if (key === 'security') {
    const out = { ...value };
    const bounded = (field, min, max) => {
      if (out[field] === undefined) return;
      const n = intOrNull(out[field]);
      if (n === null || n < min || n > max) {
        throw new ApiError(400, `"${field}" must be a number between ${min} and ${max}.`, 'bad_value');
      }
      out[field] = n;
    };
    bounded('session_days_staff', 1, 30);
    bounded('session_days_client', 1, 30);
    bounded('session_absolute_hours_staff', 1, 24 * 30);
    bounded('session_absolute_hours_client', 1, 24 * 30);
    bounded('lockout_threshold', 3, 20);
    bounded('lockout_minutes', 1, 24 * 60);
    bounded('min_password_length_staff', 12, 128);
    bounded('min_password_length_client', 10, 128);
    if (out.mfa_required_roles !== undefined) {
      if (!Array.isArray(out.mfa_required_roles)) {
        throw new ApiError(400, '"mfa_required_roles" must be a list of roles.', 'bad_value');
      }
      const bad = out.mfa_required_roles.filter((r) => !STAFF_ROLES.includes(r));
      if (bad.length) throw new ApiError(400, `Unknown role${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}.`, 'bad_role');
      // mfa.requiredRoles() re-adds 'admin' on read, but store it explicitly
      // so the saved value matches what is enforced.
      out.mfa_required_roles = [...new Set(['admin', ...out.mfa_required_roles])];
    }
    return out;
  }

  if (key === 'ai_review') {
    return {
      ...value,
      enabled: value.enabled === true,
      require_client_consent: value.require_client_consent !== false,
    };
  }

  if (key === 'retention') {
    const out = { ...value };
    for (const field of ['archive_completed_after_days', 'archive_inactive_after_days']) {
      if (out[field] === undefined || out[field] === null || out[field] === '') {
        out[field] = null;
        continue;
      }
      const n = intOrNull(out[field]);
      if (n === null || n < 1 || n > 3650) {
        throw new ApiError(400, `"${field}" must be a number of days between 1 and 3650, or empty to leave it off.`, 'bad_value');
      }
      out[field] = n;
    }
    return out;
  }

  if (key === 'uploads') {
    const out = { ...value };
    if (out.max_mb !== undefined) {
      const n = intOrNull(out.max_mb);
      if (n === null || n < 1 || n > 100) {
        throw new ApiError(400, '"max_mb" must be between 1 and 100.', 'bad_value');
      }
      out.max_mb = n;
    }
    return out;
  }

  return value;
}

function register(router) {
  // Reference data every staff screen needs (no special permission).
  router.get('/api/settings/meta', requireStaff, async () => ({
    stages: await all('SELECT * FROM stages ORDER BY sort'),
    application_types: await all('SELECT * FROM application_types ORDER BY sort'),
    employment_statuses: await all('SELECT * FROM employment_statuses ORDER BY sort'),
    document_types: await all('SELECT * FROM document_types ORDER BY sort'),
    permissions: ALL_PERMISSIONS,
    staff_roles: STAFF_ROLES,
    integrations: {
      email_transport: transportName(),
      microsoft_graph: require('../msgraph').isConfigured(),
      onedrive: require('../onedrive').isEnabled(),
      ai_review: await require('../ai-review').isEnabled(),
      malware_scanning: require('../scan').mode(),
      mfa_required_roles: await mfa.requiredRoles(),
    },
  }));

  // ------------------------------ Employment statuses ------------------------------
  router.post('/api/settings/employment-statuses', manage, async (ctx) => {
    const name = str(ctx.body && ctx.body.name, 100);
    if (!name) throw new ApiError(400, 'The employment status needs a name.', 'missing_field');
    const maxSort = await get('SELECT MAX(sort) AS m FROM employment_statuses');
    const key = str(ctx.body.key, 50) || `custom_${Date.now()}`;
    if (await get('SELECT id FROM employment_statuses WHERE key = ?', key)) {
      throw new ApiError(400, 'An employment status with that key already exists.', 'duplicate');
    }
    const id = await insert(
      'INSERT INTO employment_statuses (key, name, sort) VALUES (?, ?, ?)',
      key, name, ((maxSort && maxSort.m) || 0) + 10
    );
    await audit(ctx.user.id, 'employment_status_created', 'employment_status', id, ctx.ip);
    return { ok: true, id };
  });

  router.patch('/api/settings/employment-statuses/:id', manage, async (ctx) => {
    const row = await get('SELECT * FROM employment_statuses WHERE id = ?', idParam(ctx.params.id));
    if (!row) throw new ApiError(404, 'Employment status not found.', 'not_found');
    const b = ctx.body || {};
    await run(
      'UPDATE employment_statuses SET name = ?, active = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 100) || row.name : row.name,
      b.active !== undefined ? bool(b.active) : row.active,
      row.id
    );
    await audit(ctx.user.id, 'employment_status_updated', 'employment_status', row.id, ctx.ip);
    return { ok: true };
  });

  // Table names cannot be parameterized, so the only ones reorder() will
  // accept are named here — never anything derived from a request.
  const REORDERABLE = new Set(['stages', 'application_types', 'employment_statuses', 'document_types']);

  /** Shared reorder helper — one statement per table, ids validated. */
  async function reorder(table, rawIds) {
    if (!REORDERABLE.has(table)) throw new ApiError(400, 'That list cannot be reordered.', 'bad_table');
    const ids = (Array.isArray(rawIds) ? rawIds : []).slice(0, 500)
      .map((v) => intOrNull(v)).filter((v) => v !== null);
    for (let i = 0; i < ids.length; i++) {
      await run(`UPDATE ${table} SET sort = ? WHERE id = ?`, (i + 1) * 10, ids[i]);
    }
    return ids.length;
  }

  router.post('/api/settings/employment-statuses/reorder', manage, async (ctx) => {
    await reorder('employment_statuses', ctx.body && ctx.body.ids);
    return { ok: true };
  });

  router.post('/api/settings/application-types/reorder', manage, async (ctx) => {
    await reorder('application_types', ctx.body && ctx.body.ids);
    return { ok: true };
  });

  // ------------------------------ Config blobs ------------------------------
  router.get('/api/settings/config/:key', manage, async (ctx) => {
    if (!EDITABLE_CONFIG_KEYS.includes(ctx.params.key)) throw new ApiError(404, 'Unknown setting.', 'not_found');
    return { key: ctx.params.key, value: await getSetting(ctx.params.key, null) };
  });

  router.put('/api/settings/config/:key', manage, async (ctx) => {
    const key = ctx.params.key;
    if (!EDITABLE_CONFIG_KEYS.includes(key)) throw new ApiError(404, 'Unknown setting.', 'not_found');
    const value = ctx.body && ctx.body.value;
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ApiError(400, 'A settings object is required.', 'bad_value');
    }
    const clean = validateConfig(key, value);
    await setSetting(key, clean);
    await audit(ctx.user.id, 'settings_changed', 'settings', null, ctx.ip, { key });
    return { ok: true, value: clean };
  });

  // ------------------------------ Stages ------------------------------
  router.post('/api/settings/stages', manage, async (ctx) => {
    const b = ctx.body || {};
    const name = str(b.name, 100);
    if (!name) throw new ApiError(400, 'The stage needs a name.', 'missing_field');
    const maxSort = await get('SELECT MAX(sort) AS m FROM stages');
    const id = await insert(
      `INSERT INTO stages (key, name, client_label, client_message, client_step, color, sort, active, send_email, email_template_key, create_task, task_title, is_terminal)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      `custom_${Date.now()}`, name, str(b.client_label, 100) || name, str(b.client_message, 500),
      Math.min(6, Math.max(1, intOrNull(b.client_step) || 1)), str(b.color, 20) || '#4f6ef7',
      ((maxSort && maxSort.m) || 0) + 10,
      bool(b.send_email), b.send_email ? str(b.email_template_key, 50) || 'stage_changed' : null,
      bool(b.create_task), str(b.task_title, 200), bool(b.is_terminal)
    );
    await audit(ctx.user.id, 'stage_created', 'stage', id, ctx.ip);
    return { ok: true, id };
  });

  router.patch('/api/settings/stages/:id', manage, async (ctx) => {
    const stage = await get('SELECT * FROM stages WHERE id = ?', idParam(ctx.params.id));
    if (!stage) throw new ApiError(404, 'Stage not found.', 'not_found');
    const b = ctx.body || {};
    await run(
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
    await audit(ctx.user.id, 'stage_updated', 'stage', stage.id, ctx.ip);
    return { ok: true };
  });

  router.post('/api/settings/stages/reorder', manage, async (ctx) => {
    await reorder('stages', ctx.body && ctx.body.ids);
    await audit(ctx.user.id, 'stages_reordered', 'stage', null, ctx.ip);
    return { ok: true };
  });

  // ------------------------------ Application types ------------------------------
  router.post('/api/settings/application-types', manage, async (ctx) => {
    const name = str(ctx.body && ctx.body.name, 100);
    if (!name) throw new ApiError(400, 'The application type needs a name.', 'missing_field');
    const maxSort = await get('SELECT MAX(sort) AS m FROM application_types');
    const id = await insert(
      'INSERT INTO application_types (key, name, sort) VALUES (?, ?, ?)',
      `custom_${Date.now()}`, name, ((maxSort && maxSort.m) || 0) + 10
    );
    await audit(ctx.user.id, 'application_type_created', 'application_type', id, ctx.ip);
    return { ok: true, id };
  });

  router.patch('/api/settings/application-types/:id', manage, async (ctx) => {
    const type = await get('SELECT * FROM application_types WHERE id = ?', idParam(ctx.params.id));
    if (!type) throw new ApiError(404, 'Application type not found.', 'not_found');
    const b = ctx.body || {};
    await run(
      'UPDATE application_types SET name = ?, active = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 100) || type.name : type.name,
      b.active !== undefined ? bool(b.active) : type.active,
      type.id
    );
    await audit(ctx.user.id, 'application_type_updated', 'application_type', type.id, ctx.ip);
    return { ok: true };
  });

  // ------------------------------ Document types (the catalog) ------------------------------
  const DOC_CATEGORIES = ['identity', 'credit', 'income', 'property', 'financial', 'corporate', 'other'];

  router.post('/api/settings/document-types', manage, async (ctx) => {
    const b = ctx.body || {};
    const name = str(b.name, 150);
    if (!name) throw new ApiError(400, 'The document type needs a name.', 'missing_field');
    const maxSort = await get('SELECT MAX(sort) AS m FROM document_types');
    const id = await insert(
      `INSERT INTO document_types
         (key, name, category, description, sort, default_requirement, default_per_applicant, default_expires_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      `custom_${Date.now()}`, name,
      DOC_CATEGORIES.includes(b.category) ? b.category : 'other',
      str(b.description, 1000), ((maxSort && maxSort.m) || 0) + 10,
      b.default_requirement === 'optional' ? 'optional' : 'required',
      bool(b.default_per_applicant), intOrNull(b.default_expires_days)
    );
    await audit(ctx.user.id, 'document_type_created', 'document_type', id, ctx.ip);
    return { ok: true, id };
  });

  router.patch('/api/settings/document-types/:id', manage, async (ctx) => {
    const type = await get('SELECT * FROM document_types WHERE id = ?', idParam(ctx.params.id));
    if (!type) throw new ApiError(404, 'Document type not found.', 'not_found');
    const b = ctx.body || {};
    await run(
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
    await audit(ctx.user.id, 'document_type_updated', 'document_type', type.id, ctx.ip);
    return { ok: true };
  });

  /** Catalog search for the "+ Add Document" picker in the Add Client wizard. */
  router.get('/api/settings/document-types/search', requireStaff, async (ctx) => {
    const q = str(ctx.query.q, 100).toLowerCase();
    const rows = q
      ? await all(
          `SELECT * FROM document_types
            WHERE active = 1 AND (lower(name) LIKE ? OR lower(COALESCE(category,'')) LIKE ?)
            ORDER BY sort LIMIT 50`,
          `%${q}%`, `%${q}%`
        )
      : await all('SELECT * FROM document_types WHERE active = 1 ORDER BY sort LIMIT 50');
    return { document_types: rows };
  });

  // ------------------------------ Document rules (the global defaults) ------------------------------
  router.get('/api/settings/rules', requireStaff, async () => {
    const rules = await all('SELECT * FROM document_rules ORDER BY id');
    const out = [];
    for (const rule of rules) {
      out.push({
        ...rule,
        conditions: parseJsonSafe(rule.conditions, {}),
        items: await all(
          `SELECT i.*, dt.name AS document_name FROM document_rule_items i
             JOIN document_types dt ON dt.id = i.document_type_id WHERE i.rule_id = ?`,
          rule.id
        ),
      });
    }
    return { rules: out };
  });

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

  async function replaceRuleItems(ruleId, items) {
    await run('DELETE FROM document_rule_items WHERE rule_id = ?', ruleId);
    for (const item of (Array.isArray(items) ? items : []).slice(0, 50)) {
      const docType = await get('SELECT id FROM document_types WHERE id = ?', intOrNull(item.document_type_id));
      if (!docType) continue;
      await run(
        'INSERT INTO document_rule_items (rule_id, document_type_id, requirement, per_applicant, expires_days, note) VALUES (?, ?, ?, ?, ?, ?)',
        ruleId, docType.id,
        item.requirement === 'optional' ? 'optional' : 'required',
        bool(item.per_applicant), intOrNull(item.expires_days), str(item.note, 300)
      );
    }
  }

  router.post('/api/settings/rules', manage, async (ctx) => {
    const b = ctx.body || {};
    const name = str(b.name, 150);
    if (!name) throw new ApiError(400, 'The rule needs a name.', 'missing_field');
    const ruleId = await insert(
      'INSERT INTO document_rules (name, active, conditions, created_at, updated_at) VALUES (?, 1, ?, ?, ?)',
      name, JSON.stringify(validConditions(b.conditions)), now(), now()
    );
    await replaceRuleItems(ruleId, b.items);
    await audit(ctx.user.id, 'rule_created', 'document_rule', ruleId, ctx.ip);
    return { ok: true, id: ruleId };
  });

  router.patch('/api/settings/rules/:id', manage, async (ctx) => {
    const rule = await get('SELECT * FROM document_rules WHERE id = ?', idParam(ctx.params.id));
    if (!rule) throw new ApiError(404, 'Rule not found.', 'not_found');
    const b = ctx.body || {};
    await run(
      'UPDATE document_rules SET name = ?, active = ?, conditions = ?, updated_at = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 150) || rule.name : rule.name,
      b.active !== undefined ? bool(b.active) : rule.active,
      b.conditions !== undefined ? JSON.stringify(validConditions(b.conditions)) : rule.conditions,
      now(), rule.id
    );
    if (b.items !== undefined) await replaceRuleItems(rule.id, b.items);
    await audit(ctx.user.id, 'rule_updated', 'document_rule', rule.id, ctx.ip);
    return { ok: true };
  });

  router.delete('/api/settings/rules/:id', manage, async (ctx) => {
    const rule = await get('SELECT * FROM document_rules WHERE id = ?', idParam(ctx.params.id));
    if (!rule) throw new ApiError(404, 'Rule not found.', 'not_found');
    await run('DELETE FROM document_rules WHERE id = ?', rule.id);
    await audit(ctx.user.id, 'rule_deleted', 'document_rule', rule.id, ctx.ip);
    return { ok: true };
  });

  // ------------------------------ Email templates ------------------------------
  router.get('/api/settings/templates', requireStaff, async () => ({
    templates: await all('SELECT * FROM email_templates ORDER BY key'),
  }));

  router.patch('/api/settings/templates/:key', manage, async (ctx) => {
    const template = await get('SELECT * FROM email_templates WHERE key = ?', str(ctx.params.key, 50));
    if (!template) throw new ApiError(404, 'Template not found.', 'not_found');
    const b = ctx.body || {};
    await run(
      'UPDATE email_templates SET subject = ?, body = ?, active = ?, updated_at = ?, updated_by = ? WHERE key = ?',
      b.subject !== undefined ? str(b.subject, 300) || template.subject : template.subject,
      b.body !== undefined ? String(b.body).slice(0, 10000) : template.body,
      b.active !== undefined ? bool(b.active) : template.active,
      now(), ctx.user.id, template.key
    );
    await audit(ctx.user.id, 'template_updated', 'email_template', null, ctx.ip, { key: template.key });
    return { ok: true };
  });

  router.post('/api/settings/templates/preview', requireStaff, async (ctx) => {
    const b = ctx.body || {};
    return { preview: await previewTemplate(String(b.subject || ''), String(b.body || '')) };
  });

  /** Restore a template to the wording this platform ships with. */
  router.post('/api/settings/templates/:key/reset', manage, async (ctx) => {
    const key = str(ctx.params.key, 50);
    const template = await get('SELECT * FROM email_templates WHERE key = ?', key);
    if (!template) throw new ApiError(404, 'Template not found.', 'not_found');
    const { DEFAULT_EMAIL_TEMPLATES } = require('../seed');
    const original = DEFAULT_EMAIL_TEMPLATES.find((t) => t.key === key);
    if (!original) throw new ApiError(400, 'This template has no shipped default to restore.', 'no_default');
    await run(
      'UPDATE email_templates SET subject = ?, body = ?, updated_at = ?, updated_by = ? WHERE key = ?',
      original.subject, original.body, now(), ctx.user.id, key
    );
    await audit(ctx.user.id, 'template_reset', 'email_template', null, ctx.ip, { key });
    return { ok: true, template: await get('SELECT * FROM email_templates WHERE key = ?', key) };
  });

  // ------------------------------ Consent forms ------------------------------
  router.get('/api/settings/consent-forms', requireStaff, async () => ({
    forms: await all('SELECT * FROM consent_forms ORDER BY id DESC'),
  }));

  router.post('/api/settings/consent-forms', manage, async (ctx) => {
    const b = ctx.body || {};
    const title = str(b.title, 200);
    const body = String(b.body || '').slice(0, 50000);
    if (!title || !body.trim()) {
      throw new ApiError(400, 'A consent form needs a title and the exact wording your brokerage uses.', 'missing_field');
    }
    const id = await insert(
      'INSERT INTO consent_forms (title, body, version, active, created_at) VALUES (?, ?, 1, 1, ?)',
      title, body, now()
    );
    await audit(ctx.user.id, 'consent_form_created', 'consent_form', id, ctx.ip);
    return { ok: true, id };
  });

  router.patch('/api/settings/consent-forms/:id', manage, async (ctx) => {
    const form = await get('SELECT * FROM consent_forms WHERE id = ?', idParam(ctx.params.id));
    if (!form) throw new ApiError(404, 'Consent form not found.', 'not_found');
    const b = ctx.body || {};
    const newBody = b.body !== undefined ? String(b.body).slice(0, 50000) : form.body;
    // Changing the wording bumps the version — accepted versions stay snapshotted.
    const bump = newBody !== form.body;
    await run(
      'UPDATE consent_forms SET title = ?, body = ?, version = ?, active = ?, updated_at = ? WHERE id = ?',
      b.title !== undefined ? str(b.title, 200) || form.title : form.title,
      newBody, bump ? form.version + 1 : form.version,
      b.active !== undefined ? bool(b.active) : form.active,
      now(), form.id
    );
    await audit(ctx.user.id, 'consent_form_updated', 'consent_form', form.id, ctx.ip, { version_bumped: bump });
    return { ok: true, version_bumped: bump };
  });

  // ------------------------------ Staff user management ------------------------------
  router.get('/api/settings/users', manageUsers, async () => {
    const users = await all("SELECT * FROM users WHERE role != 'client' ORDER BY created_at");
    const out = [];
    for (const u of users) {
      out.push({
        ...publicUser(u),
        mfa_required: await mfa.isRequiredFor(u),
        recovery_codes_left: await mfa.remainingRecoveryCodes(u.id),
      });
    }
    return { users: out };
  });

  router.post('/api/settings/users', manageUsers, async (ctx) => {
    const b = ctx.body || {};
    const email = normalizeEmail(b.email);
    if (!isEmail(email)) throw new ApiError(400, 'A valid email is required.', 'bad_email');
    if (!STAFF_ROLES.includes(b.role)) throw new ApiError(400, 'Choose a valid role.', 'bad_role');
    if (await get('SELECT id FROM users WHERE email = ?', email)) {
      throw new ApiError(400, 'A user with that email already exists.', 'email_conflict');
    }
    // No password is set here at all: the account is unusable until the
    // invitee follows the one-time activation link and chooses their own.
    const userId = await insert(
      `INSERT INTO users (role, email, first_name, last_name, phone, status, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'invited', 1, ?, ?)`,
      b.role, email, str(b.first_name, 100), str(b.last_name, 100), str(b.phone, 40), now(), now()
    );
    const token = await createAuthToken(userId, 'activate', 24 * 7);
    const link = `${portalBaseUrl()}/activate?token=${token}`;
    await sendTemplate('staff_invite', {
      toEmail: email, toName: `${str(b.first_name, 100)} ${str(b.last_name, 100)}`.trim(), userId,
      vars: {
        client_first_name: str(b.first_name, 100),
        client_last_name: str(b.last_name, 100),
        portal_link: link,
      },
      redact: [token],
    }).catch(async () => {
      // A mail outage must not leave a half-created account with no way in;
      // the link is returned to the administrator either way.
      await audit(ctx.user.id, 'user_invite_email_failed', 'user', userId, ctx.ip);
    });
    await audit(ctx.user.id, 'user_created', 'user', userId, ctx.ip, { role: b.role });
    return { ok: true, id: userId, activation_link: link };
  });

  router.patch('/api/settings/users/:id', manageUsers, async (ctx) => {
    const user = await get("SELECT * FROM users WHERE id = ? AND role != 'client'", idParam(ctx.params.id));
    if (!user) throw new ApiError(404, 'User not found.', 'not_found');
    const b = ctx.body || {};
    if (user.id === ctx.user.id && (b.role !== undefined || b.status === 'disabled')) {
      throw new ApiError(400, 'You cannot change your own role or disable your own account.', 'self_change');
    }
    const nextRole = b.role !== undefined && STAFF_ROLES.includes(b.role) ? b.role : user.role;
    const nextStatus = b.status !== undefined && ['active', 'invited', 'disabled'].includes(b.status) ? b.status : user.status;

    // Removing the last active administrator would lock the brokerage out.
    if (user.role === 'admin' && (nextRole !== 'admin' || nextStatus === 'disabled')) {
      const others = await get(
        "SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?",
        user.id
      );
      if (others.n === 0) {
        throw new ApiError(400, 'This is the last active administrator. Promote someone else first.', 'last_admin');
      }
    }

    await run(
      'UPDATE users SET role = ?, status = ?, first_name = ?, last_name = ?, phone = ?, updated_at = ? WHERE id = ?',
      nextRole, nextStatus,
      b.first_name !== undefined ? str(b.first_name, 100) || user.first_name : user.first_name,
      b.last_name !== undefined ? str(b.last_name, 100) || user.last_name : user.last_name,
      b.phone !== undefined ? str(b.phone, 40) : user.phone,
      now(), user.id
    );
    // A role change alters the permission set, and a disabled account must
    // lose access immediately — in both cases existing sessions are dropped
    // rather than left holding stale authority.
    if (nextStatus === 'disabled' || nextRole !== user.role) {
      await destroyAllSessions(user.id);
    }
    await audit(ctx.user.id, 'permission_change', 'user', user.id, ctx.ip, { role: nextRole, status: nextStatus });
    return { ok: true };
  });

  /**
   * Clear a staff member's second factor after a lost phone.
   *
   * Deliberately an administrator action rather than a self-service reset:
   * a self-service MFA reset is a bypass of MFA. All their sessions are
   * dropped, so the next sign-in must re-enrol before anything else works.
   */
  router.post('/api/settings/users/:id/mfa/reset', manageUsers, async (ctx) => {
    const user = await get("SELECT * FROM users WHERE id = ? AND role != 'client'", idParam(ctx.params.id));
    if (!user) throw new ApiError(404, 'User not found.', 'not_found');
    await mfa.resetMfa(user.id);
    await destroyAllSessions(user.id);
    await audit(ctx.user.id, 'mfa_reset', 'user', user.id, ctx.ip);
    return { ok: true, message: `${user.first_name || user.email} must set up their authenticator app again at their next sign-in.` };
  });
}

module.exports = { register, validateConfig, EDITABLE_CONFIG_KEYS };
