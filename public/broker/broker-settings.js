'use strict';

/* Broker portal — Settings views. Uses shared BK state from broker-file.js. */

const SETTINGS_SECTIONS = [
  ['branding', 'Branding'],
  ['stages', 'Stages'],
  ['types', 'Client services'],
  ['employment', 'Employment statuses'],
  ['doctypes', 'Document catalog'],
  ['rules', 'Document rules'],
  ['templates', 'Email templates'],
  ['automation', 'Reminders & automation'],
  ['team', 'Team & permissions'],
  ['consents', 'Consent forms'],
  ['integrations', 'Integrations'],
];

async function renderSettings(section) {
  section = section || 'branding';
  const view = document.getElementById('view');
  clearNode(view);

  if (!can('settings.manage') && !can('users.manage')) {
    view.append(el('div', { class: 'card empty' },
      el('div', { class: 'big' }, '🔒'),
      el('p', null, 'Settings are managed by your brokerage administrator.')));
    return;
  }

  const nav = el('div', { class: 'settings-nav' }, SETTINGS_SECTIONS.map(([key, label]) =>
    el('button', { class: key === section ? 'active' : '', onclick: () => { window.location.hash = `#/settings/${key}`; } }, label)));
  const bodyEl = el('div');
  view.append(el('h1', null, 'Settings'), el('div', { class: 'settings-grid' }, nav, bodyEl));

  const renderers = {
    branding: renderBrandingSettings, stages: renderStageSettings, types: renderTypeSettings,
    employment: renderEmploymentSettings, doctypes: renderDocTypeSettings,
    rules: renderRuleSettings, templates: renderTemplateSettings,
    automation: renderAutomationSettings, team: renderTeamSettings, consents: renderConsentSettings,
    integrations: renderIntegrationsSettings,
  };
  await (renderers[section] || renderBrandingSettings)(bodyEl);
}

async function reloadMeta() {
  BK.meta = await api.get('/api/settings/meta');
}

// ------------------------------------------------------------------ branding

async function renderBrandingSettings(body) {
  const { value } = await api.get('/api/settings/config/brokerage');
  const v = value || {};
  const fields = {
    name: el('input', { type: 'text', value: v.name || '' }),
    broker_name: el('input', { type: 'text', value: v.broker_name || '' }),
    phone: el('input', { type: 'tel', value: v.phone || '' }),
    email: el('input', { type: 'email', value: v.email || '' }),
    website: el('input', { type: 'text', value: v.website || '' }),
    address: el('input', { type: 'text', value: v.address || '' }),
    welcome_message: el('input', { type: 'text', value: v.welcome_message || '' }),
    primary_color: el('input', { type: 'text', value: v.primary_color || '#1f4fd8', placeholder: '#1f4fd8' }),
    logo_text: el('input', { type: 'text', value: v.logo_text || '', placeholder: 'Up to 2 letters, e.g. "AB"' }),
  };
  body.append(el('div', { class: 'card' },
    el('h3', null, 'Brokerage branding'),
    el('p', { class: 'muted small' }, 'This is how the client portal is presented to your clients.'),
    el('div', { class: 'form-row cols-2' },
      el('label', { class: 'field' }, el('span', null, 'Brokerage name'), fields.name),
      el('label', { class: 'field' }, el('span', null, 'Broker display name'), fields.broker_name),
      el('label', { class: 'field' }, el('span', null, 'Phone'), fields.phone),
      el('label', { class: 'field' }, el('span', null, 'Email'), fields.email),
      el('label', { class: 'field' }, el('span', null, 'Website'), fields.website),
      el('label', { class: 'field' }, el('span', null, 'Office address'), fields.address)),
    el('label', { class: 'field' }, el('span', null, 'Client welcome message'), fields.welcome_message),
    el('div', { class: 'form-row cols-2' },
      el('label', { class: 'field' }, el('span', null, 'Brand color (hex)'), fields.primary_color),
      el('label', { class: 'field' }, el('span', null, 'Logo letters'), fields.logo_text)),
    el('button', {
      class: 'btn',
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          const next = {};
          for (const [k, input] of Object.entries(fields)) next[k] = input.value.trim();
          await api.put('/api/settings/config/brokerage', { value: { ...v, ...next } });
          toast('Branding saved.', 'good');
        } catch (err) { toast(err.message, 'bad'); }
        e.target.disabled = false;
      },
    }, 'Save branding')));
}

// ------------------------------------------------------------------ stages

