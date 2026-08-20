'use strict';

/**
 * Client portal API.
 *
 * Authorization is derived server-side on every request from the signed-in
 * user's applicant links, at two levels:
 *   file level      — clientFileIds / clientFileOrThrow
 *   applicant level — visibleApplicantIds / canClientSeeRequest
 *
 * The second level is what stops a guarantor reading the primary borrower's
 * identity and banking documents just because they share a file (audit
 * finding H3). Records outside the permitted set return 404, never 403, so
 * nothing about other clients' data leaks through status codes.
 */

const { run, get, all, getSetting, touchFile } = require('../db');
const {
  requireClient, clientFileIds, clientFileOrThrow, visibleApplicantIds, canClientSeeRequest,
} = require('../auth');
const { ApiError, now, str, fullName, parseJsonSafe } = require('../util');
const { audit, activity } = require('../log');
const { notifyStaffForFile } = require('../notify');
const { clientNextStep } = require('../nextstep');
const { requestFull, clientFileRequests, messageRow } = require('../serialize');
const { checklistProgress } = require('../checklist');
const { saveRequestBody, readStored } = require('../storage');
const ratelimit = require('../ratelimit');
const scan = require('../scan');
const { HANDLED } = require('../router');

/** Load a document request only if this client may see it. */
async function clientRequestOrThrow(userId, requestId) {
  const request = await get('SELECT * FROM document_requests WHERE id = ?', Number(requestId));
  if (!(await canClientSeeRequest(userId, request))) {
    throw new ApiError(404, 'Not found.', 'not_found');
  }
  return request;
}

