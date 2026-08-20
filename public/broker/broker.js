'use strict';

/* Broker portal SPA — main router and top-level views.
   Routes:
     #/dashboard  #/clients  #/clients/new  #/files/:id[/:tab]
     #/tasks  #/reports  #/notifications  #/settings[/:section]      */

const view = document.getElementById('view');

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    BK.me = await api.get('/api/auth/me');
  } catch {
    window.location.href = '/login';
    return;
  }
  if (BK.me.must_change_password) {
    window.location.href = '/change-password';
    return;
  }
  if (!BK.me.is_staff) {
    window.location.href = '/portal';
    return;
  }
  applyBranding(BK.me.brokerage);
  BK.meta = await api.get('/api/settings/meta');
  try {
    BK.staff = (await api.get('/api/broker/staff')).staff;
  } catch { BK.staff = []; }

  document.getElementById('brand-name').textContent = (BK.me.brokerage.name || 'Broker Portal');
  document.getElementById('brand-mark').textContent = (BK.me.brokerage.logo_text || (BK.me.brokerage.name || 'M')[0]).slice(0, 2).toUpperCase();
  document.getElementById('side-user').textContent = `${BK.me.user.first_name} ${BK.me.user.last_name} · ${BK.me.user.role}`;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api.post('/api/auth/logout', {});
    window.location.href = '/login';
  });
  document.getElementById('menu-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target.id !== 'menu-btn') {
      sidebar.classList.remove('open');
    }
  });
  document.getElementById('notif-btn').addEventListener('click', () => { window.location.hash = '#/notifications'; });
  if (!can('settings.manage') && !can('users.manage')) {
    document.getElementById('nav-settings').classList.add('hidden');
  }
  if (!can('clients.create')) document.getElementById('new-client-btn').classList.add('hidden');

  setupGlobalSearch();
  updateNotifBadge();
  setInterval(updateNotifBadge, 30000);

  window.addEventListener('hashchange', route);
  route();
}

async function updateNotifBadge() {
  try {
    const me = await api.get('/api/auth/me');
    const badge = document.getElementById('notif-badge');
    badge.classList.toggle('hidden', !me.unread_notifications);
    badge.textContent = me.unread_notifications > 9 ? '9+' : me.unread_notifications;
  } catch { /* transient */ }
}

// ------------------------------------------------------------------ router

function route() {
  const hash = window.location.hash || '#/dashboard';
  const parts = hash.slice(2).split('/');
  document.querySelectorAll('.side-nav a').forEach((a) => {
    a.classList.toggle('active', hash.startsWith('#/' + a.dataset.nav) || (a.dataset.nav === 'clients' && parts[0] === 'files'));
  });
  document.getElementById('sidebar').classList.remove('open');
  if (typeof stopBrokerChat === 'function') stopBrokerChat();

  if (parts[0] === 'clients' && parts[1] === 'new') renderNewClient();
  else if (parts[0] === 'clients') renderClients();
  else if (parts[0] === 'files' && parts[1]) renderFileView(Number(parts[1]), parts[2]);
  else if (parts[0] === 'tasks') renderTasksPage();
  else if (parts[0] === 'reports') renderReports();
  else if (parts[0] === 'notifications') renderNotificationsPage();
  else if (parts[0] === 'settings') renderSettings(parts[1]);
  else renderDashboard();
}

function setView(...nodes) {
  clearNode(view);
  view.append(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ global search

function setupGlobalSearch() {
  const input = document.getElementById('global-search');
  const results = document.getElementById('search-results');
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.classList.add('hidden'); return; }
    try {
      const res = await api.get(`/api/broker/search?q=${encodeURIComponent(q)}`);
      clearNode(results);
      if (res.results.length === 0) {
        results.append(el('div', { class: 'item muted' }, 'No matching clients found.'));
      }
      for (const f of res.results) {
        results.append(el('div', {
          class: 'item',
          onclick: () => { results.classList.add('hidden'); input.value = ''; goFile(f.id); },
        },
          el('div', { class: 'row' },
            el('span', { style: 'font-weight:600' }, f.client_name),
            stageDot(f.stage), el('span', { class: 'faint' }, f.file_number)),
          f.property_address ? el('div', { class: 'faint' }, f.property_address) : null));
      }
      results.classList.remove('hidden');
    } catch { /* ignore */ }
  }, 250);
  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  document.addEventListener('click', (e) => {
    if (!results.contains(e.target) && e.target !== input) results.classList.add('hidden');
  });
}

// ------------------------------------------------------------------ dashboard