async function renderStageSettings(body) {
  await reloadMeta();
  const stages = BK.meta.stages;
  const list = el('div');

  stages.forEach((s, i) => {
    list.append(el('div', { class: 'card tight row wrap' },
      el('span', { class: 'dot', style: `background:${s.color}` }),
      el('div', { class: 'grow' },
        el('div', { style: 'font-weight:600' }, s.name, s.active ? '' : el('span', { class: 'pill', style: 'margin-left:8px' }, 'Disabled')),
        el('div', { class: 'faint' }, `Client sees: "${s.client_label}" · Step ${s.client_step}${s.send_email ? ' · 📧 emails client' : ''}${s.create_task ? ' · ✅ creates task' : ''}`)),
      el('button', { class: 'btn sm secondary', disabled: i === 0 ? '' : undefined, onclick: () => moveStage(i, -1) }, '↑'),
      el('button', { class: 'btn sm secondary', disabled: i === stages.length - 1 ? '' : undefined, onclick: () => moveStage(i, 1) }, '↓'),
      el('button', { class: 'btn sm secondary', onclick: () => stageModal(s) }, 'Edit')));
  });

  async function moveStage(index, delta) {
    const ids = stages.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved);
    await api.post('/api/settings/stages/reorder', { ids });
    renderSettings('stages');
  }

  body.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('p', { class: 'muted grow', style: 'margin:0' }, 'Stages drive the client progress tracker, notifications and automations.'),
      el('button', { class: 'btn sm', onclick: () => stageModal(null) }, '+ Add stage')),
    list);
}

function stageModal(stage) {
  const isNew = !stage;
  const s = stage || {};
  const name = el('input', { type: 'text', value: s.name || '' });
  const clientLabel = el('input', { type: 'text', value: s.client_label || '' });
  const clientMessage = el('textarea', null, s.client_message || '');
  const step = el('select', null, [1, 2, 3, 4, 5, 6].map((n) =>
    el('option', { value: n, selected: (s.client_step || 1) === n ? '' : undefined }, `Step ${n}`)));
  const color = el('input', { type: 'text', value: s.color || '#4f6ef7' });
  const active = el('input', { type: 'checkbox', checked: (isNew || s.active) ? '' : undefined });
  const sendEmail = el('input', { type: 'checkbox', checked: s.send_email ? '' : undefined });
  const createTask = el('input', { type: 'checkbox', checked: s.create_task ? '' : undefined });
  const taskTitle = el('input', { type: 'text', value: s.task_title || '', placeholder: 'e.g. Review outstanding lender conditions' });
  const terminal = el('input', { type: 'checkbox', checked: s.is_terminal ? '' : undefined });

  openModal(isNew ? 'Add stage' : `Edit stage: ${s.name}`,
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Internal name'), name),
      el('label', { class: 'field' }, el('span', null, 'Client-facing label'), clientLabel),
      el('label', { class: 'field' }, el('span', null, 'Client-facing message (shown as their status)'), clientMessage),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Progress tracker step'), step),
        el('label', { class: 'field' }, el('span', null, 'Color (hex)'), color)),
      el('label', { class: 'checkbox' }, active, 'Active (available for use)'),
      el('label', { class: 'checkbox' }, sendEmail, 'Email the client when a file enters this stage'),
      el('label', { class: 'checkbox' }, createTask, 'Create a task when a file enters this stage'),
      el('label', { class: 'field' }, el('span', null, 'Task title'), taskTitle),
      el('label', { class: 'checkbox' }, terminal, 'Terminal stage (file is finished)')),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = {
            name: name.value, client_label: clientLabel.value, client_message: clientMessage.value,
            client_step: step.value, color: color.value, active: active.checked,
            send_email: sendEmail.checked, create_task: createTask.checked, task_title: taskTitle.value,
            is_terminal: terminal.checked,
          };
          try {
            if (isNew) await api.post('/api/settings/stages', payload);
            else await api.patch(`/api/settings/stages/${s.id}`, payload);
            close(); toast('Stage saved.', 'good'); renderSettings('stages');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Save'),
    ]);
}

// ------------------------------------------------------------------ application types

async function renderTypeSettings(body) {
  await reloadMeta();
  const nameInput = el('input', { type: 'text', placeholder: 'e.g. Renewal' });
  body.append(
    el('div', { class: 'card' },
      el('h3', null, 'Application types'),
      el('ul', { class: 'list' }, BK.meta.application_types.map((t) => el('li', { class: 'row' },
        el('div', { class: 'grow', style: t.active ? '' : 'color:var(--ink-faint)' }, t.name),
        el('button', {
          class: 'btn sm secondary',
          onclick: async () => {
            await api.patch(`/api/settings/application-types/${t.id}`, { active: !t.active });
            renderSettings('types');
          },
        }, t.active ? 'Disable' : 'Enable')))),
      el('div', { class: 'row', style: 'margin-top:12px' },
        nameInput,
        el('button', {
          class: 'btn',
          onclick: async () => {
            if (!nameInput.value.trim()) return;
            await api.post('/api/settings/application-types', { name: nameInput.value });
            renderSettings('types');
          },
        }, 'Add'))));
}

