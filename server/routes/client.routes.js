'use strict';

/**
 * Client portal API. Every endpoint derives the accessible file set from the
 * signed-in user's applicant links (clientFileIds / clientFileOrThrow) —
 * authorization is enforced server-side on every query, never by the UI.
 * Records outside that set return 404 so nothing about other clients leaks.
 */

const { run, get, all, getSetting, touchFile } = require('../db');
const { requireClient, clientFileIds, clientFileOrThrow } = require('../auth');
const { ApiError, now, str, fullName } = require('../util');
const { audit, activity } = require('../log');
const { notifyStaffForFile } = require('../notify');
const { clientNextStep } = require('../nextstep');
const { requestFull, messageRow } = require('../serialize');
const { checklistProgress } = require('../checklist');
const { saveRequestBody, openStored } = require('../storage');
const { recordVersion, afterClientUpload } = require('./broker.routes');
const { HANDLED } = require('../router');

/** Load a document request only if it belongs to one of the client's files. */
function clientRequestOrThrow(userId, requestId) {
  const request = get('SELECT * FROM document_requests WHERE id = ?', Number(requestId));
  if (!request || !clientFileIds(userId).includes(request.file_id)) {
    throw new ApiError(404, 'Not found.', 'not_found');
  }
  return request;
}

function clientFileOverview(user, file) {
  const stage = file.stage_id ? get('SELECT * FROM stages WHERE id = ?', file.stage_id) : null;
  const steps = getSetting('client_steps', []);
  const brokerage = getSetting('brokerage', {});
  const broker = file.assigned_broker_id ? get('SELECT * FROM users WHERE id = ?', file.assigned_broker_id) : null;
  const applicants = all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', file.id);
  const me = applicants.find((a) => a.portal_user_id === user.id) || applicants[0];

  const requests = all('SELECT id FROM document_requests WHERE file_id = ? ORDER BY id', file.id)
    .map((r) => requestFull(r.id))
    .filter((r) => r && r.status !== 'waived');
  const needed = requests.filter((r) => r.client_status.kind === 'action' && r.requirement === 'required');
  const optional = requests.filter((r) => r.client_status.kind === 'action' && r.requirement === 'optional');
  const inReview = requests.filter((r) => r.client_status.kind === 'waiting');
  const done = requests
    .filter((r) => r.status === 'approved')
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

  const unreadMessages = get(
    "SELECT COUNT(*) AS n FROM messages WHERE file_id = ? AND sender_kind = 'staff' AND read_by_client_at IS NULL",
    file.id
  ).n;

  // Profile completion: only genuinely relevant fields.
  const relevant = [
    ['phone', me && me.phone],
    ['date of birth', me && me.dob],
    ['current address', me && me.address],
    ['employment details', me && me.employment_type],
  ];
  const missing = relevant.filter(([, v]) => !v).map(([label]) => label);
  const completion = Math.round(((relevant.length - missing.length) / relevant.length) * 100);

  const consents = all(
    `SELECT id, form_title, status, requested_at FROM consents
      WHERE file_id = ? AND (applicant_id IS NULL OR applicant_id = ?) AND status = 'requested'`,
    file.id, me ? me.id : -1
  );

  return {
    file_id: file.id,
    file_number: file.file_number,
    status: file.status,
    property_address: file.property_address,
    closing_date: file.closing_date,
    my_name: me ? me.first_name : user.first_name,
    applicant_names: applicants.map((a) => fullName(a)),
    stage: stage
      ? { label: stage.client_label || stage.name, message: stage.client_message, step: stage.client_step, color: stage.color, is_terminal: !!stage.is_terminal }
      : null,
    steps,
    next_step: clientNextStep(file),
    needed,
    optional,
    in_review: inReview,
    recently_completed: done.slice(0, 5),
    unread_messages: unreadMessages,
    profile: { completion, missing },
    pending_consents: consents,
    broker: {
      name: broker ? `${broker.first_name} ${broker.last_name}`.trim() : brokerage.broker_name || 'Your broker',
      brokerage_name: brokerage.name || '',
      phone: brokerage.phone || '',
      email: brokerage.email || '',
    },
  };
}

