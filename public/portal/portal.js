'use strict';

/* Client portal SPA. Routes: #/home #/documents #/messages #/notifications #/profile */

const state = {
  me: null,
  overview: null,     // { show_welcome, first_name, files: [...] }
  file: null,         // active file overview
  chatTimer: null,
  lastMessageId: 0,
};

const view = document.getElementById('view');

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    state.me = await api.get('/api/auth/me');
  } catch {
    window.location.href = '/login';
    return;
  }
  if (state.me.must_change_password) {
    window.location.href = '/change-password';
    return;
  }
  if (state.me.is_staff) {
    window.location.href = '/broker';
    return;
  }
  applyBranding(state.me.brokerage);
  document.getElementById('brand-name').textContent = state.me.brokerage.name || 'Client Portal';
  if (state.me.brokerage.name) {
    document.getElementById('brand-mark').textContent = (state.me.brokerage.logo_text || state.me.brokerage.name[0] || 'M').slice(0, 2).toUpperCase();
  }
  await refreshOverview();
  if (state.overview.show_welcome) {
    showWelcome();
  }
  window.addEventListener('hashchange', route);
  document.querySelectorAll('.bottom-nav button').forEach((b) => {
    b.addEventListener('click', () => { window.location.hash = b.dataset.route; });
  });
  document.getElementById('nav-notifications').addEventListener('click', () => { window.location.hash = '#/notifications'; });
  document.getElementById('nav-profile').addEventListener('click', () => { window.location.hash = '#/profile'; });
  route();
  setInterval(pollBadges, 30000);
}

async function refreshOverview() {
  state.overview = await api.get('/api/client/overview');
  state.file = state.overview.files.find((f) => f.status === 'active') || state.overview.files[0] || null;
  updateBadges();
}

function updateBadges() {
  const unreadNotifs = state.me ? state.me.unread_notifications : 0;
  const badge = document.getElementById('notif-badge');
  badge.classList.toggle('hidden', !unreadNotifs);
  badge.textContent = unreadNotifs > 9 ? '9+' : unreadNotifs;
  const file = state.file;
  document.getElementById('msg-dot').classList.toggle('hidden', !file || !file.unread_messages);
  const needsDocs = file && file.needed.length > 0;
  document.getElementById('docs-dot').classList.toggle('hidden', !needsDocs);
}

async function pollBadges() {
  try {
    state.me = await api.get('/api/auth/me');
    await refreshOverview();
  } catch { /* transient */ }
}

// ------------------------------------------------------------------ router

function route() {
  const hash = window.location.hash || '#/home';
  document.querySelectorAll('.bottom-nav button').forEach((b) => {
    b.classList.toggle('active', hash.startsWith(b.dataset.route));
  });
  stopChatPolling();
  if (hash.startsWith('#/documents')) renderDocuments();
  else if (hash.startsWith('#/messages')) renderMessages();
  else if (hash.startsWith('#/notifications')) renderNotifications();
  else if (hash.startsWith('#/profile')) renderProfile();
  else renderHome();
}