// ------------------------------------------------------------------ employment statuses

async function renderEmploymentSettings(body) {
  await reloadMeta();
  const statuses = BK.meta.employment_statuses || [];
  const nameInput = el('input', { type: 'text', placeholder: 'e.g. Gig Worker' });

  async function move(index, delta) {
    const ids = statuses.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved);
    await api.post('/api/settings/employment-statuses/reorder', { ids });
    renderSettings('employment');
  }

  body.append(
    el('p', { class: 'muted' },
      'Step 2 of the Add Client wizard offers these. Combined with the client service, they decide the default document checklist.'),
    el('div', { class: 'card' },
      el('ul', { class: 'list' }, statuses.map((s, i) => el('li', { class: 'row wrap' },
        el('div', { class: 'grow', style: s.active ? 'font-weight:600' : 'color:var(--ink-faint)' },
          s.name, s.active ? '' : el('span', { class: 'pill', style: 'margin-left:8px' }, 'Disabled')),
        el('button', { class: 'btn sm secondary', disabled: i === 0 ? '' : undefined, onclick: () => move(i, -1) }, '↑'),
        el('button', { class: 'btn sm secondary', disabled: i === statuses.length - 1 ? '' : undefined, onclick: () => move(i, 1) }, '↓'),
        el('button', { class: 'btn sm secondary', onclick: () => employmentModal(s) }, 'Edit'),
        el('button', {
          class: 'btn sm secondary',
          onclick: async () => {
            await api.patch(`/api/settings/employment-statuses/${s.id}`, { active: !s.active });
            renderSettings('employment');
          },
        }, s.active ? 'Disable' : 'Enable')))),
      el('div', { class: 'row', style: 'margin-top:12px' },
        nameInput,
        el('button', {
          class: 'btn',
          onclick: async () => {
            if (!nameInput.value.trim()) return;
            try {
              await api.post('/api/settings/employment-statuses', { name: nameInput.value });
              renderSettings('employment');
            } catch (err) { toast(err.message, 'bad'); }
          },
        }, 'Add'))));
}

function employmentModal(status) {
  const name = el('input', { type: 'text', value: status.name });
  openModal(`Edit: ${status.name}`,
    el('label', { class: 'field' }, el('span', null, 'Name'), name),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          await api.patch(`/api/settings/employment-statuses/${status.id}`, { name: name.value });
          close(); renderSettings('employment');
        },
      }, 'Save'),
    ]);
}

// ------------------------------------------------------------------ integrations

async function renderIntegrationsSettings(body) {
  await reloadMeta();
  const i = BK.meta.integrations || {};
  const row = (label, on, detail) => el('div', { class: 'card tight row wrap' },
    el('span', { class: `pill ${on ? 'good' : 'warn'}` }, on ? 'Connected' : 'Not configured'),
    el('div', { class: 'grow' },
      el('div', { style: 'font-weight:600' }, label),
      el('div', { class: 'faint' }, detail)));

  body.append(
    el('p', { class: 'muted' },
      'These integrations are configured with server-side environment variables so credentials never reach the browser. See the README for the exact setup steps.'),
    row('Microsoft 365 / Outlook email', i.microsoft_graph,
      'Sends client email through your connected mailbox using Microsoft Graph and OAuth app credentials (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_MAILBOX).'),
    row('OneDrive document storage', i.onedrive,
      'Stores every uploaded document in your OneDrive, organized per client file (ONEDRIVE_ROOT).'),
    row('Claude document review', i.ai_review,
      'Reviews uploads in the background with the document-review skill (ANTHROPIC_API_KEY, ANTHROPIC_MODEL).'),
    el('div', { class: 'card tight row wrap' },
      el('span', { class: 'pill' }, i.email_transport || 'log'),
      el('div', { class: 'grow' },
        el('div', { style: 'font-weight:600' }, 'Active email transport'),
        el('div', { class: 'faint' }, 'graph = Microsoft 365 · smtp = mailbox app password · log/disabled = nothing is delivered'))));
}

// ------------------------------------------------------------------ document types