function register(router) {
  router.get('/api/client/overview', requireClient, (ctx) => {
    const ids = clientFileIds(ctx.user.id);
    const files = ids
      .map((id) => get('SELECT * FROM client_files WHERE id = ?', id))
      .filter(Boolean)
      .sort((a, b) => (a.status === 'active' ? -1 : 1));
    return {
      show_welcome: !ctx.user.welcomed_at,
      first_name: ctx.user.first_name,
      files: files.map((f) => clientFileOverview(ctx.user, f)),
    };
  });

  router.get('/api/client/files/:fileId/documents', requireClient, (ctx) => {
    const file = clientFileOrThrow(ctx.user.id, ctx.params.fileId);
    const requests = all('SELECT id FROM document_requests WHERE file_id = ? ORDER BY id', file.id)
      .map((r) => requestFull(r.id))
      .filter((r) => r && r.status !== 'waived');
    return { requests, progress: checklistProgress(file.id) };
  });

  router.post('/api/client/requests/:id/upload', requireClient, async (ctx) => {
    const request = clientRequestOrThrow(ctx.user.id, ctx.params.id);
    const file = get('SELECT * FROM client_files WHERE id = ?', request.file_id);
    if (file.status !== 'active') {
      throw new ApiError(400, 'This application is no longer accepting uploads. Contact your broker if you need help.', 'file_closed');
    }
    const filename = str(ctx.req.headers['x-filename'] ? decodeURIComponent(ctx.req.headers['x-filename']) : '', 300);
    const saved = await saveRequestBody(ctx.req, filename);
    const docType = get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
    const versionId = recordVersion(request, saved, filename, ctx.user);
    audit(ctx.user.id, 'document_uploaded', 'document_version', versionId, ctx.ip);
    afterClientUpload(file, request, docType.name, ctx.user);
    return { ok: true, request: requestFull(request.id) };
  }).raw();

  // A client can respond to a request they can't fulfil — it reaches the broker.
  router.post('/api/client/requests/:id/comment', requireClient, (ctx) => {
    const request = clientRequestOrThrow(ctx.user.id, ctx.params.id);
    const comment = str(ctx.body && ctx.body.comment, 1000);
    if (!comment) throw new ApiError(400, 'Please write a short message first.', 'empty');
    run('UPDATE document_requests SET client_comment = ?, updated_at = ? WHERE id = ?', comment, now(), request.id);
    const file = get('SELECT * FROM client_files WHERE id = ?', request.file_id);
    const docType = get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
    activity(file.id, ctx.user, 'client_doc_response', `Client responded about ${docType.name}: "${comment.slice(0, 200)}"`);
    notifyStaffForFile(file, 'client_doc_response', `Client response about ${docType.name}`, comment.slice(0, 200), `#/files/${file.id}/documents`);
    return { ok: true };
  });

  // Clients can view their own uploaded documents (current + their own history).
  router.get('/api/client/versions/:id/file', requireClient, (ctx) => {
    const version = get('SELECT * FROM document_versions WHERE id = ?', Number(ctx.params.id));
    if (!version) throw new ApiError(404, 'Not found.', 'not_found');
    const request = get('SELECT * FROM document_requests WHERE id = ?', version.request_id);
    if (!request || !clientFileIds(ctx.user.id).includes(request.file_id)) {
      throw new ApiError(404, 'Not found.', 'not_found');
    }
    const { stream, size } = openStored(version.stored_name);
    audit(ctx.user.id, 'document_previewed', 'document_version', version.id, ctx.ip);
    ctx.res.writeHead(200, {
      'Content-Type': version.mime,
      'Content-Length': size,
      'Content-Disposition': `inline; filename="${version.original_name.replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    stream.pipe(ctx.res);
    return HANDLED;
  });

  // ------------------------------ Messages ------------------------------
  router.get('/api/client/files/:fileId/messages', requireClient, (ctx) => {
    const file = clientFileOrThrow(ctx.user.id, ctx.params.fileId);
    const after = Number(ctx.query.after) || 0;
    const rows = all(
      `SELECT m.*, u.first_name || ' ' || u.last_name AS sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.file_id = ? AND m.id > ? ORDER BY m.id LIMIT 200`,
      file.id, after
    );
    return { messages: rows.map(messageRow) };
  });

  router.post('/api/client/files/:fileId/messages', requireClient, (ctx) => {
    const file = clientFileOrThrow(ctx.user.id, ctx.params.fileId);
    const body = str(ctx.body && ctx.body.body, 4000);
    if (!body) throw new ApiError(400, 'The message was empty.', 'empty');
    const res = run(
      `INSERT INTO messages (file_id, sender_id, sender_kind, body, created_at, read_by_client_at)
       VALUES (?, ?, 'client', ?, ?, ?)`,
      file.id, ctx.user.id, body, now(), now()
    );
    touchFile(file.id);
    audit(ctx.user.id, 'message_sent', 'client_file', file.id, ctx.ip);
    notifyStaffForFile(
      file, 'new_message',
      `New message from ${ctx.user.first_name} ${ctx.user.last_name}`.trim(),
      body.slice(0, 120), `#/files/${file.id}/messages`
    );
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  router.post('/api/client/files/:fileId/messages/read', requireClient, (ctx) => {
    const file = clientFileOrThrow(ctx.user.id, ctx.params.fileId);
    run(
      "UPDATE messages SET read_by_client_at = ? WHERE file_id = ? AND sender_kind = 'staff' AND read_by_client_at IS NULL",
      now(), file.id
    );
    return { ok: true };
  });

  // ------------------------------ Notifications ------------------------------
  router.get('/api/client/notifications', requireClient, (ctx) => {
    return {
      notifications: all(
        'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50',
        ctx.user.id
      ),
    };
  });

  router.post('/api/client/notifications/read', requireClient, (ctx) => {
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

  // ------------------------------ Profile ------------------------------
  router.get('/api/client/profile', requireClient, (ctx) => {
    const applicants = all('SELECT * FROM applicants WHERE portal_user_id = ?', ctx.user.id);
    const me = applicants[0] || null;
    return {
      email: ctx.user.email,
      first_name: ctx.user.first_name,
      last_name: ctx.user.last_name,
      phone: me ? me.phone : ctx.user.phone,
      address: me ? me.address : '',
      dob: me ? me.dob : null,
      preferred_contact: me ? me.preferred_contact : 'email',
    };
  });

  router.patch('/api/client/profile', requireClient, (ctx) => {
    const b = ctx.body || {};
    const phone = str(b.phone, 40);
    const address = str(b.address, 400);
    const preferred = ['email', 'phone', 'text', 'portal'].includes(b.preferred_contact) ? b.preferred_contact : null;
    for (const applicant of all('SELECT * FROM applicants WHERE portal_user_id = ?', ctx.user.id)) {
      run(
        'UPDATE applicants SET phone = ?, address = ?, preferred_contact = ?, updated_at = ? WHERE id = ?',
        b.phone !== undefined ? phone : applicant.phone,
        b.address !== undefined ? address : applicant.address,
        preferred || applicant.preferred_contact,
        now(), applicant.id
      );
      activity(applicant.file_id, ctx.user, 'client_profile_updated', `${ctx.user.first_name} updated their contact details`);
    }
    if (b.phone !== undefined) run('UPDATE users SET phone = ?, updated_at = ? WHERE id = ?', phone, now(), ctx.user.id);
    audit(ctx.user.id, 'profile_updated', 'user', ctx.user.id, ctx.ip);
    return { ok: true };
  });

  // ------------------------------ Consents ------------------------------
  router.get('/api/client/consents', requireClient, (ctx) => {
    const ids = clientFileIds(ctx.user.id);
    if (ids.length === 0) return { consents: [] };
    const myApplicants = all('SELECT id FROM applicants WHERE portal_user_id = ?', ctx.user.id).map((r) => r.id);
    const rows = all(
      `SELECT * FROM consents WHERE file_id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC`,
      ...ids
    ).filter((c) => !c.applicant_id || myApplicants.includes(c.applicant_id));
    return { consents: rows };
  });

  router.post('/api/client/consents/:id/respond', requireClient, (ctx) => {
    const consent = get('SELECT * FROM consents WHERE id = ?', Number(ctx.params.id));
    if (!consent || !clientFileIds(ctx.user.id).includes(consent.file_id)) {
      throw new ApiError(404, 'Not found.', 'not_found');
    }
    if (consent.status !== 'requested') {
      throw new ApiError(400, 'This item has already been responded to.', 'already_done');
    }
    const accept = ctx.body && ctx.body.accept === true;
    run(
      'UPDATE consents SET status = ?, responded_at = ?, responded_by = ? WHERE id = ?',
      accept ? 'completed' : 'declined', now(), ctx.user.id, consent.id
    );
    const file = get('SELECT * FROM client_files WHERE id = ?', consent.file_id);
    activity(file.id, ctx.user, accept ? 'consent_completed' : 'consent_declined', `${consent.form_title} (v${consent.form_version}) ${accept ? 'accepted' : 'declined'} by ${ctx.user.first_name} ${ctx.user.last_name}`);
    audit(ctx.user.id, accept ? 'consent_completed' : 'consent_declined', 'consent', consent.id, ctx.ip, { form_version: consent.form_version });
    notifyStaffForFile(file, 'consent_response', `${consent.form_title} ${accept ? 'completed' : 'declined'}`, '', `#/files/${file.id}`);
    return { ok: true };
  });
}

module.exports = { register };