async function renderDashboard() {
  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:160px' })));
  const mineOnly = localStorage.getItem('dash_mine') === '1';
  const d = await api.get(`/api/broker/dashboard${mineOnly ? '?mine=1' : ''}`);

  const stat = (n, label, cls, onclick) => el('button', { class: `stat ${cls || ''}`, onclick },
    el('div', { class: 'n' }, String(n)), el('div', { class: 'lbl' }, label));

  const mineToggle = el('label', { class: 'checkbox', style: 'margin:0' },
    el('input', {
      type: 'checkbox', checked: mineOnly ? '' : undefined,
      onchange: (e) => { localStorage.setItem('dash_mine', e.target.checked ? '1' : '0'); renderDashboard(); },
    }), el('span', { class: 'small' }, 'My clients only'));

  const attentionList = d.attention.length === 0
    ? el('div', { class: 'card empty' },
        el('div', { class: 'big' }, '☕'),
        el('h3', null, "You're all caught up"),
        el('p', null, 'No clients need your attention right now.'))
    : el('div', { class: 'card' },
        el('ul', { class: 'list' }, d.attention.map((a) => el('li', {
          class: 'attention-item', role: 'button', tabindex: '0',
          onclick: () => goFile(a.file_id),
          onkeydown: (e) => { if (e.key === 'Enter') goFile(a.file_id); },
        },
          el('div', { class: 'row wrap' },
            el('span', { style: 'font-weight:700' }, a.client_name),
            stageDot(a.stage),
            el('span', { class: 'faint' }, a.file_number)),
          el('div', { class: 'reason-tags' }, a.reasons.map((r) => el('span', {
            class: `pill ${{ review: 'info', message: 'brand', outstanding: 'warn', task_overdue: 'bad', task_today: 'warn' }[r.kind] || ''}`,
          }, `${{ review: '📥', message: '💬', outstanding: '📄', task_overdue: '⏰', task_today: '📅' }[r.kind] || ''} ${r.text}${r.latest ? ' · ' + timeAgo(r.latest) : ''}`)))))));

  const taskCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h3', null, "Today's tasks & overdue"),
      el('div', { class: 'spacer' }),
      el('a', { class: 'btn-link small', href: '#/tasks' }, 'All tasks →')),
    d.tasks.length === 0
      ? el('p', { class: 'muted' }, 'Nothing due today. 🎉')
      : el('ul', { class: 'list' }, d.tasks.map((t) => taskRow(t, renderDashboard))));

  const recentCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h3', null, 'Recently active files')),
    d.recent.length === 0
      ? el('p', { class: 'muted' }, 'No files yet — create your first client to get started.')
      : el('ul', { class: 'list' }, d.recent.map((f) => el('li', {
          class: 'attention-item row wrap', role: 'button', tabindex: '0', onclick: () => goFile(f.id),
        },
          el('div', { class: 'grow' },
            el('div', { style: 'font-weight:600' }, f.client_name),
            el('div', { class: 'faint' }, `${f.file_number} · ${f.application_type || ''} · updated ${timeAgo(f.last_activity_at || f.updated_at)}`)),
          stageDot(f.stage)))));

  setView(
    el('div', { class: 'row', style: 'margin-bottom:14px' },
      el('div', null,
        el('h1', null, `${greeting()}, ${BK.me.user.first_name}.`),
        el('p', { class: 'muted', style: 'margin:0' }, 'Here is what needs your attention.')),
      el('div', { class: 'spacer' }), mineToggle),
    el('div', { class: 'stat-grid' },
      stat(d.cards.documents_awaiting_review, 'Documents to review', d.cards.documents_awaiting_review ? 'warm' : '', () => { window.location.hash = '#/clients?filter=awaiting_review'; }),
      stat(d.cards.documents_outstanding_files, 'Files waiting on client docs', '', () => { window.location.hash = '#/clients?filter=outstanding_docs'; }),
      stat(d.cards.unread_messages, 'Unread client messages', d.cards.unread_messages ? 'warm' : '', () => { window.location.hash = '#/clients?filter=unread_messages'; }),
      stat(d.cards.tasks_today, 'Follow-ups due today', '', () => { window.location.hash = '#/tasks?filter=today'; }),
      stat(d.cards.tasks_overdue, 'Overdue follow-ups', d.cards.tasks_overdue ? 'hot' : '', () => { window.location.hash = '#/tasks?filter=overdue'; }),
      stat(d.cards.active_clients, 'Active clients', '', () => { window.location.hash = '#/clients'; })),
    el('h2', null, 'Needs your attention'),
    attentionList,
    el('div', { class: 'form-row cols-2', style: 'gap:16px' }, taskCard, recentCard));
}

// ------------------------------------------------------------------ clients list

const SAVED_VIEWS = [
  ['', 'All active'],
  ['awaiting_review', 'Docs to review'],
  ['outstanding_docs', 'Waiting on client'],
  ['unread_messages', 'Unread messages'],
  ['closing_month', 'Closing this month'],
  ['stale', 'No recent activity'],
];