async function renderDocTypeSettings(body) {
  await reloadMeta();
  body.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('p', { class: 'muted grow', style: 'margin:0' }, 'The document vocabulary used by checklists and rules.'),
      el('button', { class: 'btn sm', onclick: () => docTypeModal(null) }, '+ Add document type')),
    el('div', { class: 'card table-wrap' }, el('table', { class: 'data' },
      el('thead', null, el('tr', null, ['Name', 'Category', 'Description', '', ''].map((h) => el('th', null, h)))),
      el('tbody', null, BK.meta.document_types.map((t) => el('tr', { style: t.active ? '' : 'opacity:0.5' },
        el('td', { style: 'font-weight:600' }, t.name),
        el('td', null, t.category),
        el('td', { class: 'small muted' }, t.description),
        el('td', null, el('button', { class: 'btn sm secondary', onclick: () => docTypeModal(t) }, 'Edit')),
        el('td', null, el('button', {
          class: 'btn sm secondary',
          onclick: async () => { await api.patch(`/api/settings/document-types/${t.id}`, { active: !t.active }); renderSettings('doctypes'); },
        }, t.active ? 'Disable' : 'Enable'))))))));
}

const DOC_CATEGORIES = ['identity', 'credit', 'income', 'property', 'financial', 'corporate', 'other'];

function docTypeModal(t) {
  const isNew = !t;
  const d = t || {};
  const name = el('input', { type: 'text', value: d.name || '' });
  const category = el('select', null, DOC_CATEGORIES.map((c) =>
    el('option', { value: c, selected: (d.category || 'other') === c ? '' : undefined }, c)));
  const desc = el('textarea', { placeholder: 'e.g. Get it from: https://my.equifax.ca/login' }, d.description || '');
  const requirement = el('select', null,
    el('option', { value: 'required', selected: (d.default_requirement || 'required') === 'required' ? '' : undefined }, 'Required by default'),
    el('option', { value: 'optional', selected: d.default_requirement === 'optional' ? '' : undefined }, 'Optional by default'));
  const perApplicant = el('input', { type: 'checkbox', checked: d.default_per_applicant ? '' : undefined });
  const expires = el('input', { type: 'number', value: d.default_expires_days ?? '', placeholder: 'e.g. 60' });

  openModal(isNew ? 'Add document type' : `Edit ${d.name}`,
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Document name'), name),
      el('label', { class: 'field' }, el('span', null, 'Category'), category),
      el('label', { class: 'field' }, el('span', null, 'Instructions shown to the client'), desc),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Default requirement'), requirement),
        el('label', { class: 'field' }, el('span', null, 'Valid for (days after approval)'), expires)),
      el('label', { class: 'checkbox' }, perApplicant, 'Applicant-specific by default (one per applicant)'),
      el('p', { class: 'faint' }, 'These are catalog defaults. Each client\'s checklist can still be adjusted individually.')),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const payload = {
              name: name.value, category: category.value, description: desc.value,
              default_requirement: requirement.value,
              default_per_applicant: perApplicant.checked,
              default_expires_days: expires.value || null,
            };
            if (isNew) await api.post('/api/settings/document-types', payload);
            else await api.patch(`/api/settings/document-types/${d.id}`, payload);
            close(); renderSettings('doctypes');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Save'),
    ]);
}

// ------------------------------------------------------------------ document rules

async function renderRuleSettings(body) {
  await reloadMeta();
  const res = await api.get('/api/settings/rules');
  body.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('p', { class: 'muted grow', style: 'margin:0' },
        'Rules build each client’s document checklist automatically. All matching rules combine — e.g. Purchase + Employee + First-time buyer.'),
      el('button', { class: 'btn sm', onclick: () => ruleModal(null) }, '+ Add rule')));

  for (const rule of res.rules) {
    const conditionText = describeConditions(rule.conditions);
    body.append(el('div', { class: 'card' },
      el('div', { class: 'row wrap' },
        el('div', { class: 'grow' },
          el('div', { style: 'font-weight:700' }, rule.name, rule.active ? '' : el('span', { class: 'pill', style: 'margin-left:8px' }, 'Disabled')),
          el('div', { class: 'small muted' }, el('strong', null, 'IF '), conditionText)),
        el('button', { class: 'btn sm secondary', onclick: () => ruleModal(rule) }, 'Edit'),
        el('button', {
          class: 'btn sm secondary',
          onclick: async () => { await api.patch(`/api/settings/rules/${rule.id}`, { active: !rule.active }); renderSettings('rules'); },
        }, rule.active ? 'Disable' : 'Enable')),
      el('div', { class: 'small', style: 'margin-top:8px' },
        el('strong', null, 'THEN require: '),
        rule.items.map((i) => el('span', { class: 'pill', style: 'margin:2px 4px 2px 0' },
          `${i.document_name}${i.requirement === 'optional' ? ' (optional)' : ''}${i.per_applicant ? ' · each applicant' : ''}${i.expires_days ? ` · valid ${i.expires_days}d` : ''}`)))));
  }
}