function setView(...nodes) {
  clearNode(view);
  view.append(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
  window.scrollTo(0, 0);
}

function noFileCard() {
  return el('div', { class: 'card empty' },
    el('div', { class: 'big' }, '📂'),
    el('h2', null, 'No application yet'),
    el('p', null, 'Your broker has not connected an application to your account yet. If this seems wrong, please contact them directly.'));
}

// ------------------------------------------------------------------ home

function renderHome() {
  const file = state.file;
  if (!file) { setView(noFileCard()); return; }

  const stepIndex = file.stage ? file.stage.step : 1;
  const steps = el('div', { class: 'steps', role: 'img', 'aria-label': `Progress: step ${stepIndex} of ${file.steps.length}` },
    file.steps.map((s, i) => el('div', {
      class: `step ${i + 1 < stepIndex ? 'done' : i + 1 === stepIndex ? 'now' : ''}`,
    },
      el('div', { class: 'bubble' }, i + 1 < stepIndex ? '✓' : String(i + 1)),
      el('div', { class: 'lbl' }, s.label)
    ))
  );

  const next = file.next_step;
  const nextCard = el('div', { class: 'card next-step' },
    el('div', { class: 'kicker' }, 'Next step for you'),
    el('p', null, next.text),
    next.kind === 'upload'
      ? el('button', { class: 'btn', onclick: () => { window.location.hash = '#/documents'; } }, 'Upload documents')
      : null
  );

  const needed = file.needed;
  const neededCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', null, 'What we need from you'),
      needed.length ? el('span', { class: 'pill warn' }, `${needed.length} item${needed.length > 1 ? 's' : ''}`) : null),
    needed.length === 0
      ? el('div', { class: 'empty', style: 'padding:16px' },
          el('p', null, "You're all caught up. There are no documents waiting for you. 🎉"))
      : el('ul', { class: 'list' }, needed.slice(0, 4).map((r) => docListItem(r))),
    needed.length > 4
      ? el('button', { class: 'btn subtle block', onclick: () => { window.location.hash = '#/documents'; } }, `See all ${needed.length} items`)
      : null
  );

  const done = file.recently_completed;
  const doneCard = done.length ? el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', null, 'Recently completed')),
    el('ul', { class: 'list' }, done.map((r) => el('li', { class: 'row' },
      el('span', null, '✅'),
      el('div', { class: 'grow' },
        el('div', null, r.document_name),
        el('div', { class: 'faint' }, r.applicant_name || '')),
      el('span', { class: 'pill good' }, 'Approved')
    )))
  ) : null;

  const consents = (file.pending_consents || []).length ? el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', null, 'Needs your review')),
    el('ul', { class: 'list' }, file.pending_consents.map((c) => el('li', { class: 'row' },
      el('span', null, '📝'),
      el('div', { class: 'grow' }, c.form_title),
      el('button', { class: 'btn sm', onclick: () => openConsent(c.id) }, 'Review')
    )))
  ) : null;

  const profileHint = file.profile.completion < 100 ? el('div', { class: 'card tight row' },
    el('span', null, 'ℹ️'),
    el('div', { class: 'grow small' },
      `Your application information is ${file.profile.completion}% complete. Missing: ${file.profile.missing.join(', ')}.`),
    el('button', { class: 'btn sm secondary', onclick: () => { window.location.hash = '#/profile'; } }, 'Update')
  ) : null;

  const brokerCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', null, 'Contact your broker')),
    el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { style: 'font-weight:600' }, file.broker.name),
        el('div', { class: 'faint' }, file.broker.brokerage_name)),
      el('button', { class: 'btn', onclick: () => { window.location.hash = '#/messages'; } }, '💬 Message')
    )
  );

  setView(
    el('div', { class: 'hello' },
      el('h1', null, `${greeting()}, ${file.my_name}.`),
      el('p', { class: 'muted' }, file.stage ? file.stage.label : 'Welcome back'),
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-title' },
        el('h2', null, 'Your mortgage progress'),
        el('span', { class: 'faint' }, file.file_number)),
      steps,
      file.stage && file.stage.message ? el('p', { class: 'muted small', style: 'margin-top:10px' }, file.stage.message) : null
    ),
    nextCard,
    neededCard,
    consents,
    doneCard,
    profileHint,
    brokerCard,
    el('button', { class: 'chat-fab', 'aria-label': 'Chat with your broker', onclick: () => { window.location.hash = '#/messages'; } }, '💬')
  );
}

// ------------------------------------------------------------------ documents

const DOC_ICONS = { identity: '🪪', income: '💼', property: '🏠', financial: '🏦', other: '📄' };

function docListItem(r, { withUpload = true } = {}) {
  const status = r.client_status;
  const pillCls = { done: 'good', waiting: 'info', action: 'warn', optional: '' }[status.kind] || '';
  return el('li', { class: 'doc-item' },
    el('div', { class: 'doc-ico', 'aria-hidden': 'true' }, DOC_ICONS[r.document_category] || '📄'),
    el('div', { class: 'grow' },
      el('div', { class: 'row wrap' },
        el('span', { style: 'font-weight:600' }, r.document_name),
        el('span', { class: `pill ${pillCls}` }, status.label)),
      r.applicant_name ? el('div', { class: 'faint' }, `For ${r.applicant_name}`) : null,
      r.due_date && status.kind === 'action' ? el('div', { class: 'faint' }, `Needed by ${fmtDate(r.due_date)}`) : null,
      status.reason ? el('div', { class: 'doc-reason' }, `“${status.reason}”`) : null,
      withUpload && status.kind === 'action'
        ? el('div', { class: 'row', style: 'margin-top:9px' },
            uploadButton(r, r.status === 'rejected' || r.status === 'replacement_requested' || r.status === 'expired' ? 'Upload replacement' : 'Upload document'),
            el('button', { class: 'btn-link small', onclick: () => cantProvideDialog(r) }, 'Need help?'))
        : null,
      withUpload && status.kind === 'optional'
        ? el('div', { style: 'margin-top:9px' }, uploadButton(r, 'Upload (optional)')) : null
    )
  );
}