async function renderClients() {
  const params = new URLSearchParams((window.location.hash.split('?')[1] || ''));
  const filter = params.get('filter') || '';
  const stageId = params.get('stage_id') || '';
  const typeId = params.get('type_id') || '';
  const assigned = params.get('assigned_to') || '';
  const status = params.get('status') || 'active';
  const q = params.get('q') || '';

  function nav(next) {
    const p = new URLSearchParams({ filter, stage_id: stageId, type_id: typeId, assigned_to: assigned, status, q, ...next });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    window.location.hash = `#/clients${p.toString() ? '?' + p.toString() : ''}`;
  }

  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:160px' })));
  const query = new URLSearchParams({ filter, stage_id: stageId, type_id: typeId, assigned_to: assigned, status, q });
  const res = await api.get(`/api/broker/clients?${query.toString()}`);

  const chips = el('div', { class: 'chips' }, SAVED_VIEWS.map(([key, label]) =>
    el('button', { class: `chip ${filter === key ? 'active' : ''}`, onclick: () => nav({ filter: key }) }, label)),
    el('button', { class: `chip ${assigned === String(BK.me.user.id) ? 'active' : ''}`, onclick: () => nav({ assigned_to: assigned === String(BK.me.user.id) ? '' : String(BK.me.user.id) }) }, 'My clients'));

  const searchInput = el('input', { type: 'search', placeholder: 'Filter by name, file #, address…', value: q });
  searchInput.addEventListener('input', debounce(() => nav({ q: searchInput.value }), 350));

  const stageSel = el('select', null, el('option', { value: '' }, 'Any stage'),
    BK.meta.stages.map((s) => el('option', { value: s.id, selected: stageId === String(s.id) ? '' : undefined }, s.name)));
  stageSel.addEventListener('change', () => nav({ stage_id: stageSel.value }));
  const typeSel = el('select', null, el('option', { value: '' }, 'Any type'),
    BK.meta.application_types.map((t) => el('option', { value: t.id, selected: typeId === String(t.id) ? '' : undefined }, t.name)));
  typeSel.addEventListener('change', () => nav({ type_id: typeSel.value }));
  const statusSel = el('select', null, ['active', 'completed', 'cancelled', 'archived', 'all'].map((s) =>
    el('option', { value: s, selected: status === s ? '' : undefined }, s)));
  statusSel.addEventListener('change', () => nav({ status: statusSel.value }));

  const selected = new Set();
  const bulkBar = el('div', { class: 'bulk-bar hidden' });
  function paintBulkBar() {
    clearNode(bulkBar);
    bulkBar.classList.toggle('hidden', selected.size === 0);
    if (selected.size === 0) return;
    bulkBar.append(
      el('span', null, `${selected.size} selected`),
      el('div', { class: 'spacer' }),
      can('documents.request') ? el('button', {
        class: 'btn sm',
        onclick: async () => {
          if (!(await confirmDialog(`Send document reminders to ${selected.size} client${selected.size > 1 ? 's' : ''}? Clients with nothing outstanding are skipped, and frequency limits still apply.`))) return;
          const r = await api.post('/api/broker/bulk', { action: 'remind', file_ids: [...selected] });
          toast(`${r.sent} reminder${r.sent === 1 ? '' : 's'} sent.`, 'good');
          renderClients();
        },
      }, '⏰ Send reminders') : null,
      can('clients.edit') ? el('button', {
        class: 'btn sm secondary',
        onclick: () => {
          const sel = el('select', null, BK.staff.map((s) => el('option', { value: s.id }, `${s.first_name} ${s.last_name}`)));
          openModal('Assign selected clients', el('label', { class: 'field' }, el('span', null, 'Assign to'), sel), (close) => [
            el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
            el('button', {
              class: 'btn',
              onclick: async () => {
                const r = await api.post('/api/broker/bulk', { action: 'assign', file_ids: [...selected], broker_id: sel.value });
                close(); toast(`${r.updated} file${r.updated === 1 ? '' : 's'} reassigned.`, 'good'); renderClients();
              },
            }, 'Assign'),
          ]);
        },
      }, '🤝 Assign') : null,
      el('button', { class: 'btn sm secondary', onclick: () => { selected.clear(); renderClients(); } }, 'Clear'));
  }

  const rows = res.clients.map((c) => {
    const cb = el('input', { type: 'checkbox', 'aria-label': `Select ${c.client_name}`, onclick: (e) => e.stopPropagation() });
    cb.addEventListener('change', () => { cb.checked ? selected.add(c.id) : selected.delete(c.id); paintBulkBar(); });
    return el('tr', { class: 'clickable', onclick: () => goFile(c.id) },
      el('td', null, cb),
      el('td', null,
        el('div', { style: 'font-weight:600' }, c.client_name, c.applicant_count > 1 ? el('span', { class: 'faint' }, ` +${c.applicant_count - 1}`) : ''),
        el('div', { class: 'faint' }, c.file_number)),
      el('td', null, c.application_type || '—'),
      el('td', null, stageDot(c.stage)),
      el('td', null,
        c.checklist.total_required
          ? el('span', { class: `pill ${c.checklist.complete ? 'good' : c.checklist.outstanding ? 'warn' : 'info'}` },
              `${c.checklist.approved}/${c.checklist.total_required}`)
          : el('span', { class: 'faint' }, '—'),
        c.checklist.awaiting_review ? el('span', { class: 'pill info', style: 'margin-left:4px' }, `${c.checklist.awaiting_review} to review`) : null,
        c.unread_messages ? el('span', { class: 'pill brand', style: 'margin-left:4px' }, '💬') : null),
      el('td', { class: 'nowrap' }, c.closing_date ? fmtDate(c.closing_date) : '—'),
      el('td', { class: 'nowrap faint' }, timeAgo(c.last_activity_at || c.updated_at)),
      el('td', null, c.assigned_broker ? c.assigned_broker.name : el('span', { class: 'faint' }, '—')));
  });

  setView(
    el('div', { class: 'row', style: 'margin-bottom:10px' },
      el('h1', { class: 'grow' }, 'Clients'),
      can('clients.create') ? el('a', { class: 'btn', href: '#/clients/new' }, '+ New client') : null),
    chips,
    el('div', { class: 'filter-bar' }, searchInput, stageSel, typeSel, statusSel,
      el('span', { class: 'faint' }, `${res.total} file${res.total === 1 ? '' : 's'}`)),
    res.clients.length === 0
      ? el('div', { class: 'card empty' },
          el('div', { class: 'big' }, '🔍'),
          el('h3', null, 'No clients match'),
          el('p', null, q || filter ? 'Try adjusting your filters or search.' : 'Create your first client to get started.'))
      : el('div', { class: 'card table-wrap', style: 'padding:0 6px' },
          el('table', { class: 'data' },
            el('thead', null, el('tr', null, ['', 'Client', 'Type', 'Stage', 'Documents', 'Closing', 'Activity', 'Assigned'].map((h) => el('th', null, h)))),
            el('tbody', null, rows))),
    bulkBar);
}

// ------------------------------------------------------------------ new client

/**
 * Guided Add Client wizard.
 *
 * Step 1 service → Step 2 employment → Step 3 the checklist the rules
 * generate (which the broker edits for THIS client only) → Step 4 client
 * details → create. Wizard state lives here; nothing is written until the
 * final step, and edits to the checklist never touch the global rules.
 */
const wiz = {
  step: 1,
  service: null,        // application_types row
  employment: null,     // employment_statuses row
  fthb: false,
  checklist: [],        // [{ document_type_id, document_name, category, requirement, instructions, due_date }]
  removed: [],          // defaults the broker took off this client's list
  client: {},
  coApplicants: [],
  creating: false,
};

