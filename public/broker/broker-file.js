'use strict';

/* Shared broker-portal state (this file loads first). */
const BK = {
  me: null,
  meta: null,       // { stages, application_types, document_types, permissions, staff_roles }
  staff: [],
  chatTimer: null,
  lastMessageId: 0,
};

function can(permission) {
  return BK.me && BK.me.permissions.includes(permission);
}

function stageDot(stage) {
  if (!stage) return el('span', { class: 'pill' }, 'No stage');
  return el('span', { class: 'pill', style: `background:${stage.color}1a;color:${stage.color}` },
    el('span', { class: 'dot', style: `background:${stage.color}` }), stage.name);
}

function goFile(id, tab) {
  window.location.hash = `#/files/${id}${tab ? '/' + tab : ''}`;
}

function activeStages() {
  return BK.meta.stages.filter((s) => s.active);
}

function docTypeName(id) {
  const t = BK.meta.document_types.find((d) => d.id === id);
  return t ? t.name : 'Document';
}

// ===================================================================
// File detail view
// ===================================================================

async function renderFileView(fileId, tab) {
  tab = tab || 'overview';
  const view = document.getElementById('view');
  clearNode(view);
  view.append(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:130px' })));

  let data;
  try {
    data = await api.get(`/api/broker/files/${fileId}`);
  } catch (err) {
    clearNode(view);
    view.append(el('div', { class: 'card empty' }, el('p', null, err.message)));
    return;
  }
  const { file, applicants, next_step, attention, stage_history } = data;

  const tabs = [
    ['overview', 'Overview'],
    ['documents', `Documents${file.checklist.awaiting_review ? ` (${file.checklist.awaiting_review})` : ''}`],
    ['messages', `Messages${file.unread_messages ? ` (${file.unread_messages})` : ''}`],
    ['tasks', 'Tasks'],
    ['notes', 'Notes'],
    ['activity', 'Activity'],
    ['emails', 'Emails'],
  ];

  const head = el('div', null,
    el('div', { class: 'file-head' },
      el('h1', null, file.client_name),
      stageDot(file.stage),
      el('span', { class: 'pill' }, file.file_number),
      file.status !== 'active' ? el('span', { class: 'pill bad' }, file.status) : null,
      el('div', { class: 'spacer' }),
      quickActions(file)
    ),
    el('div', { class: 'tabs', role: 'tablist' }, tabs.map(([key, label]) =>
      el('button', {
        role: 'tab', class: key === tab ? 'active' : '', 'aria-selected': key === tab ? 'true' : 'false',
        onclick: () => goFile(file.id, key),
      }, label)))
  );

  const body = el('div', { id: 'file-tab-body' });
  clearNode(view);
  view.append(head, body);

  const renderers = {
    overview: () => renderFileOverview(body, { file, applicants, next_step, attention, stage_history }),
    documents: () => renderFileDocuments(body, file),
    messages: () => renderFileMessages(body, file),
    tasks: () => renderFileTasks(body, file),
    notes: () => renderFileNotes(body, file),
    activity: () => renderFileActivity(body, file),
    emails: () => renderFileEmails(body, file),
  };
  (renderers[tab] || renderers.overview)();
}

function quickActions(file) {
  const actions = [];
  if (can('documents.request')) {
    actions.push(el('button', { class: 'btn sm secondary', onclick: () => requestDocModal(file) }, '📄 Request document'));
    actions.push(el('button', {
      class: 'btn sm secondary',
      onclick: async (e) => {
        if (!(await confirmDialog('Email this client a summary of everything still outstanding? The same list is already in their portal.'))) return;
        e.target.disabled = true;
        try {
          const res = await api.post(`/api/broker/files/${file.id}/request-outstanding`, {});
          toast(`Sent — ${res.documents} outstanding document${res.documents === 1 ? '' : 's'} listed.`, 'good');
        } catch (err) { toast(err.message, 'bad'); }
        e.target.disabled = false;
      },
    }, '✉️ Email outstanding'));
  }
  if (can('stage.change')) actions.push(el('button', { class: 'btn sm secondary', onclick: () => changeStageModal(file) }, '🚀 Change stage'));
  if (can('tasks.manage')) actions.push(el('button', { class: 'btn sm secondary', onclick: () => addTaskModal(file) }, '✅ Add task'));
  if (can('chat.send')) actions.push(el('button', { class: 'btn sm', onclick: () => goFile(file.id, 'messages') }, '💬 Message'));
  return el('div', { class: 'quick-actions' }, actions);
}

// ------------------------------------------------------------------ overview

function renderFileOverview(body, { file, applicants, next_step, attention, stage_history }) {
  const money = (label, value) => el('div', null, el('div', { class: 'faint' }, label), el('div', { style: 'font-weight:600' }, value));

  const appCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h3', null, 'Application'),
      el('div', { class: 'spacer' }),
      can('clients.edit') ? el('button', { class: 'btn sm secondary', onclick: () => editApplicationModal(file) }, 'Edit') : null),
    el('div', { class: 'form-row cols-3', style: 'gap:12px' },
      money('Type', file.application_type || '—'),
      money('Purchase price', fmtMoney(file.purchase_price)),
      money('Down payment', fmtMoney(file.down_payment)),
      money('Mortgage amount', fmtMoney(file.mortgage_amount)),
      money('Closing date', fmtDate(file.closing_date)),
      money('First-time buyer', file.fthb ? 'Yes' : 'No')),
    file.property_address ? el('p', { class: 'muted', style: 'margin-top:10px' }, `🏠 ${file.property_address}${file.property_type ? ' · ' + file.property_type : ''}`) : null,
    file.purpose ? el('p', { class: 'small muted' }, `Purpose: ${file.purpose}`) : null
  );

  const applicantsCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h3', null, `Applicants (${applicants.length})`),
      el('div', { class: 'spacer' }),
      can('clients.edit') ? el('button', { class: 'btn sm secondary', onclick: () => applicantModal(file, null) }, '+ Add') : null),
    el('ul', { class: 'list' }, applicants.map((a) => el('li', { class: 'row top wrap' },
      el('div', { class: 'grow' },
        el('div', { class: 'row wrap' },
          el('span', { style: 'font-weight:600' }, a.name),
          el('span', { class: 'pill' }, a.role.replace('_', '-')),
          a.has_portal_access ? el('span', { class: 'pill good' }, 'Portal ✓') : el('span', { class: 'pill warn' }, 'No portal')),
        el('div', { class: 'small muted' }, [a.email, a.phone].filter(Boolean).join(' · ') || 'No contact details'),
        a.employment_type ? el('div', { class: 'faint' }, `${a.employment_type.replace('_', '-')}${a.employer_name ? ' at ' + a.employer_name : ''}${a.job_title ? ' · ' + a.job_title : ''}`) : null),
      can('clients.edit') ? el('div', { class: 'row' },
        el('button', { class: 'btn sm secondary', onclick: () => applicantModal(file, a) }, 'Edit'),
        !a.has_portal_access && a.email ? el('button', {
          class: 'btn sm subtle',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const res = await api.post(`/api/broker/applicants/${a.id}/invite`, {});
              credentialsModal(res);
            } catch (err) { toast(err.message, 'bad'); }
            e.target.disabled = false;
          },
        }, 'Invite') : null) : null
    )))
  );

  const attentionCard = attention.length ? el('div', { class: 'card', style: 'border-left:4px solid var(--warn)' },
    el('h3', null, 'Needs attention'),
    el('ul', { class: 'list' }, attention.map((r) => el('li', { class: 'row' },
      el('span', null, { review: '📥', message: '💬', outstanding: '📄', task_overdue: '⏰', task_today: '📅' }[r.kind] || '•'),
      el('span', null, r.text))))
  ) : null;

  const nextCard = el('div', { class: 'card tight row' },
    el('span', null, '🧭'),
    el('div', { class: 'grow' },
      el('div', { class: 'faint' }, 'What the client sees as their next step'),
      el('div', { style: 'font-weight:600' }, next_step.text)));

  const historyCard = el('div', { class: 'card' },
    el('h3', null, 'Stage history'),
    stage_history.length === 0
      ? el('p', { class: 'muted' }, 'No stage changes yet.')
      : el('ul', { class: 'timeline' }, stage_history.map((h) => el('li', null,
          el('span', { class: 't-dot' }),
          el('div', null, `${h.from_name ? h.from_name + ' → ' : ''}${h.to_name}`),
          h.note ? el('div', { class: 'small muted' }, h.note) : null,
          el('div', { class: 't-time' }, `${fmtDateTime(h.changed_at)}${h.changed_by_name ? ' · ' + h.changed_by_name : ''}`)))));

  const assignSelect = el('select', null,
    el('option', { value: '' }, 'Unassigned'),
    BK.staff.map((s) => el('option', {
      value: s.id, selected: file.assigned_broker && file.assigned_broker.id === s.id ? '' : undefined,
    }, `${s.first_name} ${s.last_name}`)));
  assignSelect.addEventListener('change', async () => {
    try {
      await api.post(`/api/broker/files/${file.id}/assign`, { broker_id: assignSelect.value || null });
      toast('Assignment updated.', 'good');
    } catch (err) { toast(err.message, 'bad'); }
  });

  const adminCard = el('div', { class: 'card' },
    el('h3', null, 'File'),
    el('label', { class: 'field' }, el('span', null, 'Assigned to'), assignSelect),
    can('clients.archive') ? el('div', { class: 'row wrap' },
      ['completed', 'cancelled', 'archived'].map((s) => el('button', {
        class: 'btn sm secondary',
        onclick: async () => {
          if (!(await confirmDialog(`Mark this file as ${s}? It stays fully preserved and can be reactivated.`))) return;
          await api.post(`/api/broker/files/${file.id}/status`, { status: s });
          renderFileView(file.id, 'overview');
        },
      }, `Mark ${s}`)),
      file.status !== 'active' ? el('button', {
        class: 'btn sm',
        onclick: async () => { await api.post(`/api/broker/files/${file.id}/status`, { status: 'active' }); renderFileView(file.id, 'overview'); },
      }, 'Reactivate') : null) : null);

  clearNode(body);
  body.append(attentionCard, nextCard, appCard, applicantsCard, historyCard, adminCard);
}