function uploadButton(request, label) {
  const input = el('input', {
    type: 'file', class: 'hidden', multiple: true,
    accept: '.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,image/*,application/pdf',
  });
  input.addEventListener('change', () => {
    if (input.files.length) handleFiles([...input.files], request);
    input.value = '';
  });
  const btn = el('button', { class: 'btn sm', onclick: () => input.click() }, '📎 ' + label);
  const holder = el('span', null, btn, input);
  return holder;
}

function cantProvideDialog(request) {
  const text = el('textarea', { placeholder: "e.g. I can't get this until Friday — my employer is preparing it." });
  openModal(`About: ${request.document_name}`,
    [
      el('p', { class: 'muted' }, 'Tell your broker if you have a question about this document or need more time. They will get back to you.'),
      text,
    ],
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          try {
            await api.post(`/api/client/requests/${request.id}/comment`, { comment: text.value.trim() });
            close();
            toast('Sent to your broker.', 'good');
          } catch (err) { toast(err.message, 'bad'); }
        },
      }, 'Send'),
    ]);
}

/** Guess which outstanding request a filename belongs to. */
function guessRequest(filename, outstanding) {
  const name = filename.toLowerCase();
  const hints = [
    [/pay ?stub|paystub|stub/, 'Recent Pay Stub'],
    [/t4/, 'T4'],
    [/t1/, 'T1 General'],
    [/noa|assessment/, 'Notice of Assessment'],
    [/employment|letter|loe/, 'Employment Letter'],
    [/licen|passport|\bid\b|identity/, 'Government ID'],
    [/purchase|aps|agreement/, 'Purchase Agreement'],
    [/mls|listing/, 'MLS Listing'],
    [/gift/, 'Gift Letter'],
    [/mortgage/, 'Existing Mortgage Statement'],
    [/property ?tax|tax ?bill/, 'Property Tax Bill'],
    [/insur/, 'Home Insurance'],
    [/bank|statement|chequing|savings/, 'Down Payment Verification'],
  ];
  for (const [re, docName] of hints) {
    if (re.test(name)) {
      const match = outstanding.find((r) => r.document_name === docName);
      if (match) return match;
    }
  }
  return null;
}

/** Upload one or many files; when target is set all files go to that request. */
async function handleFiles(files, target) {
  const docs = await api.get(`/api/client/files/${state.file.file_id}/documents`);
  const outstanding = docs.requests.filter((r) => r.client_status.kind === 'action' || r.client_status.kind === 'optional');

  if (!target && files.length >= 1) {
    // Assignment sheet: match each file to a checklist item (smart default).
    const rows = files.map((file) => {
      const guessed = guessRequest(file.name, outstanding);
      const select = el('select', null,
        outstanding.map((r) => el('option', {
          value: r.id,
          selected: guessed ? r.id === guessed.id : undefined,
        }, r.document_name + (r.applicant_name ? ` (${r.applicant_name})` : ''))));
      return { file, select };
    });
    if (outstanding.length === 0) {
      toast('There are no open document requests right now. Message your broker if you need to send something.', 'bad');
      return;
    }
    openModal('What are these documents?',
      [
        el('p', { class: 'muted small' }, "We've matched your files to what's needed — adjust if we guessed wrong. Your broker can also reclassify them later."),
        ...rows.map(({ file, select }) => el('div', { class: 'card tight' },
          el('div', { class: 'small', style: 'font-weight:600;overflow-wrap:anywhere' }, file.name),
          select)),
      ],
      (close) => [
        el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
        el('button', {
          class: 'btn',
          onclick: async (e) => {
            e.target.disabled = true;
            close();
            for (const { file, select } of rows) {
              await uploadOne(file, Number(select.value));
            }
            await afterUploads();
          },
        }, `Upload ${files.length} file${files.length > 1 ? 's' : ''}`),
      ]);
    return;
  }

  for (const file of files) await uploadOne(file, target.id);
  await afterUploads();
}