function resetWizard() {
  wiz.step = 1;
  wiz.service = null;
  wiz.employment = null;
  wiz.fthb = false;
  wiz.checklist = [];
  wiz.removed = [];
  wiz.client = {};
  wiz.coApplicants = [];
  wiz.creating = false;
}

function wizardHeader() {
  const steps = ['Service', 'Employment', 'Documents', 'Client details'];
  return el('div', { class: 'wiz-steps' }, steps.map((label, i) => {
    const n = i + 1;
    return el('div', { class: `wiz-step ${n < wiz.step ? 'done' : n === wiz.step ? 'now' : ''}` },
      el('div', { class: 'bubble' }, n < wiz.step ? '✓' : String(n)),
      el('div', { class: 'lbl' }, label));
  }));
}

function renderNewClient() {
  if (!can('clients.create')) {
    setView(el('div', { class: 'card empty' }, el('p', null, 'You do not have permission to create clients.')));
    return;
  }
  if (wiz.step === 1) return wizardStepService();
  if (wiz.step === 2) return wizardStepEmployment();
  if (wiz.step === 3) return wizardStepDocuments();
  return wizardStepDetails();
}

// ------------------------------------------------------------- step 1

function wizardStepService() {
  const services = BK.meta.application_types.filter((t) => t.active);
  setView(
    el('h1', null, 'New client'),
    wizardHeader(),
    el('div', { class: 'card' },
      el('h2', null, 'What type of service does this client need?'),
      el('p', { class: 'muted' }, 'This drives the documents we ask for. You can change it later.'),
      services.length === 0
        ? el('p', { class: 'muted' }, 'No services are configured yet. Add them under Settings → Client services.')
        : el('div', { class: 'choice-grid' }, services.map((s) =>
            el('button', {
              class: `choice ${wiz.service && wiz.service.id === s.id ? 'selected' : ''}`,
              onclick: () => { wiz.service = s; wiz.step = 2; renderNewClient(); },
            },
              el('span', { class: 'choice-name' }, s.name),
              el('span', { class: 'choice-go' }, '→')))),
      el('div', { class: 'row', style: 'margin-top:14px' },
        el('a', { class: 'btn secondary', href: '#/clients', onclick: resetWizard }, 'Cancel')))
  );
}

// ------------------------------------------------------------- step 2

function wizardStepEmployment() {
  const statuses = (BK.meta.employment_statuses || []).filter((s) => s.active);
  setView(
    el('h1', null, 'New client'),
    wizardHeader(),
    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('h2', { class: 'grow' }, "What is the client's employment status?"),
        el('span', { class: 'pill brand' }, wiz.service.name)),
      el('p', { class: 'muted' }, 'Combined with the service, this decides the default document checklist.'),
      statuses.length === 0
        ? el('p', { class: 'muted' }, 'No employment statuses are configured yet. Add them under Settings → Employment statuses.')
        : el('div', { class: 'choice-grid' }, statuses.map((s) =>
            el('button', {
              class: `choice ${wiz.employment && wiz.employment.id === s.id ? 'selected' : ''}`,
              onclick: () => { wiz.employment = s; wiz.step = 3; loadWizardChecklist(); },
            },
              el('span', { class: 'choice-name' }, s.name),
              el('span', { class: 'choice-go' }, '→')))),
      el('label', { class: 'checkbox', style: 'margin-top:14px' },
        el('input', {
          type: 'checkbox', checked: wiz.fthb ? '' : undefined,
          onchange: (e) => { wiz.fthb = e.target.checked; },
        }), 'This is a first-time home buyer'),
      el('div', { class: 'row', style: 'margin-top:14px' },
        el('button', { class: 'btn secondary', onclick: () => { wiz.step = 1; renderNewClient(); } }, '← Back')))
  );
}

// ------------------------------------------------------------- step 3