function describeConditions(c) {
  const parts = [];
  if (c.application_type_keys && c.application_type_keys.length) {
    const names = c.application_type_keys.map((k) => {
      const t = BK.meta.application_types.find((x) => x.key === k);
      return t ? t.name : k;
    });
    parts.push(`Application type is ${names.join(' or ')}`);
  }
  if (c.employment_types && c.employment_types.length) {
    parts.push(`Applicant is ${c.employment_types.map((e) => e.replace('_', '-')).join(' or ')}`);
  }
  if (c.fthb === true) parts.push('First-time home buyer');
  return parts.length ? parts.join(' AND ') : 'every application';
}

function ruleModal(rule) {
  const isNew = !rule;
  const r = rule || { conditions: {}, items: [] };
  const name = el('input', { type: 'text', value: r.name || '', placeholder: 'e.g. Self-employed purchase documents' });

  const typeChecks = BK.meta.application_types.map((t) => {
    const cb = el('input', { type: 'checkbox', checked: (r.conditions.application_type_keys || []).includes(t.key) ? '' : undefined });
    return { key: t.key, cb, node: el('label', { class: 'checkbox' }, cb, t.name) };
  });
  const empChecks = ['employee', 'self_employed', 'retired', 'unemployed', 'other'].map((v) => {
    const cb = el('input', { type: 'checkbox', checked: (r.conditions.employment_types || []).includes(v) ? '' : undefined });
    return { key: v, cb, node: el('label', { class: 'checkbox' }, cb, v.replace('_', '-')) };
  });
  const fthb = el('input', { type: 'checkbox', checked: r.conditions.fthb === true ? '' : undefined });

  const itemsHolder = el('div');
  const items = [];
  function addItemRow(existing) {
    const typeSel = el('select', null, BK.meta.document_types.filter((t) => t.active).map((t) =>
      el('option', { value: t.id, selected: existing && existing.document_type_id === t.id ? '' : undefined }, t.name)));
    const req = el('select', null,
      el('option', { value: 'required', selected: (!existing || existing.requirement === 'required') ? '' : undefined }, 'Required'),
      el('option', { value: 'optional', selected: existing && existing.requirement === 'optional' ? '' : undefined }, 'Optional'));
    const per = el('input', { type: 'checkbox', checked: existing && existing.per_applicant ? '' : undefined });
    const exp = el('input', { type: 'number', value: existing && existing.expires_days ? existing.expires_days : '', placeholder: 'days', style: 'width:80px' });
    const entry = { typeSel, req, per, exp, removed: false };
    const row = el('div', { class: 'row wrap', style: 'margin-bottom:8px' },
      typeSel, req,
      el('label', { class: 'checkbox', style: 'margin:0' }, per, el('span', { class: 'small' }, 'per applicant')),
      exp,
      el('button', { class: 'btn-link small', style: 'color:var(--bad)', onclick: () => { entry.removed = true; row.remove(); } }, 'Remove'));
    items.push(entry);
    itemsHolder.append(row);
  }
  for (const item of r.items || []) addItemRow(item);
  if (isNew) addItemRow(null);

  openModal(isNew ? 'Add document rule' : `Edit rule: ${r.name}`,
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Rule name'), name),
      el('div', { class: 'field-label' }, 'IF the application type is any of (leave empty for all):'),
      el('div', { class: 'form-row cols-2' }, typeChecks.map((t) => t.node)),
      el('div', { class: 'field-label' }, 'AND the applicant’s employment is any of (leave empty for all; when set, documents apply per matching applicant):'),
      el('div', { class: 'form-row cols-2' }, empChecks.map((t) => t.node)),
      el('label', { class: 'checkbox' }, fthb, 'AND the file is a first-time home buyer'),
      el('div', { class: 'field-label', style: 'margin-top:10px' }, 'THEN require these documents ("valid days" = how long an approved copy stays valid):'),
      itemsHolder,
      el('button', { class: 'btn sm secondary', onclick: () => addItemRow(null) }, '+ Add document')),
    (close) => [
      !isNew ? el('button', {
        class: 'btn danger', style: 'margin-right:auto',
        onclick: async () => {
          if (!(await confirmDialog('Delete this rule? Existing checklists keep their items.', { danger: true, confirmLabel: 'Delete' }))) return;
          await api.del(`/api/settings/rules/${r.id}`);
          close(); renderSettings('rules');
        },
      }, 'Delete') : null,
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = {
            name: name.value,
            conditions: {
              application_type_keys: typeChecks.filter((t) => t.cb.checked).map((t) => t.key),
              employment_types: empChecks.filter((t) => t.cb.checked).map((t) => t.key),
              fthb: fthb.checked ? true : undefined,
            },
            items: items.filter((i) => !i.removed).map((i) => ({
              document_type_id: i.typeSel.value, requirement: i.req.value,
              per_applicant: i.per.checked, expires_days: i.exp.value || null,
            })),
          };
          try {
            if (isNew) await api.post('/api/settings/rules', payload);
            else await api.patch(`/api/settings/rules/${r.id}`, payload);
            close(); toast('Rule saved. New and updated files will use it.', 'good'); renderSettings('rules');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Save rule'),
    ]);
}