/** Staff activation links (separate flow from client temporary passwords). */
function inviteLinkModal(link) {
  const input = el('input', { type: 'text', value: link, readonly: true, onclick: (e) => e.target.select() });
  openModal('Invitation sent',
    [
      el('p', { class: 'muted' }, 'A welcome email with this activation link was recorded. You can also copy it and share it directly:'),
      input,
    ],
    (close) => [
      el('button', {
        class: 'btn secondary',
        onclick: () => { navigator.clipboard?.writeText(link).then(() => toast('Copied.', 'good')); },
      }, 'Copy link'),
      el('button', { class: 'btn', onclick: close }, 'Done'),
    ]);
}

function editApplicationModal(file) {
  const typeSel = el('select', null, el('option', { value: '' }, '—'),
    BK.meta.application_types.filter((t) => t.active).map((t) =>
      el('option', { value: t.id, selected: file.application_type_id === t.id ? '' : undefined }, t.name)));
  const price = el('input', { type: 'number', value: file.purchase_price ?? '', step: '1000' });
  const down = el('input', { type: 'number', value: file.down_payment ?? '', step: '1000' });
  const amount = el('input', { type: 'number', value: file.mortgage_amount ?? '', step: '1000' });
  const address = el('input', { type: 'text', value: file.property_address || '' });
  const ptype = el('input', { type: 'text', value: file.property_type || '' });
  const closing = el('input', { type: 'date', value: file.closing_date || '' });
  const fthb = el('input', { type: 'checkbox', checked: file.fthb ? '' : undefined });
  const purpose = el('textarea', null, file.purpose || '');

  openModal('Edit application',
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Application type'), typeSel),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Purchase price'), price),
        el('label', { class: 'field' }, el('span', null, 'Down payment'), down),
        el('label', { class: 'field' }, el('span', null, 'Mortgage amount'), amount)),
      el('label', { class: 'field' }, el('span', null, 'Property address'), address),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Property type'), ptype),
        el('label', { class: 'field' }, el('span', null, 'Closing date'), closing)),
      el('label', { class: 'checkbox' }, fthb, 'First-time home buyer'),
      el('label', { class: 'field' }, el('span', null, 'Purpose of financing'), purpose),
      el('p', { class: 'faint' }, 'Changing the application type or employment details automatically updates the document checklist.')),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.patch(`/api/broker/files/${file.id}`, {
              application_type_id: typeSel.value || null,
              purchase_price: price.value, down_payment: down.value, mortgage_amount: amount.value,
              property_address: address.value, property_type: ptype.value,
              closing_date: closing.value || null, fthb: fthb.checked, purpose: purpose.value,
            });
            close(); toast('Application updated.', 'good');
            renderFileView(file.id, 'overview');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Save'),
    ]);
}