async function uploadOne(file, requestId) {
  const note = toastProgress(`Uploading ${file.name}…`);
  try {
    await api.upload(`/api/client/requests/${requestId}/upload`, file, file.name);
    note.done(`Uploaded ${file.name} ✓`);
  } catch (err) {
    note.fail(err.message || `We couldn't upload ${file.name}. Please try again.`);
  }
}

function toastProgress(message) {
  let holder = document.getElementById('toast-holder');
  if (!holder) { holder = el('div', { id: 'toast-holder' }); document.body.append(holder); }
  const t = el('div', { class: 'toast', role: 'status' }, message);
  holder.append(t);
  return {
    done(msg) { t.textContent = msg; t.classList.add('good'); setTimeout(() => t.remove(), 3000); },
    fail(msg) { t.textContent = msg; t.classList.add('bad'); setTimeout(() => t.remove(), 6000); },
  };
}

async function afterUploads() {
  await refreshOverview();
  route();
}

async function renderDocuments() {
  const file = state.file;
  if (!file) { setView(noFileCard()); return; }
  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:120px' })));
  const docs = await api.get(`/api/client/files/${file.file_id}/documents`);
  const requests = docs.requests;

  const needed = requests.filter((r) => r.client_status.kind === 'action' && r.requirement === 'required');
  const optional = requests.filter((r) => r.client_status.kind !== 'done' && r.client_status.kind !== 'waiting' && r.requirement === 'optional');
  const waiting = requests.filter((r) => r.client_status.kind === 'waiting');
  const done = requests.filter((r) => r.status === 'approved');

  const dropzone = el('div', {
    class: 'dropzone', role: 'button', tabindex: '0',
    'aria-label': 'Upload documents',
  },
    el('div', { style: 'font-size:1.6rem' }, '📤'),
    el('div', { style: 'font-weight:600' }, 'Tap to upload — or drop files here'),
    el('div', { class: 'faint' }, 'PDF, photos (JPG/PNG/HEIC) — take a photo right from your phone')
  );
  const zoneInput = el('input', {
    type: 'file', class: 'hidden', multiple: true,
    accept: '.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,image/*,application/pdf',
  });
  zoneInput.addEventListener('change', () => {
    if (zoneInput.files.length) handleFiles([...zoneInput.files], null);
    zoneInput.value = '';
  });
  dropzone.addEventListener('click', () => zoneInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') zoneInput.click(); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files], null);
  });

  const section = (title, list, pill, withUpload = true) => list.length ? el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', null, title), pill),
    el('ul', { class: 'list' }, list.map((r) => docListItem(r, { withUpload })))
  ) : null;

  setView(
    el('h1', null, 'Your documents'),
    el('p', { class: 'muted' }, needed.length
      ? `${needed.length} document${needed.length > 1 ? 's are' : ' is'} still needed from you.`
      : "You're all caught up — nothing is needed from you right now."),
    el('div', { class: 'card' }, dropzone, zoneInput),
    section('Still needed', needed, el('span', { class: 'pill warn' }, String(needed.length))),
    section('Being reviewed', waiting, el('span', { class: 'pill info' }, String(waiting.length)), false),
    section('Optional', optional, null),
    section('Approved', done, el('span', { class: 'pill good' }, String(done.length)), false),
    requests.length === 0 ? el('div', { class: 'card empty' },
      el('div', { class: 'big' }, '🎉'),
      el('p', null, "You're all caught up. There are no documents waiting for you.")) : null
  );
}

// ------------------------------------------------------------------ messages

function stopChatPolling() {
  if (state.chatTimer) { clearInterval(state.chatTimer); state.chatTimer = null; }
}