// ------------------------------------------------------------------ email templates

async function renderTemplateSettings(body) {
  const res = await api.get('/api/settings/templates');
  body.append(el('p', { class: 'muted' },
    'Placeholders: {{client_first_name}} {{client_last_name}} {{broker_name}} {{brokerage_name}} {{application_stage}} {{document_name}} {{portal_link}} {{closing_date}}'));
  for (const t of res.templates) {
    body.append(el('div', { class: 'card tight row' },
      el('div', { class: 'grow' },
        el('div', { style: 'font-weight:600' }, t.name, t.active ? '' : el('span', { class: 'pill', style: 'margin-left:8px' }, 'Disabled')),
        el('div', { class: 'faint' }, t.subject)),
      el('button', { class: 'btn sm secondary', onclick: () => templateModal(t) }, 'Edit')));
  }
}

function templateModal(t) {
  const subject = el('input', { type: 'text', value: t.subject });
  const bodyText = el('textarea', { style: 'min-height:200px;font-family:ui-monospace,monospace;font-size:0.86rem' }, t.body);
  const active = el('input', { type: 'checkbox', checked: t.active ? '' : undefined });
  const previewHolder = el('div');

  async function preview() {
    const res = await api.post('/api/settings/templates/preview', { subject: subject.value, body: bodyText.value });
    clearNode(previewHolder);
    previewHolder.append(el('div', { class: 'card tight', style: 'background:var(--bg)' },
      el('div', { style: 'font-weight:600;margin-bottom:6px' }, res.preview.subject),
      el('div', { style: 'white-space:pre-wrap;font-size:0.88rem' }, res.preview.body)));
  }

  openModal(`Edit template: ${t.name}`,
    el('div', null,
      t.key === 'welcome'
        ? el('p', { class: 'faint' },
            'Placeholders available here include {{username}}, {{temporary_password}}, {{portal_link}}, {{application_number}} and {{service_type}} — the system fills them in for each client before sending.')
        : null,
      el('label', { class: 'field' }, el('span', null, 'Subject'), subject),
      el('label', { class: 'field' }, el('span', null, 'Body'), bodyText),
      el('label', { class: 'checkbox' }, active, 'Active (emails of this type are sent)'),
      el('button', { class: 'btn sm secondary', onclick: preview }, '👁 Preview with sample data'),
      previewHolder),
    (close) => [
      el('button', {
        class: 'btn secondary', style: 'margin-right:auto',
        onclick: async () => {
          if (!(await confirmDialog('Restore this template to the default wording? Your edits will be replaced.'))) return;
          try {
            const res = await api.post(`/api/settings/templates/${t.key}/reset`, {});
            subject.value = res.template.subject;
            bodyText.value = res.template.body;
            toast('Default wording restored.', 'good');
          } catch (err) { toast(err.message, 'bad'); }
        },
      }, 'Reset to default'),
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.patch(`/api/settings/templates/${t.key}`, { subject: subject.value, body: bodyText.value, active: active.checked });
            close(); toast('Template saved.', 'good'); renderSettings('templates');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Save'),
    ]);
}

// ------------------------------------------------------------------ reminders & automation