function applicantModal(file, applicant) {
  const isNew = !applicant;
  const a = applicant || {};
  const roleSel = el('select', null,
    ['co_borrower', 'spouse', 'partner', 'guarantor', 'other', 'primary'].map((r) =>
      el('option', { value: r, selected: (a.role || 'co_borrower') === r ? '' : undefined, disabled: r === 'primary' && a.role !== 'primary' ? '' : undefined },
        r.replace('_', '-'))));
  const first = el('input', { type: 'text', value: a.first_name || '' });
  const last = el('input', { type: 'text', value: a.last_name || '' });
  const email = el('input', { type: 'email', value: a.email || '' });
  const phone = el('input', { type: 'tel', value: a.phone || '' });
  const dob = el('input', { type: 'date', value: a.dob || '' });
  const empSel = el('select', null,
    ['', 'employee', 'self_employed', 'retired', 'unemployed', 'other'].map((v) =>
      el('option', { value: v, selected: (a.employment_type || '') === v ? '' : undefined }, v ? v.replace('_', '-') : 'Not set')));
  const employer = el('input', { type: 'text', value: a.employer_name || '' });
  const job = el('input', { type: 'text', value: a.job_title || '' });
  const invite = el('input', { type: 'checkbox' });

  openModal(isNew ? 'Add applicant' : `Edit ${a.name}`,
    el('div', null,
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'First name'), first),
        el('label', { class: 'field' }, el('span', null, 'Last name'), last)),
      el('label', { class: 'field' }, el('span', null, 'Role on this application'), roleSel),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Email'), email),
        el('label', { class: 'field' }, el('span', null, 'Phone'), phone)),
      el('label', { class: 'field' }, el('span', null, 'Date of birth'), dob),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Employment'), empSel),
        el('label', { class: 'field' }, el('span', null, 'Employer'), employer),
        el('label', { class: 'field' }, el('span', null, 'Job title'), job)),
      isNew ? el('label', { class: 'checkbox' }, invite, 'Invite to the client portal right away') : null),
    (close) => [
      !isNew && a.role !== 'primary' ? el('button', {
        class: 'btn danger', style: 'margin-right:auto',
        onclick: async () => {
          if (!(await confirmDialog('Remove this applicant from the file?', { danger: true, confirmLabel: 'Remove' }))) return;
          try {
            await api.del(`/api/broker/applicants/${a.id}`);
            close(); toast('Applicant removed.'); renderFileView(file.id, 'overview');
          } catch (err) { toast(err.message, 'bad'); }
        },
      }, 'Remove') : null,
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = {
            role: roleSel.value, first_name: first.value, last_name: last.value,
            email: email.value, phone: phone.value, dob: dob.value || null,
            employment_type: empSel.value, employer_name: employer.value, job_title: job.value,
          };
          try {
            if (isNew) {
              payload.invite = invite.checked;
              const res = await api.post(`/api/broker/files/${file.id}/applicants`, payload);
              if (res.invite && res.invite.temporary_password) credentialsModal(res.invite);
            } else {
              await api.patch(`/api/broker/applicants/${a.id}`, payload);
            }
            close(); toast('Saved.', 'good'); renderFileView(file.id, 'overview');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Save'),
    ]);
}

function changeStageModal(file) {
  const sel = el('select', null, activeStages().map((s) =>
    el('option', { value: s.id, selected: file.stage && file.stage.id === s.id ? '' : undefined }, s.name)));
  const note = el('input', { type: 'text', placeholder: 'Optional note for the file history' });
  const stageInfo = el('p', { class: 'faint' });
  const updateInfo = () => {
    const s = BK.meta.stages.find((x) => x.id === Number(sel.value));
    stageInfo.textContent = s
      ? `Client sees: "${s.client_label}". ${s.send_email ? 'An email notification will be sent. ' : ''}${s.create_task ? 'A follow-up task will be created.' : ''}`
      : '';
  };
  sel.addEventListener('change', updateInfo);
  updateInfo();
  openModal('Change stage',
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'New stage'), sel),
      stageInfo,
      el('label', { class: 'field' }, el('span', null, 'Note'), note)),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.post(`/api/broker/files/${file.id}/stage`, { stage_id: sel.value, note: note.value });
            close(); toast('Stage updated — the client can see it now.', 'good');
            renderFileView(file.id, 'overview');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Update stage'),
    ]);
}

// ------------------------------------------------------------------ documents tab

