'use strict';

const crypto = require('node:crypto');

/** Expected/handled errors carry a safe, user-friendly message. */
class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

function now() {
  return new Date().toISOString();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function str(value, max = 500) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max).trim();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(value) {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

/** 'YYYY-MM-DD' or null. */
function dateStr(value) {
  const s = str(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function requireFields(body, fields) {
  for (const f of fields) {
    const v = body ? body[f] : undefined;
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new ApiError(400, `Missing required field: ${f}`, 'missing_field');
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseJsonSafe(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function fullName(row) {
  if (!row) return '';
  const preferred = row.preferred_name ? ` "${row.preferred_name}"` : '';
  return `${row.first_name || ''}${preferred} ${row.last_name || ''}`.trim();
}

module.exports = {
  ApiError,
  now,
  today,
  addDays,
  randomToken,
  sha256,
  isEmail,
  normalizeEmail,
  phoneDigits,
  str,
  num,
  intOrNull,
  bool,
  dateStr,
  requireFields,
  escapeHtml,
  parseJsonSafe,
  fullName,
};