async function renderAutomationSettings(body) {
  const reminders = (await api.get('/api/settings/config/reminders')).value || {};
  const automation = (await api.get('/api/settings/config/automation')).value || {};

  const enabled = el('input', { type: 'checkbox', checked: reminders.enabled !== false ? '' : undefined });
  const cadence = el('input', { type: 'text', value: (reminders.cadence_days || [2, 5, 7]).join(', '), placeholder: '2, 5, 7' });
  const maxReminders = el('input', { type: 'number', value: reminders.max_reminders ?? 3 });
  const minHours = el('input', { type: 'number', value: reminders.min_hours_between ?? 24 });
  const taskOnDocs = el('input', { type: 'checkbox', checked: automation.task_on_all_docs_uploaded !== false ? '' : undefined });
  const notifyAll = el('input', { type: 'checkbox', checked: automation.notify_all_staff_if_unassigned !== false ? '' : undefined });

  body.append(
    el('div', { class: 'card' },
      el('h3', null, 'Automatic document reminders'),
      el('p', { class: 'muted small' }, 'Reminders stop automatically as soon as the document is received. Clients are never reminded more often than the limits below.'),
      el('label', { class: 'checkbox' }, enabled, 'Send automatic reminders for outstanding documents'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Remind after days (e.g. 2, 5, 7)'), cadence),
        el('label', { class: 'field' }, el('span', null, 'Maximum reminders per document'), maxReminders),
        el('label', { class: 'field' }, el('span', null, 'Minimum hours between reminders'), minHours)),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.put('/api/settings/config/reminders', {
              value: {
                enabled: enabled.checked,
                cadence_days: cadence.value.split(',').map((s) => Number(s.trim())).filter((n) => n > 0),
                max_reminders: Number(maxReminders.value) || 3,
                min_hours_between: Number(minHours.value) || 24,
              },
            });
            toast('Reminder settings saved.', 'good');
          } catch (err) { toast(err.message, 'bad'); }
          e.target.disabled = false;
        },
      }, 'Save reminders')),
    el('div', { class: 'card' },
      el('h3', null, 'Automation'),
      el('label', { class: 'checkbox' }, taskOnDocs, 'Create a "Review document package" task when every required document is in'),
      el('label', { class: 'checkbox' }, notifyAll, 'Notify all staff when an unassigned file needs attention'),
      el('p', { class: 'faint' }, 'Per-stage automation (emails and tasks on stage entry) is configured on each stage under Settings → Stages.'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.put('/api/settings/config/automation', {
              value: { ...automation, task_on_all_docs_uploaded: taskOnDocs.checked, notify_all_staff_if_unassigned: notifyAll.checked },
            });
            toast('Automation saved.', 'good');
          } catch (err) { toast(err.message, 'bad'); }
          e.target.disabled = false;
        },
      }, 'Save automation')));
}

// ------------------------------------------------------------------ team & permissions

async function renderTeamSettings(body) {
  if (!can('users.manage')) {
    body.append(el('div', { class: 'card empty' }, el('p', null, 'Team management requires the "users.manage" permission.')));
    return;
  }
  const res = await api.get('/api/settings/users');

  body.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('p', { class: 'muted grow', style: 'margin:0' }, 'Brokerage staff accounts and what each role can do.'),
      el('button', { class: 'btn sm', onclick: () => staffModal() }, '+ Invite team member')),
    el('div', { class: 'card table-wrap' }, el('table', { class: 'data' },
      el('thead', null, el('tr', null, ['Name', 'Email', 'Role', 'Status', ''].map((h) => el('th', null, h)))),
      el('tbody', null, res.users.map((u) => el('tr', null,
        el('td', { style: 'font-weight:600' }, `${u.first_name} ${u.last_name}`),
        el('td', null, u.email),
        el('td', null, roleSelect(u)),
        el('td', null, el('span', { class: `pill ${u.status === 'active' ? 'good' : u.status === 'disabled' ? 'bad' : 'warn'}` }, u.status)),
        el('td', null, u.id !== BK.me.user.id ? el('button', {
          class: 'btn sm secondary',
          onclick: async () => {
            const next = u.status === 'disabled' ? 'active' : 'disabled';
            if (!(await confirmDialog(`${next === 'disabled' ? 'Disable' : 'Re-enable'} ${u.first_name}'s account?`))) return;
            await api.patch(`/api/settings/users/${u.id}`, { status: next });
            renderSettings('team');
          },
        }, u.status === 'disabled' ? 'Enable' : 'Disable') : el('span', { class: 'faint' }, 'You'))))))));

  if (can('settings.manage')) body.append(await permissionMatrix());

  function roleSelect(u) {
    if (u.id === BK.me.user.id) return el('span', null, u.role);
    const sel = el('select', { style: 'min-width:120px' }, BK.meta.staff_roles.map((r) =>
      el('option', { value: r, selected: u.role === r ? '' : undefined }, r)));
    sel.addEventListener('change', async () => {
      try {
        await api.patch(`/api/settings/users/${u.id}`, { role: sel.value });
        toast('Role updated.', 'good');
      } catch (err) { toast(err.message, 'bad'); renderSettings('team'); }
    });
    return sel;
  }
}