async function renderFileDocuments(body, file) {
  clearNode(body);
  body.append(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:120px' })));
  const res = await api.get(`/api/broker/files/${file.id}/documents`);
  const requests = res.requests;
  clearNode(body);

  const progress = res.progress;
  body.append(el('div', { class: 'card tight row wrap' },
    el('span', { class: 'pill brand' }, `${progress.approved}/${progress.total_required} approved`),
    progress.awaiting_review ? el('span', { class: 'pill info' }, `${progress.awaiting_review} to review`) : null,
    progress.outstanding ? el('span', { class: 'pill warn' }, `${progress.outstanding} outstanding`) : null,
    progress.complete ? el('span', { class: 'pill good' }, 'Checklist complete ✓') : null,
    el('div', { class: 'spacer' }),
    can('documents.request') ? el('button', { class: 'btn sm', onclick: () => requestDocModal(file) }, '+ Request document') : null));

  if (requests.length === 0) {
    body.append(el('div', { class: 'card empty' },
      el('div', { class: 'big' }, '📄'),
      el('p', null, 'No documents on this checklist yet. Set the application type and employment details, or request a document manually.')));
    return;
  }

  // Group by applicant (file-level docs under "Application documents").
  const groups = new Map();
  for (const r of requests) {
    const key = r.applicant_name || 'Application documents';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  for (const [groupName, list] of groups) {
    body.append(el('div', { class: 'doc-group-title' }, groupName));
    const card = el('div', { class: 'card' });
    const ul = el('ul', { class: 'list' });
    for (const r of list) ul.append(brokerDocRow(file, r));
    card.append(ul);
    body.append(card);
  }

  // Documents removed for this client specifically — restorable without
  // touching the brokerage's global defaults.
  try {
    const ex = await api.get(`/api/broker/files/${file.id}/checklist/exclusions`);
    if (ex.exclusions.length) {
      body.append(el('div', { class: 'card tight' },
        el('div', { class: 'faint', style: 'margin-bottom:6px' },
          'Removed for this client (your global defaults are unchanged):'),
        el('div', { class: 'row wrap' }, ex.exclusions.map((e) => el('button', {
          class: 'chip',
          onclick: async () => {
            try {
              await api.post(`/api/broker/files/${file.id}/checklist/restore`, { document_type_id: e.document_type_id });
              toast(`${e.document_name} restored.`, 'good');
              renderFileView(file.id, 'documents');
            } catch (err) { toast(err.message, 'bad'); }
          },
        }, `+ ${e.document_name}`)))));
    }
  } catch { /* non-fatal */ }
}

function brokerDocRow(file, r) {
  const pill = r.status === 'required' && r.requirement === 'optional'
    ? { label: 'Not uploaded', cls: '' }
    : brokerDocPill(r.status);
  const versions = r.versions || [];
  const versionsHolder = el('div', { class: 'hidden' });
  if (versions.length > 1 || (versions.length === 1 && versions[0].status !== 'uploaded')) {
    for (const v of versions) {
      const vp = brokerDocPill(v.status === 'replaced' ? 'waived' : v.status);
      versionsHolder.append(el('div', { class: 'version-row' },
        el('span', { class: 'faint' }, `v${v.version}`),
        el('span', { class: 'grow', style: 'overflow-wrap:anywhere' }, v.display_name),
        el('span', { class: `pill ${v.status === 'replaced' ? '' : vp.cls}` }, v.status === 'replaced' ? 'Replaced' : vp.label),
        el('span', { class: 'faint' }, fmtDateTime(v.uploaded_at)),
        el('button', { class: 'btn-link small', onclick: () => previewVersion(v) }, 'View')));
    }
  }

  const actions = [];
  const reviewable = ['uploaded', 'under_review'].includes(r.status) && r.current_version;
  if (reviewable && can('documents.review')) {
    actions.push(
      el('button', { class: 'btn sm good', onclick: () => reviewModal(file, r, 'approve') }, 'Approve'),
      el('button', { class: 'btn sm secondary', onclick: () => reviewModal(file, r, 'request_replacement') }, 'Request replacement'));
  }
  if (r.current_version) {
    // Opening a document inline is the same disclosure as downloading it, so
    // both need documents.download. The server enforces this; the UI just
    // avoids offering a button that would be refused (audit finding H6).
    if (can('documents.download')) {
      actions.push(el('button', { class: 'btn sm secondary', onclick: () => previewVersion(r.current_version) }, 'Preview'));
      actions.push(el('a', { class: 'btn sm secondary', href: `/api/broker/versions/${r.current_version.id}/file?disposition=attachment` }, 'Download'));
    } else {
      actions.push(el('span', { class: 'faint' }, 'Received — your role cannot open documents'));
    }
  }
  if (['required', 'rejected', 'replacement_requested', 'expired'].includes(r.status) && can('documents.request')) {
    actions.push(el('button', {
      class: 'btn sm secondary',
      onclick: async (e) => {
        e.target.disabled = true;
        try { await api.post(`/api/broker/requests/${r.id}/remind`, {}); toast('Reminder sent.', 'good'); }
        catch (err) { toast(err.message, 'bad'); }
        e.target.disabled = false;
      },
    }, '⏰ Remind'));
  }
  if (can('documents.upload')) actions.push(brokerUploadBtn(file, r));
  if (can('documents.request')) {
    actions.push(el('button', { class: 'btn sm secondary', onclick: () => editRequestModal(file, r) }, '⋯'));
  }

  return el('li', null,
    el('div', { class: 'row top wrap' },
      el('div', { class: 'grow' },
        el('div', { class: 'row wrap' },
          el('span', { style: 'font-weight:600' }, r.document_name),
          el('span', { class: `pill ${pill.cls}` }, pill.label),
          r.requirement === 'optional' ? el('span', { class: 'pill' }, 'Optional') : null,
          r.source === 'manual' ? el('span', { class: 'pill' }, 'Manual') : null),
        r.due_date ? el('div', { class: 'faint' }, `Due ${fmtDate(r.due_date)}`) : null,
        r.expires_at ? el('div', { class: 'faint' }, `Valid until ${fmtDate(r.expires_at)}`) : null,
        r.client_message ? el('div', { class: 'small muted' }, `Client note: “${r.client_message}”`) : null,
        r.client_comment ? el('div', { class: 'small', style: 'color:var(--warn)' }, `Client says: “${r.client_comment}”`) : null,
        r.internal_note ? el('div', { class: 'faint' }, `Internal: ${r.internal_note}`) : null,
        r.current_version ? el('div', { class: 'faint' }, `Current: ${r.current_version.display_name} (${fmtSize(r.current_version.size)}, ${fmtDateTime(r.current_version.uploaded_at)})`) : null,
        r.reminder_count ? el('div', { class: 'faint' }, `${r.reminder_count} reminder${r.reminder_count > 1 ? 's' : ''} sent`) : null,
        aiReviewPanel(file, r),
        storageBadge(r.current_version)),
      el('div', { class: 'row wrap', style: 'justify-content:flex-end' }, actions)),
    versions.length ? el('button', {
      class: 'btn-link small',
      onclick: (e) => {
        versionsHolder.classList.toggle('hidden');
        e.target.textContent = versionsHolder.classList.contains('hidden') ? `History (${versions.length})` : 'Hide history';
      },
    }, `History (${versions.length})`) : null,
    versionsHolder);
}

/**
 * Internal AI review summary. Brokerage-only: the client portal never
 * receives this data, and the broker still makes every approve/reject call.
 */
function aiReviewPanel(file, r) {
  const review = r.ai_review;
  if (!review) return null;

  if (review.status === 'pending' || review.status === 'running') {
    return el('div', { class: 'ai-panel muted small' }, '🧠 AI review in progress…');
  }
  if (review.status === 'failed') {
    return el('div', { class: 'ai-panel bad-tint small' },
      el('div', null, `🧠 AI review failed: ${review.error || 'unknown error'}`),
      can('documents.review') ? el('button', {
        class: 'btn-link small',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.post(`/api/broker/ai-reviews/${review.id}/retry`, {});
            toast('Review queued for another attempt.', 'good');
          } catch (err) { toast(err.message, 'bad'); }
        },
      }, 'Retry review') : null);
  }
  if (review.status !== 'done' || !review.result) return null;

  const result = review.result;
  const details = el('div', { class: 'hidden' },
    result.extracted && Object.keys(result.extracted).length
      ? el('table', { class: 'data', style: 'margin-top:6px' },
          el('tbody', null, Object.entries(result.extracted).map(([k, v]) =>
            el('tr', null,
              el('td', { class: 'faint', style: 'width:45%' }, k.replace(/_/g, ' ')),
              el('td', null, String(v))))))
      : null,
    (result.issues || []).length
      ? el('ul', { style: 'margin:8px 0 0 18px' }, result.issues.map((i) => el('li', { class: 'small' }, i)))
      : null,
    result.suggested_action ? el('div', { class: 'small', style: 'margin-top:6px' }, `Suggested: ${result.suggested_action}`) : null
  );

  return el('div', { class: 'ai-panel' },
    el('div', { class: 'row wrap' },
      el('span', null, '🧠'),
      el('span', { style: 'font-weight:600' }, 'AI review'),
      el('span', { class: `pill ${result.matches_expected === false ? 'warn' : 'good'}` },
        result.detected_type || 'reviewed'),
      result.confidence ? el('span', { class: 'pill' }, `${result.confidence} confidence`) : null,
      (result.issues || []).length ? el('span', { class: 'pill warn' }, `${result.issues.length} issue${result.issues.length > 1 ? 's' : ''}`) : null,
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn-link small',
        onclick: (e) => {
          details.classList.toggle('hidden');
          e.target.textContent = details.classList.contains('hidden') ? 'Details' : 'Hide';
        },
      }, 'Details')),
    result.summary ? el('div', { class: 'small muted', style: 'margin-top:2px' }, result.summary) : null,
    details,
    el('div', { class: 'faint', style: 'margin-top:4px' }, 'Internal only — never shown to the client. You decide approval.')
  );
}