async function loadWizardChecklist() {
  setView(el('h1', null, 'New client'), wizardHeader(),
    el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:180px' })));
  try {
    const params = new URLSearchParams({
      application_type_id: wiz.service.id,
      employment_type: wiz.employment.key,
      fthb: wiz.fthb ? '1' : '0',
    });
    const res = await api.get(`/api/broker/checklist-preview?${params}`);
    wiz.checklist = res.documents.map((d) => ({
      document_type_id: d.document_type_id,
      document_name: d.document_name,
      category: d.category,
      requirement: d.requirement,
      instructions: d.instructions || '',
      due_date: '',
      from_rule: true,
    }));
    wiz.removed = [];
  } catch (err) {
    toast(err.message, 'bad');
    wiz.checklist = [];
  }
  wizardStepDocuments();
}

const CATEGORY_LABEL = {
  identity: 'Identity', credit: 'Credit', income: 'Income / Tax',
  property: 'Property', financial: 'Assets', corporate: 'Corporate', other: 'Other',
};

function wizardStepDocuments() {
  const byCategory = new Map();
  for (const doc of wiz.checklist) {
    const key = doc.category || 'other';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(doc);
  }

  const groups = [...byCategory.entries()].map(([category, docs]) =>
    el('div', { class: 'doc-group' },
      el('div', { class: 'doc-group-title' }, CATEGORY_LABEL[category] || category),
      el('ul', { class: 'list' }, docs.map((doc) => el('li', { class: 'row top wrap' },
        el('div', { class: 'grow' },
          el('div', { class: 'row wrap' },
            el('span', { style: 'font-weight:600' }, doc.document_name),
            doc.requirement === 'optional' ? el('span', { class: 'pill' }, 'Optional') : null,
            doc.from_rule ? null : el('span', { class: 'pill brand' }, 'Added')),
          doc.instructions
            ? el('div', { class: 'small muted', style: 'margin-top:2px' }, doc.instructions)
            : null),
        el('div', { class: 'row' },
          el('button', { class: 'btn sm secondary', onclick: () => editWizardDoc(doc) }, 'Edit'),
          el('button', {
            class: 'btn sm secondary', style: 'color:var(--bad)',
            onclick: () => {
              wiz.checklist = wiz.checklist.filter((d) => d !== doc);
              if (doc.from_rule) wiz.removed.push(doc);
              wizardStepDocuments();
            },
          }, 'Remove'))
      ))))
  );

  const restore = wiz.removed.length ? el('div', { class: 'card tight' },
    el('div', { class: 'faint', style: 'margin-bottom:6px' }, 'Removed for this client (global defaults are unchanged):'),
    el('div', { class: 'row wrap' }, wiz.removed.map((doc) =>
      el('button', {
        class: 'chip',
        onclick: () => {
          wiz.removed = wiz.removed.filter((d) => d !== doc);
          wiz.checklist.push(doc);
          wizardStepDocuments();
        },
      }, `+ ${doc.document_name}`)))) : null;

  setView(
    el('h1', null, 'New client'),
    wizardHeader(),
    el('div', { class: 'card' },
      el('div', { class: 'row wrap' },
        el('h2', { class: 'grow' }, 'Documents required'),
        el('span', { class: 'pill brand' }, wiz.service.name),
        el('span', { class: 'pill' }, wiz.employment.name),
        wiz.fthb ? el('span', { class: 'pill' }, 'First-time buyer') : null),
      el('p', { class: 'muted' },
        `${wiz.checklist.length} document${wiz.checklist.length === 1 ? '' : 's'} selected automatically from your document rules. Adjust them for this client — your global defaults stay as they are.`),
      wiz.checklist.length === 0
        ? el('div', { class: 'empty', style: 'padding:18px' },
            el('p', null, 'No documents are configured for this combination yet. Add them below, or set up a rule under Settings → Document rules.'))
        : el('div', null, groups),
      el('button', { class: 'btn subtle', style: 'margin-top:10px', onclick: addWizardDocModal }, '+ Add document')),
    restore,
    el('div', { class: 'row' },
      el('button', { class: 'btn secondary', onclick: () => { wiz.step = 2; renderNewClient(); } }, '← Back'),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: () => { wiz.step = 4; renderNewClient(); } }, 'Continue to client details →'))
  );
}

function editWizardDoc(doc) {
  const requirement = el('select', null,
    el('option', { value: 'required', selected: doc.requirement === 'required' ? '' : undefined }, 'Required'),
    el('option', { value: 'optional', selected: doc.requirement === 'optional' ? '' : undefined }, 'Optional'));
  const instructions = el('textarea', { placeholder: 'What the client should know about this document' }, doc.instructions || '');
  const due = el('input', { type: 'date', value: doc.due_date || '' });
  openModal(`Edit: ${doc.document_name}`,
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Required or optional'), requirement),
      el('label', { class: 'field' }, el('span', null, 'Instructions shown to the client'), instructions),
      el('label', { class: 'field' }, el('span', null, 'Due date (optional)'), due),
      el('p', { class: 'faint' }, 'These changes apply to this client only.')),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: () => {
          doc.requirement = requirement.value;
          doc.instructions = instructions.value;
          doc.due_date = due.value;
          close();
          wizardStepDocuments();
        },
      }, 'Save'),
    ]);
}

function addWizardDocModal() {
  const search = el('input', { type: 'search', placeholder: 'Search the document catalog…', autocomplete: 'off' });
  const results = el('div', { style: 'max-height:46vh;overflow-y:auto' });

  async function run() {
    const res = await api.get(`/api/settings/document-types/search?q=${encodeURIComponent(search.value.trim())}`);
    clearNode(results);
    const chosen = new Set(wiz.checklist.map((d) => d.document_type_id));
    const list = res.document_types.filter((t) => !chosen.has(t.id));
    if (list.length === 0) {
      results.append(el('p', { class: 'muted' }, 'No other documents match. Admins can create new document types under Settings → Document catalog.'));
      return;
    }
    for (const t of list) {
      results.append(el('div', { class: 'card tight row' },
        el('div', { class: 'grow' },
          el('div', { style: 'font-weight:600' }, t.name),
          el('div', { class: 'faint' }, CATEGORY_LABEL[t.category] || t.category),
          t.description ? el('div', { class: 'small muted' }, t.description) : null),
        el('button', {
          class: 'btn sm',
          onclick: (e) => {
            wiz.checklist.push({
              document_type_id: t.id,
              document_name: t.name,
              category: t.category,
              requirement: t.default_requirement === 'optional' ? 'optional' : 'required',
              instructions: t.description || '',
              due_date: '',
              from_rule: false,
            });
            e.target.closest('.modal-backdrop').remove();
            wizardStepDocuments();
          },
        }, 'Add')));
    }
  }
  search.addEventListener('input', debounce(run, 200));
  openModal('Add a document', el('div', null, search, el('div', { style: 'height:10px' }), results),
    (close) => [el('button', { class: 'btn secondary', onclick: close }, 'Done')]);
  run();
}

// ------------------------------------------------------------- step 4