async function permissionMatrix() {
  const { value } = await api.get('/api/settings/config/role_permissions');
  const perms = BK.meta.permissions;
  const roles = BK.meta.staff_roles;
  const map = value || {};
  const grid = el('div', { class: 'perm-grid' }, el('div', { class: 'head' }, 'Permission'),
    roles.map((r) => el('div', { class: 'head' }, r)));
  const checks = {};
  for (const p of perms) {
    grid.append(el('div', null, p));
    for (const r of roles) {
      const cb = el('input', { type: 'checkbox', checked: (map[r] || []).includes(p) ? '' : undefined, 'aria-label': `${r}: ${p}` });
      if (r === 'admin') { cb.checked = true; cb.disabled = true; }
      checks[`${r}:${p}`] = cb;
      grid.append(cb);
    }
  }
  return el('div', { class: 'card' },
    el('h3', null, 'Role permissions'),
    el('div', { class: 'table-wrap' }, grid),
    el('button', {
      class: 'btn', style: 'margin-top:12px',
      onclick: async (e) => {
        e.target.disabled = true;
        const next = {};
        for (const r of roles) next[r] = perms.filter((p) => r === 'admin' || checks[`${r}:${p}`].checked);
        try {
          await api.put('/api/settings/config/role_permissions', { value: next });
          toast('Permissions saved.', 'good');
        } catch (err) { toast(err.message, 'bad'); }
        e.target.disabled = false;
      },
    }, 'Save permissions'));
}

function staffModal() {
  const first = el('input', { type: 'text' });
  const last = el('input', { type: 'text' });
  const email = el('input', { type: 'email' });
  const role = el('select', null, BK.meta.staff_roles.map((r) => el('option', { value: r, selected: r === 'broker' ? '' : undefined }, r)));
  openModal('Invite a team member',
    el('div', null,
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'First name'), first),
        el('label', { class: 'field' }, el('span', null, 'Last name'), last)),
      el('label', { class: 'field' }, el('span', null, 'Email'), email),
      el('label', { class: 'field' }, el('span', null, 'Role'), role)),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const res = await api.post('/api/settings/users', {
              first_name: first.value, last_name: last.value, email: email.value, role: role.value,
            });
            close(); inviteLinkModal(res.activation_link); renderSettings('team');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Invite'),
    ]);
}

// ------------------------------------------------------------------ consent forms

async function renderConsentSettings(body) {
  const res = await api.get('/api/settings/consent-forms');
  body.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('p', { class: 'muted grow', style: 'margin:0' },
        'Upload the exact consent and disclosure wording your brokerage uses. The version a client accepts is preserved permanently.'),
      el('button', { class: 'btn sm', onclick: () => consentFormModal(null) }, '+ Add form')),
    res.forms.length === 0
      ? el('div', { class: 'card empty' }, el('p', null, 'No consent forms configured yet.'))
      : el('div', null, res.forms.map((f) => el('div', { class: 'card tight row' },
          el('div', { class: 'grow' },
            el('div', { style: 'font-weight:600' }, f.title, f.active ? '' : el('span', { class: 'pill', style: 'margin-left:8px' }, 'Disabled')),
            el('div', { class: 'faint' }, `Version ${f.version} · ${fmtDate(f.created_at)}`)),
          el('button', { class: 'btn sm secondary', onclick: () => consentFormModal(f) }, 'Edit')))));
}

function consentFormModal(f) {
  const isNew = !f;
  const c = f || {};
  const title = el('input', { type: 'text', value: c.title || '' });
  const bodyText = el('textarea', { style: 'min-height:220px' }, c.body || '');
  const active = el('input', { type: 'checkbox', checked: (isNew || c.active) ? '' : undefined });
  openModal(isNew ? 'Add consent form' : `Edit: ${c.title}`,
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Title'), title),
      el('label', { class: 'field' }, el('span', null, 'Exact wording (provided by your brokerage / counsel)'), bodyText),
      el('label', { class: 'checkbox' }, active, 'Active'),
      isNew ? null : el('p', { class: 'faint' }, 'Editing the wording creates a new version. Clients who accepted an older version keep that exact text on record.')),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            if (isNew) await api.post('/api/settings/consent-forms', { title: title.value, body: bodyText.value });
            else await api.patch(`/api/settings/consent-forms/${c.id}`, { title: title.value, body: bodyText.value, active: active.checked });
            close(); renderSettings('consents');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Save'),
    ]);
}