async function renderMessages() {
  const file = state.file;
  if (!file) { setView(noFileCard()); return; }

  const scroll = el('div', { class: 'chat-scroll', id: 'chat-scroll' });
  const textarea = el('textarea', { placeholder: 'Write a message…', 'aria-label': 'Message', rows: '1' });
  const send = el('button', { class: 'btn', 'aria-label': 'Send message' }, 'Send');

  async function submit() {
    const body = textarea.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      await api.post(`/api/client/files/${file.file_id}/messages`, { body });
      textarea.value = '';
      await loadMessages();
    } catch (err) { toast(err.message, 'bad'); }
    send.disabled = false;
    textarea.focus();
  }
  send.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  setView(
    el('h1', null, 'Messages'),
    el('p', { class: 'muted' }, `Private conversation with ${file.broker.name}. They'll reply as soon as they can.`),
    el('div', { class: 'chat-page chat-box' },
      scroll,
      el('div', { class: 'chat-input' }, textarea, send))
  );

  state.lastMessageId = 0;
  async function loadMessages() {
    const res = await api.get(`/api/client/files/${file.file_id}/messages?after=${state.lastMessageId}`);
    if (res.messages.length === 0 && state.lastMessageId !== 0) return;
    for (const m of res.messages) {
      state.lastMessageId = Math.max(state.lastMessageId, m.id);
      scroll.append(el('div', { class: `chat-msg ${m.sender_kind === 'client' ? 'mine' : 'theirs'}` },
        el('div', null, m.body),
        el('div', { class: 'meta' }, `${m.sender_kind === 'client' ? 'You' : m.sender_name} · ${fmtDateTime(m.created_at)}${m.edited_at ? ' (edited)' : ''}`)
      ));
    }
    if (res.messages.length) {
      scroll.scrollTop = scroll.scrollHeight;
      api.post(`/api/client/files/${file.file_id}/messages/read`, {}).catch(() => {});
      document.getElementById('msg-dot').classList.add('hidden');
    }
    if (scroll.children.length === 0) {
      scroll.append(el('div', { class: 'empty' },
        el('div', { class: 'big' }, '💬'),
        el('p', null, 'No messages yet. Ask your broker anything — they are here to help.')));
    }
  }
  await loadMessages();
  state.chatTimer = setInterval(loadMessages, 5000);
}

// ------------------------------------------------------------------ notifications

async function renderNotifications() {
  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:120px' })));
  const res = await api.get('/api/client/notifications');
  const unreadIds = res.notifications.filter((n) => !n.read_at).map((n) => n.id);

  setView(
    el('div', { class: 'row' },
      el('h1', { class: 'grow' }, 'Notifications'),
      unreadIds.length ? el('button', {
        class: 'btn sm secondary',
        onclick: async () => { await api.post('/api/client/notifications/read', { all: true }); pollBadges(); renderNotifications(); },
      }, 'Mark all read') : null),
    res.notifications.length === 0
      ? el('div', { class: 'card empty' },
          el('div', { class: 'big' }, '🔔'),
          el('p', null, "You're all caught up — no notifications."))
      : el('div', { class: 'card' }, el('ul', { class: 'list' }, res.notifications.map((n) =>
          el('li', {
            class: 'row top', style: n.read_at ? 'opacity:0.65' : '', role: 'button', tabindex: '0',
            onclick: async () => {
              await api.post('/api/client/notifications/read', { ids: [n.id] }).catch(() => {});
              window.location.hash = n.link && n.link.startsWith('#/') ? n.link : '#/home';
              pollBadges();
            },
          },
            el('span', null, { document_requested: '📄', document_approved: '✅', document_rejected: '⚠️', document_reminder: '⏰', stage_changed: '🚀', new_message: '💬', consent_requested: '📝' }[n.kind] || '🔔'),
            el('div', { class: 'grow' },
              el('div', { style: n.read_at ? '' : 'font-weight:600' }, n.title),
              n.body ? el('div', { class: 'small muted' }, n.body) : null,
              el('div', { class: 'faint' }, timeAgo(n.created_at)))
          ))))
  );
}

// ------------------------------------------------------------------ profile