/** Where the original file lives in the brokerage's OneDrive. */
function storageBadge(version) {
  if (!version || !version.onedrive_status) return null;
  if (version.onedrive_status === 'done') {
    return el('div', { class: 'faint' }, `☁️ Stored in OneDrive: ${version.onedrive_path || ''}`);
  }
  if (version.onedrive_status === 'failed') {
    return el('div', { class: 'faint', style: 'color:var(--bad)' }, `☁️ OneDrive copy failed: ${version.onedrive_error || ''}`);
  }
  return el('div', { class: 'faint' }, '☁️ Copying to OneDrive…');
}

function brokerUploadBtn(file, r) {
  const input = el('input', { type: 'file', class: 'hidden', accept: '.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp' });
  input.addEventListener('change', async () => {
    if (!input.files.length) return;
    const f = input.files[0];
    try {
      await api.upload(`/api/broker/requests/${r.id}/upload`, f, f.name);
      toast(`Uploaded ${f.name}.`, 'good');
      renderFileView(file.id, 'documents');
    } catch (err) { toast(err.message, 'bad'); }
    input.value = '';
  });
  return el('span', null, el('button', { class: 'btn sm secondary', onclick: () => input.click() }, '📎 Upload'), input);
}

function previewVersion(version) {
  const url = `/api/broker/versions/${version.id}/file`;
  const isImage = version.mime.startsWith('image/') && !version.mime.includes('heic') && !version.mime.includes('heif');
  const isPdf = version.mime === 'application/pdf';
  let content;
  if (isImage) content = el('img', { src: url, alt: version.display_name, style: 'max-width:100%;border-radius:8px' });
  else if (isPdf) content = el('iframe', { src: url, style: 'width:100%;height:65vh;border:1px solid var(--line);border-radius:8px', title: version.display_name });
  else content = el('p', { class: 'muted' }, 'This file type (e.g. HEIC photo) cannot be previewed in the browser. Download it to view.');
  openModal(version.display_name, content, (close) => [
    can('documents.download') ? el('a', { class: 'btn secondary', href: url + '?disposition=attachment' }, 'Download') : null,
    el('button', { class: 'btn', onclick: close }, 'Close'),
  ]);
}