function wizardStepDetails() {
  const f = {
    first_name: el('input', { type: 'text', value: wiz.client.first_name || '' }),
    middle_name: el('input', { type: 'text', value: wiz.client.middle_name || '' }),
    last_name: el('input', { type: 'text', value: wiz.client.last_name || '' }),
    preferred_name: el('input', { type: 'text', value: wiz.client.preferred_name || '', placeholder: 'What they like to be called' }),
    email: el('input', { type: 'email', value: wiz.client.email || '' }),
    phone: el('input', { type: 'tel', value: wiz.client.phone || '' }),
    dob: el('input', { type: 'date', value: wiz.client.dob || '' }),
    address: el('input', { type: 'text', value: wiz.client.address || '' }),
    preferred_contact: el('select', null, [['email', 'Email'], ['phone', 'Phone call'], ['text', 'Text message'], ['portal', 'Portal messages']].map(([v, l]) => el('option', { value: v }, l))),
    employer_name: el('input', { type: 'text', value: wiz.client.employer_name || '' }),
    job_title: el('input', { type: 'text', value: wiz.client.job_title || '' }),
  };
  const a = {
    purchase_price: el('input', { type: 'number', step: '1000', placeholder: '800000' }),
    down_payment: el('input', { type: 'number', step: '1000', placeholder: '160000' }),
    mortgage_amount: el('input', { type: 'number', step: '1000' }),
    property_address: el('input', { type: 'text' }),
    property_type: el('input', { type: 'text', placeholder: 'e.g. Detached, Condo' }),
    closing_date: el('input', { type: 'date' }),
    purpose: el('textarea', { placeholder: 'Anything worth noting about this application' }),
    assigned_broker_id: el('select', null, BK.staff.map((s) =>
      el('option', { value: s.id, selected: s.id === BK.me.user.id ? '' : undefined }, `${s.first_name} ${s.last_name}`))),
  };
  const sendWelcome = el('input', { type: 'checkbox', checked: '' });

  const suggestAmount = () => {
    const p = Number(a.purchase_price.value), d = Number(a.down_payment.value);
    if (p > 0 && d >= 0 && !a.mortgage_amount.dataset.touched) a.mortgage_amount.value = Math.max(0, p - d);
  };
  a.purchase_price.addEventListener('input', suggestAmount);
  a.down_payment.addEventListener('input', suggestAmount);
  a.mortgage_amount.addEventListener('input', () => { a.mortgage_amount.dataset.touched = '1'; });

  const coHolder = el('div');
  function addCoApplicant() {
    const co = {
      role: el('select', null, [['co_borrower', 'Co-borrower'], ['spouse', 'Spouse'], ['partner', 'Partner'], ['guarantor', 'Guarantor'], ['other', 'Other']].map(([v, l]) => el('option', { value: v }, l))),
      first_name: el('input', { type: 'text' }),
      last_name: el('input', { type: 'text' }),
      email: el('input', { type: 'email' }),
      phone: el('input', { type: 'tel' }),
      employment_type: el('select', null, (BK.meta.employment_statuses || []).filter((s) => s.active).map((s) => el('option', { value: s.key }, s.name))),
      invite: el('input', { type: 'checkbox' }),
      removed: false,
    };
    const card = el('div', { class: 'card', style: 'background:var(--bg)' },
      el('div', { class: 'row', style: 'margin-bottom:8px' },
        el('strong', { class: 'grow' }, 'Additional applicant'),
        el('button', { class: 'btn-link small', style: 'color:var(--bad)', onclick: () => { co.removed = true; card.remove(); } }, 'Remove')),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Role'), co.role),
        el('label', { class: 'field' }, el('span', null, 'First name'), co.first_name),
        el('label', { class: 'field' }, el('span', null, 'Last name'), co.last_name)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Email'), co.email),
        el('label', { class: 'field' }, el('span', null, 'Phone'), co.phone)),
      el('label', { class: 'field' }, el('span', null, 'Employment'), co.employment_type),
      el('label', { class: 'checkbox' }, co.invite, 'Give them their own portal access'));
    wiz.coApplicants.push(co);
    coHolder.append(card);
  }

  const errorLine = el('p', { class: 'form-error' });
  const submitBtn = el('button', { class: 'btn' }, 'Create client & send welcome email');

  async function submit(ignoreDuplicates) {
    errorLine.textContent = '';
    submitBtn.disabled = true;
    const payload = {
      client: {
        ...Object.fromEntries(Object.entries(f).map(([k, input]) => [k, input.value])),
        employment_type: wiz.employment.key,
      },
      application: {
        application_type_id: wiz.service.id,
        fthb: wiz.fthb,
        purchase_price: a.purchase_price.value,
        down_payment: a.down_payment.value,
        mortgage_amount: a.mortgage_amount.value,
        property_address: a.property_address.value,
        property_type: a.property_type.value,
        closing_date: a.closing_date.value,
        purpose: a.purpose.value,
        assigned_broker_id: a.assigned_broker_id.value,
      },
      checklist: wiz.checklist.map((d) => ({
        document_type_id: d.document_type_id,
        requirement: d.requirement,
        instructions: d.instructions,
        due_date: d.due_date || null,
      })),
      co_applicants: wiz.coApplicants.filter((c) => !c.removed).map((c) => ({
        role: c.role.value, first_name: c.first_name.value, last_name: c.last_name.value,
        email: c.email.value, phone: c.phone.value, employment_type: c.employment_type.value,
        invite: c.invite.checked,
      })),
      send_welcome: sendWelcome.checked,
      ignore_duplicates: !!ignoreDuplicates,
    };
    try {
      const res = await api.post('/api/broker/clients', payload);
      const fileId = res.file.id;
      const creds = (res.invites || []).find((i) => i.temporary_password);
      toast(`Client created — file ${res.file.file_number}.`, 'good');
      resetWizard();
      if (creds) credentialsModal(creds, () => goFile(fileId));
      else goFile(fileId);
    } catch (err) {
      if (err.status === 409 && err.data && err.data.duplicates) {
        duplicateModal(err.data.duplicates);
      } else {
        errorLine.textContent = err.message;
      }
      submitBtn.disabled = false;
    }
  }

  function duplicateModal(duplicates) {
    openModal('Possible existing client found',
      el('div', null,
        el('p', { class: 'muted' }, 'To avoid confusing duplicate records, check these existing files first:'),
        duplicates.map((d) => el('div', { class: 'card tight row' },
          el('div', { class: 'grow' },
            el('div', { style: 'font-weight:600' }, d.name),
            el('div', { class: 'faint' }, `${d.file_number} · ${d.reasons.join(', ')}`)),
          el('button', { class: 'btn sm secondary', onclick: () => { resetWizard(); goFile(d.file_id); } }, 'Open file')))),
      (close) => [
        el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
        el('button', { class: 'btn', onclick: () => { close(); submit(true); } }, 'Create new file anyway'),
      ]);
  }

  submitBtn.addEventListener('click', () => submit(false));

  setView(
    el('h1', null, 'New client'),
    wizardHeader(),
    el('div', { class: 'card tight row wrap' },
      el('span', { class: 'pill brand' }, wiz.service.name),
      el('span', { class: 'pill' }, wiz.employment.name),
      wiz.fthb ? el('span', { class: 'pill' }, 'First-time buyer') : null,
      el('span', { class: 'pill good' }, `${wiz.checklist.length} document${wiz.checklist.length === 1 ? '' : 's'}`),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn-link small', onclick: () => { wiz.step = 3; renderNewClient(); } }, 'Edit checklist')),
    el('div', { class: 'card' },
      el('h3', null, 'Client details'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'First name *'), f.first_name),
        el('label', { class: 'field' }, el('span', null, 'Middle name'), f.middle_name),
        el('label', { class: 'field' }, el('span', null, 'Last name *'), f.last_name)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Preferred name'), f.preferred_name),
        el('label', { class: 'field' }, el('span', null, 'Date of birth'), f.dob)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Email *'), f.email),
        el('label', { class: 'field' }, el('span', null, 'Mobile phone'), f.phone)),
      el('p', { class: 'faint' }, 'The email address becomes the client\'s portal username.'),
      el('label', { class: 'field' }, el('span', null, 'Current address'), f.address),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Preferred contact'), f.preferred_contact),
        el('label', { class: 'field' }, el('span', null, 'Employer'), f.employer_name),
        el('label', { class: 'field' }, el('span', null, 'Job title'), f.job_title))),
    el('div', { class: 'card' },
      el('h3', null, 'Application'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Purchase price'), a.purchase_price),
        el('label', { class: 'field' }, el('span', null, 'Down payment'), a.down_payment),
        el('label', { class: 'field' }, el('span', null, 'Mortgage amount'), a.mortgage_amount)),
      el('label', { class: 'field' }, el('span', null, 'Property address'), a.property_address),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Property type'), a.property_type),
        el('label', { class: 'field' }, el('span', null, 'Closing date'), a.closing_date),
        el('label', { class: 'field' }, el('span', null, 'Assigned broker'), a.assigned_broker_id)),
      el('label', { class: 'field' }, el('span', null, 'Notes'), a.purpose)),
    coHolder,
    el('div', { class: 'card' },
      el('button', { class: 'btn secondary', onclick: addCoApplicant }, '+ Add co-borrower / spouse / guarantor')),
    el('div', { class: 'card' },
      el('label', { class: 'checkbox' }, sendWelcome, 'Email the welcome message with portal credentials now'),
      el('p', { class: 'faint' }, 'The portal account and a secure temporary password are created automatically. The client must change it on first sign-in.'),
      errorLine,
      el('div', { class: 'row' },
        el('button', { class: 'btn secondary', onclick: () => { wiz.step = 3; renderNewClient(); } }, '← Back'),
        el('div', { class: 'spacer' }),
        submitBtn))
  );
}