async function renderProfile() {
  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:120px' })));
  const profile = await api.get('/api/client/profile');

  const phone = el('input', { type: 'tel', value: profile.phone || '', autocomplete: 'tel' });
  const address = el('input', { type: 'text', value: profile.address || '', autocomplete: 'street-address' });
  const preferred = el('select', null,
    ['email', 'phone', 'text', 'portal'].map((v) => el('option', { value: v, selected: profile.preferred_contact === v ? '' : undefined },
      { email: 'Email', phone: 'Phone call', text: 'Text message', portal: 'Portal messages' }[v])));

  const current = el('input', { type: 'password', autocomplete: 'current-password' });
  const newPass = el('input', { type: 'password', autocomplete: 'new-password' });

  setView(
    el('h1', null, 'Your profile'),
    el('div', { class: 'card' },
      el('h2', null, `${profile.first_name} ${profile.last_name}`),
      el('p', { class: 'muted' }, profile.email),
      el('label', { class: 'field' }, el('span', null, 'Mobile phone'), phone),
      el('label', { class: 'field' }, el('span', null, 'Current address'), address),
      el('label', { class: 'field' }, el('span', null, 'Preferred way to reach you'), preferred),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.patch('/api/client/profile', { phone: phone.value, address: address.value, preferred_contact: preferred.value });
            toast('Profile updated.', 'good');
            refreshOverview();
          } catch (err) { toast(err.message, 'bad'); }
          e.target.disabled = false;
        },
      }, 'Save changes')),
    el('div', { class: 'card' },
      el('h2', null, 'Change password'),
      el('label', { class: 'field' }, el('span', null, 'Current password'), current),
      el('label', { class: 'field' }, el('span', null, 'New password'), newPass),
      el('button', {
        class: 'btn secondary',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.post('/api/auth/change-password', { current_password: current.value, new_password: newPass.value });
            toast('Password changed.', 'good');
            current.value = ''; newPass.value = '';
          } catch (err) { toast(err.message, 'bad'); }
          e.target.disabled = false;
        },
      }, 'Update password')),
    el('div', { class: 'card' },
      el('button', {
        class: 'btn secondary block',
        onclick: async () => { await api.post('/api/auth/logout', {}); window.location.href = '/login'; },
      }, 'Sign out'))
  );
}

// ------------------------------------------------------------------ consents

async function openConsent(consentId) {
  const res = await api.get('/api/client/consents');
  const consent = res.consents.find((c) => c.id === consentId);
  if (!consent) return;
  openModal(consent.form_title,
    [
      el('div', { class: 'card tight', style: 'max-height:44vh;overflow-y:auto;white-space:pre-wrap' }, consent.form_body_snapshot),
      el('p', { class: 'faint' }, `Version ${consent.form_version}. Your response is recorded with the date, time and your identity.`),
    ],
    (close) => [
      el('button', {
        class: 'btn secondary',
        onclick: async () => {
          if (!(await confirmDialog('Decline this item? Your broker will be notified.'))) return;
          await api.post(`/api/client/consents/${consentId}/respond`, { accept: false });
          close(); toast('Response recorded.'); refreshOverview().then(route);
        },
      }, 'Decline'),
      el('button', {
        class: 'btn good',
        onclick: async () => {
          await api.post(`/api/client/consents/${consentId}/respond`, { accept: true });
          close(); toast('Thank you — recorded.', 'good'); refreshOverview().then(route);
        },
      }, 'I agree'),
    ]);
}

// ------------------------------------------------------------------ welcome

function showWelcome() {
  const brokerage = state.me.brokerage;
  const overlay = el('div', { class: 'welcome-overlay', role: 'dialog', 'aria-label': 'Welcome' },
    el('div', { class: 'welcome-inner' },
      el('div', { style: 'font-size:2.4rem;margin-bottom:8px' }, '👋'),
      el('h1', null, `Welcome, ${state.overview.first_name}.`),
      el('p', { class: 'muted' }, brokerage.welcome_message || 'Your mortgage journey starts here.'),
      el('div', { class: 'steps-list' },
        el('div', { class: 'row' }, el('div', { class: 'num' }, '1'), el('div', null, el('strong', null, 'Check your progress'), el('div', { class: 'muted small' }, 'See exactly where your mortgage stands, any time.'))),
        el('div', { class: 'row' }, el('div', { class: 'num' }, '2'), el('div', null, el('strong', null, 'Upload requested documents'), el('div', { class: 'muted small' }, 'Snap a photo or upload a PDF — right from your phone.'))),
        el('div', { class: 'row' }, el('div', { class: 'num' }, '3'), el('div', null, el('strong', null, 'Watch for messages'), el('div', { class: 'muted small' }, 'Your broker will message you here when anything is needed.')))),
      el('button', {
        class: 'btn block',
        onclick: async () => {
          overlay.remove();
          api.post('/api/auth/welcome-seen', {}).catch(() => {});
        },
      }, "Let's go")));
  document.body.append(overlay);
}

boot();