function reviewModal(file, r, defaultAction) {
  const action = el('select', null,
    el('option', { value: 'approve', selected: defaultAction === 'approve' ? '' : undefined }, '✓ Approve'),
    el('option', { value: 'request_replacement', selected: defaultAction === 'request_replacement' ? '' : undefined }, 'Request replacement'),
    el('option', { value: 'reject', selected: defaultAction === 'reject' ? '' : undefined }, 'Not approved'));
  const clientNote = el('textarea', { placeholder: 'e.g. Please upload your most recent pay stub.' });
  const internalNote = el('input', { type: 'text', placeholder: 'Internal note (never shown to the client)' });
  const sendEmail = el('input', { type: 'checkbox', checked: '' });
  const noteField = el('label', { class: 'field' }, el('span', null, 'Message to the client'), clientNote);
  const syncNote = () => { noteField.querySelector('span').textContent = action.value === 'approve' ? 'Message to the client (optional)' : 'Message to the client (required)'; };
  action.addEventListener('change', syncNote);
  syncNote();

  openModal(`Review: ${r.document_name}`,
    el('div', null,
      r.current_version ? el('p', { class: 'small muted' }, `Reviewing v${r.current_version.version}: ${r.current_version.display_name}`) : null,
      el('label', { class: 'field' }, el('span', null, 'Decision'), action),
      noteField,
      el('label', { class: 'field' }, el('span', null, 'Internal note'), internalNote),
      el('label', { class: 'checkbox' }, sendEmail, 'Email the client about this decision')),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.post(`/api/broker/requests/${r.id}/review`, {
              action: action.value, client_note: clientNote.value, internal_note: internalNote.value,
              send_email: sendEmail.checked,
            });
            close(); toast('Review saved — the client can see it now.', 'good');
            renderFileView(file.id, 'documents');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Save review'),
    ]);
}

function requestDocModal(file) {
  const typeSel = el('select', null, BK.meta.document_types.filter((t) => t.active).map((t) => el('option', { value: t.id }, t.name)));
  const applicantSel = el('select', null, el('option', { value: '' }, 'Whole application'));
  api.get(`/api/broker/files/${file.id}`).then((d) => {
    for (const a of d.applicants) applicantSel.append(el('option', { value: a.id }, a.name));
  });
  const due = el('input', { type: 'date' });
  const message = el('textarea', { placeholder: 'e.g. Please upload your most recent pay stub.' });
  const optional = el('input', { type: 'checkbox' });
  const sendEmail = el('input', { type: 'checkbox', checked: '' });

  openModal('Request a document',
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Document type'), typeSel),
      el('label', { class: 'field' }, el('span', null, 'From'), applicantSel),
      el('label', { class: 'field' }, el('span', null, 'Due date (optional)'), due),
      el('label', { class: 'field' }, el('span', null, 'Message to the client'), message),
      el('label', { class: 'checkbox' }, optional, 'Optional (nice to have)'),
      el('label', { class: 'checkbox' }, sendEmail, 'Send an email notification now')),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.post(`/api/broker/files/${file.id}/requests`, {
              document_type_id: typeSel.value,
              applicant_id: applicantSel.value || null,
              due_date: due.value || null,
              client_message: message.value,
              requirement: optional.checked ? 'optional' : 'required',
              send_email: sendEmail.checked,
            });
            close(); toast('Document requested — it now appears on the client portal.', 'good');
            renderFileView(file.id, 'documents');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Request'),
    ]);
}

function editRequestModal(file, r) {
  const typeSel = el('select', null, BK.meta.document_types.map((t) =>
    el('option', { value: t.id, selected: t.id === r.document_type_id ? '' : undefined }, t.name)));
  const applicantSel = el('select', null, el('option', { value: '' }, 'Whole application'));
  api.get(`/api/broker/files/${file.id}`).then((d) => {
    for (const a of d.applicants) {
      applicantSel.append(el('option', { value: a.id, selected: a.id === r.applicant_id ? '' : undefined }, a.name));
    }
  });
  const due = el('input', { type: 'date', value: r.due_date || '' });
  const message = el('textarea', null, r.client_message || '');
  const internal = el('input', { type: 'text', value: r.internal_note || '' });
  const expires = el('input', { type: 'number', value: r.expires_days ?? '', placeholder: 'e.g. 60' });
  const optional = el('input', { type: 'checkbox', checked: r.requirement === 'optional' ? '' : undefined });
  const reminders = el('input', { type: 'checkbox', checked: r.reminders_enabled ? '' : undefined });

  openModal(`Edit: ${r.document_name}`,
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Classified as'), typeSel),
      el('label', { class: 'field' }, el('span', null, 'Belongs to'), applicantSel),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Due date'), due),
        el('label', { class: 'field' }, el('span', null, 'Valid for (days after approval)'), expires)),
      el('label', { class: 'field' }, el('span', null, 'Message to the client'), message),
      el('label', { class: 'field' }, el('span', null, 'Internal note'), internal),
      el('label', { class: 'checkbox' }, optional, 'Optional (nice to have)'),
      el('label', { class: 'checkbox' }, reminders, 'Automatic reminders for this item')),
    (close) => [
      el('button', {
        class: 'btn danger', style: 'margin-right:auto',
        onclick: async () => {
          if (!(await confirmDialog('Remove this request? If documents were uploaded it will be waived instead (history is preserved).', { danger: true, confirmLabel: 'Remove' }))) return;
          await api.del(`/api/broker/requests/${r.id}`);
          close(); toast('Removed.'); renderFileView(file.id, 'documents');
        },
      }, 'Remove'),
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.patch(`/api/broker/requests/${r.id}`, {
              document_type_id: typeSel.value, applicant_id: applicantSel.value || null,
              due_date: due.value || null, client_message: message.value, internal_note: internal.value,
              expires_days: expires.value || null,
              requirement: optional.checked ? 'optional' : 'required',
              reminders_enabled: reminders.checked,
            });
            close(); toast('Saved.', 'good'); renderFileView(file.id, 'documents');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Save'),
    ]);
}

// ------------------------------------------------------------------ messages tab

function stopBrokerChat() {
  if (BK.chatTimer) { clearInterval(BK.chatTimer); BK.chatTimer = null; }
}

