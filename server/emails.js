'use strict';

const { run, get, getSetting } = require('./db');
const { now } = require('./util');
const smtp = require('./smtp');

/**
 * Email delivery is an outbox: every email is rendered from a template and
 * recorded in email_log first (the portal is the source of truth; email is a
 * notification layer). Delivery happens through a pluggable transport so a
 * real provider can be wired in without touching any calling code.
 */

const transports = {
  /** Default transport: marks the email as sent and logs it locally. */
  log: async (email) => {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[email] to=${email.to_email} subject="${email.subject}"`);
    }
    return { ok: true };
  },
  /** No-op transport: emails stay recorded but are never delivered. */
  disabled: async () => ({ ok: true, skipped: true }),
  /**
   * Sends through a real mailbox via SMTP (Gmail, Outlook/Microsoft 365, or
   * any SMTP-AUTH provider). Configured entirely by environment variables —
   * see README "Connect a real email account".
   */
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
};

function activeTransport() {
  const name = process.env.EMAIL_TRANSPORT || 'log';
  return transports[name] || transports.log;
}

function renderTemplate(text, vars) {
  return String(text || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function baseVars(extra = {}) {
  const brokerage = getSetting('brokerage', {});
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
 * vars can include: client_first_name, client_last_name, application_stage,
 * document_name, closing_date, portal_link, ...
 */
async function sendTemplate(templateKey, { toEmail, toName, userId, fileId, vars = {} }) {
  const template = get('SELECT * FROM email_templates WHERE key = ?', templateKey);
  if (!template) return null;
  const merged = baseVars(vars);
  const subject = renderTemplate(template.subject, merged);
  const body = renderTemplate(template.body, merged);
  const res = run(
    `INSERT INTO email_log (to_email, to_name, user_id, file_id, template_key, subject, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    toEmail, toName || '', userId ?? null, fileId ?? null, templateKey, subject, body, now()
  );
  const id = Number(res.lastInsertRowid);

  if (!template.active) {
    run("UPDATE email_log SET status = 'disabled' WHERE id = ?", id);
    return id;
  }
  try {
    await activeTransport()({ to_email: toEmail, to_name: toName, subject, body });
    run("UPDATE email_log SET status = 'sent', sent_at = ? WHERE id = ?", now(), id);
  } catch (err) {
    run("UPDATE email_log SET status = 'failed', error = ? WHERE id = ?", String(err.message || err).slice(0, 500), id);
  }
  return id;
}

/** Render a template with sample data for previewing in settings. */
function previewTemplate(subject, body) {
  const sample = baseVars({
    client_first_name: 'John',
    client_last_name: 'Smith',
    application_stage: 'Documents Requested',
    document_name: 'Recent Pay Stub',
    closing_date: '2026-10-15',
  });
  return {
    subject: renderTemplate(subject, sample),
    body: renderTemplate(body, sample),
  };
}

module.exports = { sendTemplate, previewTemplate, renderTemplate, portalBaseUrl };