/** Show the generated credentials once, so the broker can relay them if needed. */
function credentialsModal(creds, onClose) {
  openModal('Portal account created',
    el('div', null,
      el('p', { class: 'muted' }, creds.emailed
        ? 'The welcome email with these credentials has been sent. This is the only time the temporary password is shown here — it is stored only as a hash.'
        : 'Automatic sending is off, so share these with the client yourself. This is the only time the temporary password is shown — it is stored only as a hash.'),
      el('div', { class: 'card tight' },
        el('div', { class: 'faint' }, 'Portal'),
        el('div', { style: 'font-weight:600;margin-bottom:8px' }, creds.portal_link || '/login'),
        el('div', { class: 'faint' }, 'Username'),
        el('div', { style: 'font-weight:600;margin-bottom:8px' }, creds.username),
        el('div', { class: 'faint' }, 'Temporary password'),
        el('div', { style: 'font-weight:700;font-family:ui-monospace,monospace;font-size:1.05rem' }, creds.temporary_password)),
      el('p', { class: 'faint' }, 'The client is required to choose their own password the first time they sign in.')),
    (close) => [
      el('button', {
        class: 'btn secondary',
        onclick: () => {
          navigator.clipboard?.writeText(
            `Portal: ${creds.portal_link}\nUsername: ${creds.username}\nTemporary password: ${creds.temporary_password}`
          ).then(() => toast('Copied.', 'good'));
        },
      }, 'Copy details'),
      el('button', { class: 'btn', onclick: () => { close(); if (onClose) onClose(); } }, 'Done'),
    ]);
}

// ------------------------------------------------------------------ tasks page

