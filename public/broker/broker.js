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

function renderNewClient() {
  if (!can('clients.create')) {
    setView(el('div', { class: 'card empty' }, el('p', null, 'You do not have permission to create clients.')));
    return;
  }
  const f = {
    first_name: el('input', { type: 'text', autocomplete: 'off' }),
    middle_name: el('input', { type: 'text' }),
    last_name: el('input', { type: 'text' }),
    preferred_name: el('input', { type: 'text', placeholder: 'What they like to be called' }),
    email: el('input', { type: 'email' }),
    phone: el('input', { type: 'tel' }),
    dob: el('input', { type: 'date' }),
    address: el('input', { type: 'text' }),
    preferred_contact: el('select', null, [['email', 'Email'], ['phone', 'Phone call'], ['text', 'Text message'], ['portal', 'Portal messages']].map(([v, l]) => el('option', { value: v }, l))),
    employment_type: el('select', null, [['', 'Not set'], ['employee', 'Employee'], ['self_employed', 'Self-employed'], ['retired', 'Retired'], ['unemployed', 'Not employed'], ['other', 'Other']].map(([v, l]) => el('option', { value: v }, l))),
    employer_name: el('input', { type: 'text' }),
    job_title: el('input', { type: 'text' }),
  };
  const a = {
    application_type_id: el('select', null, BK.meta.application_types.filter((t) => t.active).map((t) => el('option', { value: t.id }, t.name))),
    purchase_price: el('input', { type: 'number', step: '1000', placeholder: '800000' }),
    down_payment: el('input', { type: 'number', step: '1000', placeholder: '160000' }),
    mortgage_amount: el('input', { type: 'number', step: '1000' }),
    property_address: el('input', { type: 'text' }),
    property_type: el('input', { type: 'text', placeholder: 'e.g. Detached, Condo' }),
    closing_date: el('input', { type: 'date' }),
    fthb: el('input', { type: 'checkbox' }),
    purpose: el('textarea', { placeholder: 'Purpose of financing / anything worth noting' }),
    assigned_broker_id: el('select', null, BK.staff.map((s) =>
      el('option', { value: s.id, selected: s.id === BK.me.user.id ? '' : undefined }, `${s.first_name} ${s.last_name}`))),
  };
  const sendWelcome = el('input', { type: 'checkbox', checked: '' });

  // Auto-suggest mortgage amount from price - down payment.
  const suggestAmount = () => {
    const p = Number(a.purchase_price.value), d = Number(a.down_payment.value);
    if (p > 0 && d >= 0 && !a.mortgage_amount.dataset.touched) a.mortgage_amount.value = Math.max(0, p - d);
  };
  a.purchase_price.addEventListener('input', suggestAmount);
  a.down_payment.addEventListener('input', suggestAmount);
  a.mortgage_amount.addEventListener('input', () => { a.mortgage_amount.dataset.touched = '1'; });

  const coHolder = el('div');
  const coApplicants = [];
  function addCoApplicant() {
    const co = {
      role: el('select', null, [['co_borrower', 'Co-borrower'], ['spouse', 'Spouse'], ['partner', 'Partner'], ['guarantor', 'Guarantor'], ['other', 'Other']].map(([v, l]) => el('option', { value: v }, l))),
      first_name: el('input', { type: 'text' }),
      last_name: el('input', { type: 'text' }),
      email: el('input', { type: 'email' }),
      phone: el('input', { type: 'tel' }),
      employment_type: el('select', null, [['', 'Not set'], ['employee', 'Employee'], ['self_employed', 'Self-employed'], ['retired', 'Retired'], ['unemployed', 'Not employed'], ['other', 'Other']].map(([v, l]) => el('option', { value: v }, l))),
      employer_name: el('input', { type: 'text' }),
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
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Employment'), co.employment_type),
        el('label', { class: 'field' }, el('span', null, 'Employer'), co.employer_name)),
      el('label', { class: 'checkbox' }, co.invite, 'Give them their own portal access'));
    coApplicants.push(co);
    coHolder.append(card);
  }

  const errorLine = el('p', { class: 'form-error' });
  const submitBtn = el('button', { class: 'btn' }, 'Create client & send welcome');

  async function submit(ignoreDuplicates) {
    errorLine.textContent = '';
    submitBtn.disabled = true;
    const payload = {
      client: Object.fromEntries(Object.entries(f).map(([k, input]) => [k, input.value])),
      application: {
        ...Object.fromEntries(Object.entries(a).map(([k, input]) => [k, input.type === 'checkbox' ? input.checked : input.value])),
      },
      co_applicants: coApplicants.filter((c) => !c.removed).map((c) => ({
        role: c.role.value, first_name: c.first_name.value, last_name: c.last_name.value,
        email: c.email.value, phone: c.phone.value, employment_type: c.employment_type.value,
        employer_name: c.employer_name.value, invite: c.invite.checked,
      })),
      send_welcome: sendWelcome.checked,
      ignore_duplicates: !!ignoreDuplicates,
    };
    try {
      const res = await api.post('/api/broker/clients', payload);
      toast(`Client created — file ${res.file.file_number}. Checklist and welcome email are ready.`, 'good');
      const invite = (res.invites || []).find((i) => i.activation_link);
      if (invite) inviteLinkModal(invite.activation_link);
      goFile(res.file.id);
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
          el('button', { class: 'btn sm secondary', onclick: () => goFile(d.file_id) }, 'Open file')))),
      (close) => [
        el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
        el('button', { class: 'btn', onclick: () => { close(); submit(true); } }, 'Create new file anyway'),
      ]);
  }

  submitBtn.addEventListener('click', () => submit(false));

  setView(
    el('h1', null, 'New client'),
    el('p', { class: 'muted' }, 'One quick form. The file, document checklist and welcome email are created automatically.'),
    el('div', { class: 'card' },
      el('h3', null, 'Primary client'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'First name *'), f.first_name),
        el('label', { class: 'field' }, el('span', null, 'Middle name'), f.middle_name),
        el('label', { class: 'field' }, el('span', null, 'Last name *'), f.last_name)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Preferred name'), f.preferred_name),
        el('label', { class: 'field' }, el('span', null, 'Date of birth'), f.dob)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Email'), f.email),
        el('label', { class: 'field' }, el('span', null, 'Mobile phone'), f.phone)),
      el('label', { class: 'field' }, el('span', null, 'Current address'), f.address),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Preferred contact method'), f.preferred_contact),
        el('label', { class: 'field' }, el('span', null, 'Employment'), f.employment_type)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Employer'), f.employer_name),
        el('label', { class: 'field' }, el('span', null, 'Job title'), f.job_title))),
    el('div', { class: 'card' },
      el('h3', null, 'Application'),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Application type'), a.application_type_id),
        el('label', { class: 'field' }, el('span', null, 'Assigned broker'), a.assigned_broker_id)),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Purchase price'), a.purchase_price),
        el('label', { class: 'field' }, el('span', null, 'Down payment'), a.down_payment),
        el('label', { class: 'field' }, el('span', null, 'Mortgage amount'), a.mortgage_amount)),
      el('label', { class: 'field' }, el('span', null, 'Property address'), a.property_address),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Property type'), a.property_type),
        el('label', { class: 'field' }, el('span', null, 'Closing date (if known)'), a.closing_date)),
      el('label', { class: 'checkbox' }, a.fthb, 'First-time home buyer'),
      el('label', { class: 'field' }, el('span', null, 'Notes'), a.purpose)),
    coHolder,
    el('div', { class: 'card' },
      el('button', { class: 'btn secondary', onclick: addCoApplicant }, '+ Add co-borrower / spouse / guarantor')),
    el('div', { class: 'card' },
      el('label', { class: 'checkbox' }, sendWelcome, 'Send the welcome email with portal access now'),
      el('p', { class: 'faint' }, 'The document checklist is generated automatically from your document rules (application type + employment + first-time buyer status).'),
      errorLine,
      el('div', { class: 'row' }, submitBtn, el('a', { class: 'btn secondary', href: '#/clients' }, 'Cancel'))));
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