async function renderFileMessages(body, file) {
  clearNode(body);
  const scroll = el('div', { class: 'chat-scroll' });
  const search = el('input', { type: 'search', placeholder: 'Search this conversation…', 'aria-label': 'Search messages', style: 'max-width:260px' });
  const textarea = el('textarea', { placeholder: 'Write a message to the client…', rows: '1' });
  const sendEmailToggle = el('input', { type: 'checkbox' });
  const send = el('button', { class: 'btn' }, 'Send');

  async function submit() {
    const bodyText = textarea.value.trim();
    if (!bodyText) return;
    send.disabled = true;
    try {
      await api.post(`/api/broker/files/${file.id}/messages`, { body: bodyText, send_email: sendEmailToggle.checked });
      textarea.value = '';
      await load();
    } catch (err) { toast(err.message, 'bad'); }
    send.disabled = false;
    textarea.focus();
  }
  send.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

  body.append(
    el('div', { class: 'row', style: 'margin-bottom:10px' }, search, el('div', { class: 'spacer' }),
      el('label', { class: 'checkbox', style: 'margin:0' }, sendEmailToggle, el('span', { class: 'small' }, 'Also notify by email'))),
    el('div', { class: 'chat-panel chat-box' },
      scroll,
      can('chat.send') ? el('div', { class: 'chat-input' }, textarea, send) : null));

  BK.lastMessageId = 0;
  let allMessages = [];

  function paint() {
    clearNode(scroll);
    const q = search.value.trim().toLowerCase();
    const list = q ? allMessages.filter((m) => m.body.toLowerCase().includes(q)) : allMessages;
    if (list.length === 0) {
      scroll.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '💬'),
        el('p', null, q ? 'No messages match your search.' : 'No messages yet. Start the conversation — the client sees it instantly in their portal.')));
      return;
    }
    for (const m of list) {
      scroll.append(el('div', { class: `chat-msg ${m.sender_kind === 'staff' ? 'mine' : 'theirs'}` },
        el('div', null, m.body),
        el('div', { class: 'meta' }, `${m.sender_name} · ${fmtDateTime(m.created_at)}${m.edited_at ? ' (edited)' : ''}${m.sender_kind === 'staff' && m.read_by_client_at ? ' · Read' : ''}`)));
    }
    scroll.scrollTop = scroll.scrollHeight;
  }
  search.addEventListener('input', debounce(paint, 200));

  async function load() {
    const res = await api.get(`/api/broker/files/${file.id}/messages?after=${BK.lastMessageId}`);
    if (res.messages.length) {
      allMessages = allMessages.concat(res.messages);
      BK.lastMessageId = allMessages[allMessages.length - 1].id;
      paint();
      api.post(`/api/broker/files/${file.id}/messages/read`, {}).catch(() => {});
    } else if (allMessages.length === 0) {
      paint();
    }
  }
  await load();
  stopBrokerChat();
  BK.chatTimer = setInterval(load, 5000);
}

// ------------------------------------------------------------------ tasks tab

async function renderFileTasks(body, file) {
  clearNode(body);
  const res = await api.get(`/api/broker/tasks?file_id=${file.id}&filter=all`);
  body.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('h3', { class: 'grow', style: 'margin:0' }, 'Tasks for this file'),
      can('tasks.manage') ? el('button', { class: 'btn sm', onclick: () => addTaskModal(file) }, '+ Add task') : null),
    res.tasks.length === 0
      ? el('div', { class: 'card empty' }, el('p', null, 'No tasks for this file. Add a follow-up so nothing slips.'))
      : el('div', { class: 'card' }, el('ul', { class: 'list' }, res.tasks.map((t) => taskRow(t, () => renderFileView(file.id, 'tasks'))))));
}

function taskRow(t, refresh) {
  const done = t.status === 'completed';
  const checkbox = el('input', { type: 'checkbox', checked: done ? '' : undefined, 'aria-label': `Complete ${t.title}` });
  checkbox.addEventListener('change', async () => {
    try {
      await api.patch(`/api/broker/tasks/${t.id}`, { status: checkbox.checked ? 'completed' : 'pending' });
      refresh();
    } catch (err) { toast(err.message, 'bad'); }
  });
  const overdue = !done && t.due_date && t.due_date < new Date().toISOString().slice(0, 10);
  return el('li', { class: 'row top' },
    checkbox,
    el('div', { class: 'grow' },
      el('div', { style: done ? 'text-decoration:line-through;color:var(--ink-faint)' : 'font-weight:600' }, t.title),
      t.description ? el('div', { class: 'small muted' }, t.description) : null,
      el('div', { class: 'faint' }, [
        t.due_date ? `Due ${fmtDate(t.due_date)}` : null,
        t.assigned_name, t.file_number, t.source === 'auto' ? 'Automatic' : null,
      ].filter(Boolean).join(' · '))),
    t.priority === 'high' ? el('span', { class: 'pill bad' }, 'High') : null,
    overdue ? el('span', { class: 'pill bad' }, 'Overdue') : null,
    t.status === 'cancelled' ? el('span', { class: 'pill' }, 'Cancelled') : null);
}

function addTaskModal(file, refresh) {
  const title = el('input', { type: 'text', placeholder: 'e.g. Call client about employment letter' });
  const desc = el('textarea', { placeholder: 'Details (optional)' });
  const due = el('input', { type: 'date' });
  const priority = el('select', null, ['normal', 'high', 'low'].map((p) => el('option', { value: p }, p)));
  const assignee = el('select', null, BK.staff.map((s) =>
    el('option', { value: s.id, selected: s.id === BK.me.user.id ? '' : undefined }, `${s.first_name} ${s.last_name}`)));
  openModal(file ? `Add task — ${file.client_name || file.file_number}` : 'Add task',
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Task'), title),
      el('label', { class: 'field' }, el('span', null, 'Description'), desc),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Due date'), due),
        el('label', { class: 'field' }, el('span', null, 'Priority'), priority),
        el('label', { class: 'field' }, el('span', null, 'Assigned to'), assignee))),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.post('/api/broker/tasks', {
              file_id: file ? file.id : null, title: title.value, description: desc.value,
              due_date: due.value || null, priority: priority.value, assigned_to: assignee.value,
            });
            close(); toast('Task added.', 'good');
            if (refresh) refresh(); else if (file) renderFileView(file.id, 'tasks');
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, 'Add task'),
    ]);
}