async function renderTasksPage() {
  const params = new URLSearchParams((window.location.hash.split('?')[1] || ''));
  const filter = params.get('filter') || 'all';
  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:140px' })));
  const res = await api.get(`/api/broker/tasks?filter=${filter}`);

  const chips = el('div', { class: 'chips' }, [['all', 'Open'], ['today', 'Due today'], ['overdue', 'Overdue'], ['upcoming', 'Upcoming']].map(([key, label]) =>
    el('button', { class: `chip ${filter === key ? 'active' : ''}`, onclick: () => { window.location.hash = `#/tasks?filter=${key}`; } }, label)));

  setView(
    el('div', { class: 'row', style: 'margin-bottom:10px' },
      el('h1', { class: 'grow' }, 'Tasks & follow-ups'),
      can('tasks.manage') ? el('button', { class: 'btn', onclick: () => addTaskModal(null, renderTasksPage) }, '+ Add task') : null),
    chips,
    res.tasks.length === 0
      ? el('div', { class: 'card empty' },
          el('div', { class: 'big' }, '✅'),
          el('h3', null, 'Nothing here'),
          el('p', null, filter === 'overdue' ? 'No overdue follow-ups. Nice work.' : 'No open tasks match this view.'))
      : el('div', { class: 'card' }, el('ul', { class: 'list' }, res.tasks.map((t) => {
          const row = taskRow(t, renderTasksPage);
          if (t.file_id) {
            row.append(el('button', { class: 'btn sm secondary', onclick: () => goFile(t.file_id) }, 'Open file'));
          }
          return row;
        }))));
}

// ------------------------------------------------------------------ reports

async function renderReports() {
  if (!can('reports.view')) {
    setView(el('div', { class: 'card empty' }, el('p', null, 'Reports require the reports.view permission.')));
    return;
  }
  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:160px' })));
  const r = await api.get('/api/broker/reports');

  const maxStage = Math.max(1, ...r.by_stage.map((s) => s.n));
  const stageBars = el('div', { class: 'card' },
    el('h3', null, 'Active applications by stage'),
    r.by_stage.map((s) => el('div', { class: 'row', style: 'margin-bottom:7px' },
      el('div', { style: 'width:170px;flex:none', class: 'small' }, s.name),
      el('div', { style: 'flex:1;background:var(--bg);border-radius:6px;overflow:hidden;height:20px' },
        el('div', { style: `width:${(s.n / maxStage) * 100}%;background:${s.color};height:100%;min-width:${s.n ? '20px' : '0'};border-radius:6px;color:#fff;font-size:0.75rem;display:flex;align-items:center;justify-content:flex-end;padding:0 6px` }, s.n || '')))));

  const stat = (n, label) => el('div', { class: 'stat', style: 'cursor:default' },
    el('div', { class: 'n' }, n === null || n === undefined ? '—' : String(n)), el('div', { class: 'lbl' }, label));

  setView(
    el('h1', null, 'Reports'),
    el('div', { class: 'stat-grid' },
      stat(r.active_clients, 'Active clients'),
      stat(r.documents_outstanding, 'Documents outstanding'),
      stat(r.documents_awaiting_review, 'Awaiting review'),
      stat(r.funded_this_year, 'Funded this year'),
      stat(r.cancelled_total, 'Cancelled (all time)'),
      stat(r.overdue_followups, 'Overdue follow-ups'),
      stat(r.avg_days_in_stage, 'Avg days in current stage')),
    stageBars,
    el('div', { class: 'card' },
      el('h3', null, 'Upcoming closings (next 45 days)'),
      r.upcoming_closings.length === 0
        ? el('p', { class: 'muted' }, 'No closings scheduled in the next 45 days.')
        : el('ul', { class: 'list' }, r.upcoming_closings.map((f) => el('li', { class: 'row clickable attention-item', onclick: () => goFile(f.id) },
            el('div', { class: 'grow' },
              el('div', { style: 'font-weight:600' }, f.client_name),
              el('div', { class: 'faint' }, f.file_number)),
            stageDot(f.stage),
            el('span', { class: 'pill brand' }, fmtDate(f.closing_date)))))));
}

// ------------------------------------------------------------------ notifications page

async function renderNotificationsPage() {
  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:140px' })));
  const res = await api.get('/api/broker/notifications');
  const params = new URLSearchParams((window.location.hash.split('?')[1] || ''));
  const unreadOnly = params.get('unread') === '1';
  const list = unreadOnly ? res.notifications.filter((n) => !n.read_at) : res.notifications;

  setView(
    el('div', { class: 'row', style: 'margin-bottom:10px' },
      el('h1', { class: 'grow' }, 'Notifications'),
      el('button', { class: `chip ${unreadOnly ? 'active' : ''}`, onclick: () => { window.location.hash = `#/notifications${unreadOnly ? '' : '?unread=1'}`; } }, 'Unread only'),
      el('button', {
        class: 'btn sm secondary',
        onclick: async () => { await api.post('/api/broker/notifications/read', { all: true }); updateNotifBadge(); renderNotificationsPage(); },
      }, 'Mark all read')),
    list.length === 0
      ? el('div', { class: 'card empty' },
          el('div', { class: 'big' }, '🔔'),
          el('p', null, "You're all caught up — no notifications."))
      : el('div', { class: 'card' }, el('ul', { class: 'list' }, list.map((n) => el('li', {
          class: 'row top attention-item', style: n.read_at ? 'opacity:0.6' : '',
          onclick: async () => {
            await api.post('/api/broker/notifications/read', { ids: [n.id] }).catch(() => {});
            updateNotifBadge();
            if (n.file_id) {
              const tab = n.link && n.link.includes('/documents') ? 'documents' : n.link && n.link.includes('/messages') ? 'messages' : undefined;
              goFile(n.file_id, tab);
            } else if (n.link && n.link.startsWith('task:')) {
              window.location.hash = '#/tasks';
            } else renderNotificationsPage();
          },
        },
          el('span', null, { document_uploaded: '📤', new_message: '💬', checklist_complete: '🎉', task_overdue: '⏰', task_assigned: '➕', document_expired: '⏳', file_assigned: '🤝', client_doc_response: '💬', consent_response: '📝', stage_changed: '🚀' }[n.kind] || '🔔'),
          el('div', { class: 'grow' },
            el('div', { style: n.read_at ? '' : 'font-weight:600' }, n.title),
            n.body ? el('div', { class: 'small muted' }, n.body) : null,
            el('div', { class: 'faint' }, timeAgo(n.created_at))))))));
}

boot();
