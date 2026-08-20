'use strict';

const { run, get, getSetting } = require('./db');
const { now } = require('./util');
const smtp = require('./smtp');

/**
 * Email delivery is an outbox: every email is rendered from a template and
 * recorded in email_log first (the portal is the source of truth; email is a
 * notification layer). Delivery happens through a pluggable transport.
 */

const transports = {
  log: async (email) => {
    if (process.env.NODE_ENV !== 'test') {
      // Recipient addresses are PII — log the template and the log-row id,
      // never the address itself (audit finding M9).
      console.log(`[email] template=${email.template_key || 'n/a'} log_id=${email.log_id}`);
    }
    return { ok: true };
  },
  disabled: async () => ({ ok: true, skipped: true }),
  smtp: async (email) => {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
      throw new Error('SMTP is not fully configured — set SMTP_HOST, SMTP_USER and SMTP_PASS.');
    }
    await smtp.sendMail({
      host,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true' ? true : process.env.SMTP_SECURE === 'false' ? false : undefined,
      user,
      pass,
      from: process.env.SMTP_FROM || user,
      fromName: process.env.SMTP_FROM_NAME || undefined,
      to: email.to_email,
      toName: email.to_name,
      subject: email.subject,
      text: email.body,
    });
    return { ok: true };
  },
  /**
   * Microsoft 365 / Outlook via Microsoft Graph, using OAuth client
   * credentials — the mailbox password is never entered into or stored by
   * this application.
   */
  graph: async (email) => {
    const msgraph = require('./msgraph');
    if (!msgraph.isConfigured()) {
      throw new Error('Microsoft 365 is not configured — set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_MAILBOX.');
    }
    await msgraph.sendMailViaGraph({
      toEmail: email.to_email,
      toName: email.to_name,
      subject: email.subject,
      text: email.body,
    });
    return { ok: true };
  },
};

function transportName() {
  return process.env.EMAIL_TRANSPORT || 'log';
}

function activeTransport() {
  return transports[transportName()] || transports.log;
}

function renderTemplate(text, vars) {
  return String(text || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

async function baseVars(extra = {}) {
  const brokerage = await getSetting('brokerage', {});
  return {
    brokerage_name: brokerage.name || 'Your Brokerage',
    broker_name: brokerage.broker_name || 'Your Broker',
    portal_link: portalBaseUrl() + '/portal',
    ...extra,
  };
}

function portalBaseUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

/**
 * Render a template and queue+send it. Returns the email_log row id.
 *
 * `redact` lists secret values (e.g. a temporary password): they are sent in
 * the real email but replaced with a mask in the stored copy, so secrets are
 * never persisted in plaintext.
 */
async function sendTemplate(templateKey, { toEmail, toName, userId, fileId, vars = {}, redact = [] }) {
  const template = await get('SELECT * FROM email_templates WHERE key = ?', templateKey);
  if (!template) return null;
  const merged = await baseVars(vars);
  const subject = renderTemplate(template.subject, merged);
  const body = renderTemplate(template.body, merged);

  let storedSubject = subject;
  let storedBody = body;
  for (const secret of redact) {
    if (!secret) continue;
    storedSubject = storedSubject.split(secret).join('••••••••');
    storedBody = storedBody.split(secret).join('••••••••');
  }

  const row = await get(
    `INSERT INTO email_log (to_email, to_name, user_id, file_id, template_key, subject, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING id`,
    toEmail, toName || '', userId ?? null, fileId ?? null, templateKey, storedSubject, storedBody, now()
  );
  const id = row.id;

  if (!template.active) {
    await run("UPDATE email_log SET status = 'disabled' WHERE id = ?", id);
    return id;
  }
  try {
    await activeTransport()({
      to_email: toEmail, to_name: toName, subject, body,
      template_key: templateKey, log_id: id,
    });
    await run("UPDATE email_log SET status = 'sent', sent_at = ? WHERE id = ?", now(), id);
  } catch (err) {
    await run(
      "UPDATE email_log SET status = 'failed', error = ? WHERE id = ?",
      String(err.message || err).slice(0, 500), id
    );
  }
  return id;
}

/** Render a template with sample data for previewing in settings. */
async function previewTemplate(subject, body) {
  const sample = await baseVars({
    client_first_name: 'John',
    client_last_name: 'Smith',
    application_stage: 'Documents Requested',
    document_name: 'Recent Pay Stub',
    closing_date: '2026-10-15',
    username: 'john.smith@example.com',
    temporary_password: 'Xk4m-Qw9t-Bw2p',
    application_number: 'MTG-2026-00128',
    service_type: 'Purchase',
    document_list: '- Most recent pay stub\n- Employment letter\n- 2025 Notice of Assessment',
    notification_title: 'John Smith uploaded a new T4',
    notification_body: 'File MTG-2026-00128',
  });
  return {
    subject: renderTemplate(subject, sample),
    body: renderTemplate(body, sample),
  };
}

module.exports = { sendTemplate, previewTemplate, renderTemplate, portalBaseUrl, transportName };