// ------------------------------------------------------------------ notes tab

async function renderFileNotes(body, file) {
  clearNode(body);
  const res = await api.get(`/api/broker/files/${file.id}/notes`);
  const textarea = el('textarea', { placeholder: 'e.g. Client prefers email. Travelling until Friday.' });
  const pinned = el('input', { type: 'checkbox' });

  body.append(
    el('div', { class: 'card' },
      el('h3', null, 'Add a private note'),
      el('p', { class: 'faint' }, '🔒 Notes are internal to the brokerage and never visible to the client.'),
      textarea,
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('label', { class: 'checkbox', style: 'margin:0' }, pinned, 'Pin as important'),
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn',
          onclick: async (e) => {
            if (!textarea.value.trim()) return;
            e.target.disabled = true;
            try {
              await api.post(`/api/broker/files/${file.id}/notes`, { body: textarea.value, pinned: pinned.checked });
              renderFileView(file.id, 'notes');
            } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
          },
        }, 'Save note'))),
    res.notes.length === 0
      ? el('div', { class: 'card empty' }, el('p', null, 'No notes yet.'))
      : el('div', { class: 'card' }, el('ul', { class: 'list' }, res.notes.map((n) => el('li', null,
          el('div', { class: 'row top' },
            n.pinned ? el('span', null, '📌') : null,
            el('div', { class: 'grow', style: 'white-space:pre-wrap' }, n.body),
            el('button', {
              class: 'btn-link small',
              onclick: async () => {
                await api.patch(`/api/broker/notes/${n.id}`, { pinned: !n.pinned });
                renderFileView(file.id, 'notes');
              },
            }, n.pinned ? 'Unpin' : 'Pin'),
            el('button', {
              class: 'btn-link small', style: 'color:var(--bad)',
              onclick: async () => {
                if (!(await confirmDialog('Delete this note?', { danger: true, confirmLabel: 'Delete' }))) return;
                await api.del(`/api/broker/notes/${n.id}`);
                renderFileView(file.id, 'notes');
              },
            }, 'Delete')),
          el('div', { class: 'faint' },
            `${n.created_by_name || 'Unknown'} · ${fmtDateTime(n.created_at)}${n.updated_at ? ` · edited ${fmtDateTime(n.updated_at)} by ${n.updated_by_name || ''}` : ''}`))))));
}

// ------------------------------------------------------------------ activity & emails tabs

const ACTIVITY_ICONS = {
  client_created: '✨', checklist_created: '📋', checklist_updated: '📋', email_sent: '✉️',
  client_login: '🔑', account_activated: '🔑', document_uploaded: '📤', document_approved: '✅',
  document_rejected: '⚠️', document_requested: '📄', document_expired: '⏳', reminder_sent: '⏰',
  stage_changed: '🚀', message_sent: '💬', task_created: '➕', task_completed: '☑️',
  applicant_added: '👥', applicant_updated: '👥', applicant_removed: '👥', file_updated: '✏️',
  status_changed: '🗂️', assigned: '🤝', consent_requested: '📝', consent_completed: '📝',
  consent_declined: '📝', client_doc_response: '💬', client_profile_updated: '👤', checklist_complete: '🎉',
  document_classified: '🏷️', document_waived: '🚫', document_request_removed: '🗑️',
};

async function renderFileActivity(body, file) {
  clearNode(body);
  const res = await api.get(`/api/broker/files/${file.id}/activity`);
  if (res.activity.length === 0) {
    body.append(el('div', { class: 'card empty' }, el('p', null, 'No activity yet.')));
    return;
  }
  body.append(el('div', { class: 'card' },
    el('ul', { class: 'timeline' }, res.activity.map((a) => el('li', null,
      el('span', { class: 't-dot' }),
      el('div', null, `${ACTIVITY_ICONS[a.kind] || '•'} ${a.message}`),
      el('div', { class: 't-time' }, `${fmtDateTime(a.created_at)} · ${a.actor_name || 'System'}`))))));
}

async function renderFileEmails(body, file) {
  clearNode(body);
  const res = await api.get(`/api/broker/files/${file.id}/emails`);
  if (res.emails.length === 0) {
    body.append(el('div', { class: 'card empty' }, el('p', null, 'No emails have been sent for this file yet.')));
    return;
  }
  body.append(el('div', { class: 'card table-wrap' },
    el('table', { class: 'data' },
      el('thead', null, el('tr', null, ['Date', 'Type', 'To', 'Subject', 'Status', ''].map((h) => el('th', null, h)))),
      el('tbody', null, res.emails.map((m) => el('tr', null,
        el('td', { class: 'nowrap' }, fmtDateTime(m.created_at)),
        el('td', null, m.template_key || '—'),
        el('td', null, m.to_email),
        el('td', null, m.subject),
        el('td', null, el('span', { class: `pill ${m.status === 'sent' ? 'good' : m.status === 'failed' ? 'bad' : ''}` }, m.status)),
        el('td', null, el('button', {
          class: 'btn-link small',
          onclick: async () => {
            const detail = await api.get(`/api/broker/emails/${m.id}`);
            openModal(detail.email.subject,
              el('div', null,
                el('p', { class: 'faint' }, `To: ${detail.email.to_email} · ${fmtDateTime(detail.email.created_at)} · ${detail.email.status}`),
                el('div', { class: 'card tight', style: 'white-space:pre-wrap;max-height:50vh;overflow-y:auto' }, detail.email.body)),
              (close) => [el('button', { class: 'btn', onclick: close }, 'Close')]);
          },
        }, 'View'))))))));
}