async function clientFileOverview(user, file) {
  const stage = file.stage_id ? await get('SELECT * FROM stages WHERE id = ?', file.stage_id) : null;
  const steps = await getSetting('client_steps', []);
  const brokerage = await getSetting('brokerage', {});
  const broker = file.assigned_broker_id ? await get('SELECT * FROM users WHERE id = ?', file.assigned_broker_id) : null;
  const applicants = await all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', file.id);
  const me = applicants.find((a) => a.portal_user_id === user.id) || null;

  const visible = await visibleApplicantIds(user.id, file.id);
  const requests = await clientFileRequests(file.id, visible);

  const needed = requests.filter((r) => r.client_status.kind === 'action' && r.requirement === 'required');
  const optional = requests.filter((r) => r.client_status.kind === 'action' && r.requirement === 'optional');
  const inReview = requests.filter((r) => r.client_status.kind === 'waiting');
  const done = requests
    .filter((r) => r.status === 'approved')
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

  const unread = await get(
    "SELECT COUNT(*)::int AS n FROM messages WHERE file_id = ? AND sender_kind = 'staff' AND read_by_client_at IS NULL",
    file.id
  );

  const relevant = [
    ['phone', me && me.phone],
    ['date of birth', me && me.dob],
    ['current address', me && me.address],
    ['employment details', me && me.employment_type],
  ];
  const missing = relevant.filter(([, v]) => !v).map(([label]) => label);
  const completion = Math.round(((relevant.length - missing.length) / relevant.length) * 100);

  const consents = await all(
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
    // Other applicants' names are part of a shared application; their
    // documents are not.
    applicant_names: applicants.map((a) => fullName(a)),
    stage: stage
      ? { label: stage.client_label || stage.name, message: stage.client_message, step: stage.client_step, color: stage.color, is_terminal: !!stage.is_terminal }
      : null,
    steps,
    next_step: await clientNextStep(file, visible),
    needed,
    optional,
    in_review: inReview,
    recently_completed: done.slice(0, 5),
    unread_messages: unread ? unread.n : 0,
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
  router.get('/api/client/overview', requireClient, async (ctx) => {
    const ids = await clientFileIds(ctx.user.id);
    const files = [];
    for (const id of ids) {
      const f = await get('SELECT * FROM client_files WHERE id = ?', id);
      if (f) files.push(f);
    }
    files.sort((a, b) => (a.status === 'active' ? -1 : 1));
    const out = [];
    for (const f of files) out.push(await clientFileOverview(ctx.user, f));
    return { show_welcome: !ctx.user.welcomed_at, first_name: ctx.user.first_name, files: out };
  });

  router.get('/api/client/files/:fileId/documents', requireClient, async (ctx) => {
    const file = await clientFileOrThrow(ctx.user.id, ctx.params.fileId);
    const visible = await visibleApplicantIds(ctx.user.id, file.id);
    return {
      requests: await clientFileRequests(file.id, visible),
      progress: await checklistProgress(file.id),
    };
  });

  router.post('/api/client/requests/:id/upload', requireClient, async (ctx) => {
    const request = await clientRequestOrThrow(ctx.user.id, ctx.params.id);
    const file = await get('SELECT * FROM client_files WHERE id = ?', request.file_id);
    if (file.status !== 'active') {
      throw new ApiError(400, 'This application is no longer accepting uploads. Contact your broker if you need help.', 'file_closed');
    }
    const rule = ratelimit.rule('upload_user');
    await ratelimit.enforce(`upload:${ctx.user.id}`, rule.limit, rule.window, rule.message);

    let filename = '';
    try {
      filename = str(ctx.req.headers['x-filename'] ? decodeURIComponent(ctx.req.headers['x-filename']) : '', 300);
    } catch {
      filename = str(ctx.req.headers['x-filename'] || '', 300); // malformed encoding (audit finding L4)
    }

    const saved = await saveRequestBody(ctx.req, filename);
    const docType = await get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
    const { recordVersion, afterClientUpload } = require('./broker.routes');
    const versionId = await recordVersion(request, saved, filename, ctx.user);
    await audit(ctx.user.id, 'document_uploaded', 'document_version', versionId, ctx.ip);
    await afterClientUpload(file, request, docType.name, ctx.user);
    return { ok: true, request: await requestFull(request.id, { canDownload: true }) };
  }).raw();

  router.post('/api/client/requests/:id/comment', requireClient, async (ctx) => {
    const request = await clientRequestOrThrow(ctx.user.id, ctx.params.id);
    const comment = str(ctx.body && ctx.body.comment, 1000);
    if (!comment) throw new ApiError(400, 'Please write a short message first.', 'empty');
    await run('UPDATE document_requests SET client_comment = ?, updated_at = ? WHERE id = ?', comment, now(), request.id);
    const file = await get('SELECT * FROM client_files WHERE id = ?', request.file_id);
    const docType = await get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
    await activity(file.id, ctx.user, 'client_doc_response', `Client responded about ${docType.name}: "${comment.slice(0, 200)}"`);
    await notifyStaffForFile(file, 'client_doc_response', `Client response about ${docType.name}`, comment.slice(0, 200), `#/files/${file.id}/documents`);
    return { ok: true };
  });

  /**
   * Serve a document's bytes to a client. Three checks must all pass: the
   * version exists, this client may see its request (file AND applicant
   * level), and the malware scanner has cleared it.
   */
  router.get('/api/client/versions/:id/file', requireClient, async (ctx) => {
    const version = await get('SELECT * FROM document_versions WHERE id = ?', Number(ctx.params.id));
    if (!version) throw new ApiError(404, 'Not found.', 'not_found');
    const request = await get('SELECT * FROM document_requests WHERE id = ?', version.request_id);
    if (!(await canClientSeeRequest(ctx.user.id, request))) {
      throw new ApiError(404, 'Not found.', 'not_found');
    }
    if (!scan.isServable(version)) {
      throw new ApiError(409, 'This document is still being checked. Please try again shortly.', 'not_available');
    }

    const bytes = await readStored(version.stored_name, parseJsonSafe(version.enc_envelope, null));
    await audit(ctx.user.id, 'document_previewed', 'document_version', version.id, ctx.ip);
    ctx.res.writeHead(200, {
      'Content-Type': version.mime,
      'Content-Length': bytes.length,
      'Content-Disposition': `inline; filename="${String(version.original_name).replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // The application-wide DENY is correct for pages, but this response is
      // framed by our own preview modal. Framing is still restricted to this
      // origin, and the document itself is sandboxed.
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy':
        "default-src 'none'; object-src 'none'; script-src 'none'; " +
        "frame-ancestors 'self'; sandbox",
    });
    ctx.res.end(bytes);
    return HANDLED;
  });

  // ------------------------------ Messages ------------------------------
  router.get('/api/client/files/:fileId/messages', requireClient, async (ctx) => {
    const file = await clientFileOrThrow(ctx.user.id, ctx.params.fileId);
    const after = Number(ctx.query.after) || 0;
    const rows = await all(
      `SELECT m.*, u.first_name || ' ' || u.last_name AS sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.file_id = ? AND m.id > ? ORDER BY m.id LIMIT 200`,
      file.id, after
    );
    return { messages: rows.map(messageRow) };
  });

  router.post('/api/client/files/:fileId/messages', requireClient, async (ctx) => {
    const file = await clientFileOrThrow(ctx.user.id, ctx.params.fileId);
    const body = str(ctx.body && ctx.body.body, 4000);
    if (!body) throw new ApiError(400, 'The message was empty.', 'empty');
    const row = await get(
      `INSERT INTO messages (file_id, sender_id, sender_kind, body, created_at, read_by_client_at)
       VALUES (?, ?, 'client', ?, ?, ?) RETURNING id`,
      file.id, ctx.user.id, body, now(), now()
    );
    await touchFile(file.id);
    await audit(ctx.user.id, 'message_sent', 'client_file', file.id, ctx.ip);
    await notifyStaffForFile(
      file, 'new_message',
      `New message from ${ctx.user.first_name} ${ctx.user.last_name}`.trim(),
      body.slice(0, 120), `#/files/${file.id}/messages`
    );
    return { ok: true, id: row.id };
  });

  router.post('/api/client/files/:fileId/messages/read', requireClient, async (ctx) => {
    const file = await clientFileOrThrow(ctx.user.id, ctx.params.fileId);
    await run(
      "UPDATE messages SET read_by_client_at = ? WHERE file_id = ? AND sender_kind = 'staff' AND read_by_client_at IS NULL",
      now(), file.id
    );
    return { ok: true };
  });

  // ------------------------------ Notifications ------------------------------
  router.get('/api/client/notifications', requireClient, async (ctx) => ({
    notifications: await all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', ctx.user.id),
  }));

  router.post('/api/client/notifications/read', requireClient, async (ctx) => {
    const b = ctx.body || {};
    if (b.all) {
      await run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), ctx.user.id);
    } else if (Array.isArray(b.ids)) {
      for (const id of b.ids.slice(0, 100)) {
        await run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', now(), Number(id), ctx.user.id);
      }
    }
    return { ok: true };
  });

  // ------------------------------ Profile ------------------------------
  router.get('/api/client/profile', requireClient, async (ctx) => {
    const applicants = await all('SELECT * FROM applicants WHERE portal_user_id = ?', ctx.user.id);
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

  router.patch('/api/client/profile', requireClient, async (ctx) => {
    const b = ctx.body || {};
    const phone = str(b.phone, 40);
    const address = str(b.address, 400);
    const preferred = ['email', 'phone', 'text', 'portal'].includes(b.preferred_contact) ? b.preferred_contact : null;
    for (const applicant of await all('SELECT * FROM applicants WHERE portal_user_id = ?', ctx.user.id)) {
      await run(
        'UPDATE applicants SET phone = ?, address = ?, preferred_contact = ?, updated_at = ? WHERE id = ?',
        b.phone !== undefined ? phone : applicant.phone,
        b.address !== undefined ? address : applicant.address,
        preferred || applicant.preferred_contact,
        now(), applicant.id
      );
      await activity(applicant.file_id, ctx.user, 'client_profile_updated', `${ctx.user.first_name} updated their contact details`);
    }
    if (b.phone !== undefined) await run('UPDATE users SET phone = ?, updated_at = ? WHERE id = ?', phone, now(), ctx.user.id);
    await audit(ctx.user.id, 'profile_updated', 'user', ctx.user.id, ctx.ip);
    return { ok: true };
  });

  // ------------------------------ Consents ------------------------------
  router.get('/api/client/consents', requireClient, async (ctx) => {
    const ids = await clientFileIds(ctx.user.id);
    if (ids.length === 0) return { consents: [] };
    const myApplicants = (await all('SELECT id FROM applicants WHERE portal_user_id = ?', ctx.user.id)).map((r) => r.id);
    const rows = await all(
      'SELECT * FROM consents WHERE file_id = ANY(?::int[]) ORDER BY id DESC', ids
    );
    return { consents: rows.filter((c) => !c.applicant_id || myApplicants.includes(c.applicant_id)) };
  });

  router.post('/api/client/consents/:id/respond', requireClient, async (ctx) => {
    const consent = await get('SELECT * FROM consents WHERE id = ?', Number(ctx.params.id));
    const ids = await clientFileIds(ctx.user.id);
    if (!consent || !ids.includes(consent.file_id)) throw new ApiError(404, 'Not found.', 'not_found');
    if (consent.status !== 'requested') {
      throw new ApiError(400, 'This item has already been responded to.', 'already_done');
    }
    const accept = ctx.body && ctx.body.accept === true;
    await run(
      'UPDATE consents SET status = ?, responded_at = ?, responded_by = ? WHERE id = ?',
      accept ? 'completed' : 'declined', now(), ctx.user.id, consent.id
    );
    const file = await get('SELECT * FROM client_files WHERE id = ?', consent.file_id);
    await activity(file.id, ctx.user, accept ? 'consent_completed' : 'consent_declined', `${consent.form_title} (v${consent.form_version}) ${accept ? 'accepted' : 'declined'} by ${ctx.user.first_name} ${ctx.user.last_name}`);
    await audit(ctx.user.id, accept ? 'consent_completed' : 'consent_declined', 'consent', consent.id, ctx.ip, { form_version: consent.form_version });
    await notifyStaffForFile(file, 'consent_response', `${consent.form_title} ${accept ? 'completed' : 'declined'}`, '', `#/files/${file.id}`);
    return { ok: true };
  });
}

module.exports = { register };
