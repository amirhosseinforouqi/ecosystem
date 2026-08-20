'use strict';

/**
 * Error reporting (audit finding M14).
 *
 * Sends exceptions to Sentry's store endpoint over plain HTTPS — no SDK, so
 * the project keeps a minimal dependency surface and the payload is fully
 * under our control. That control matters here: this application handles
 * government IDs and banking records, so the reporter scrubs values before
 * anything leaves the process rather than trusting a library's defaults.
 *
 * Inert unless SENTRY_DSN is set.
 */

const os = require('node:os');

let dsn = null;
let parsed = null;

function init() {
  dsn = process.env.SENTRY_DSN || null;
  parsed = dsn ? parseDsn(dsn) : null;
  return !!parsed;
}

function parseDsn(value) {
  try {
    const url = new URL(value);
    const projectId = url.pathname.replace(/^\//, '');
    return {
      key: url.username,
      host: url.host,
      projectId,
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/store/`,
    };
  } catch {
    console.error('[sentry] SENTRY_DSN is not a valid DSN; error reporting is disabled.');
    return null;
  }
}

function isEnabled() {
  if (parsed === null && dsn === null) init();
  return !!parsed;
}

/**
 * Redact anything that could carry personal or secret data. Applied to every
 * string in the payload, recursively.
 */
const SECRET_KEY_RE = /(password|secret|token|authorization|cookie|api[-_]?key|dsn|connection|dob|sin|account)/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const LONG_DIGITS_RE = /\b\d{7,}\b/g;
// A phone number written the way a person writes one, which LONG_DIGITS_RE
// misses because of the separators.
const PHONE_RE = /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
// NAME=value, where NAME names a secret. Error messages routinely quote the
// environment variable that was wrong, along with its value.
const ASSIGNED_SECRET_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY|KEYS|DSN|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi;
// Provider key formats worth catching wherever they appear.
const KNOWN_SECRET_RE = /\b(sk-ant-[\w-]{8,}|sk-[A-Za-z0-9]{16,}|xox[baprs]-[\w-]{8,}|AKIA[0-9A-Z]{12,})\b/g;
// A connection string carrying inline credentials.
const CONNECTION_RE = /\b([a-z][a-z0-9+.-]*):\/\/[^\s:@/]+:[^\s@/]+@/gi;

function scrubString(value) {
  return String(value)
    .replace(ASSIGNED_SECRET_RE, '$1=[redacted]')
    .replace(KNOWN_SECRET_RE, '[redacted]')
    .replace(CONNECTION_RE, '$1://[redacted]@')
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, '[phone]')
    .replace(LONG_DIGITS_RE, '[number]')
    .slice(0, 2000);
}

function scrub(value, keyHint = '') {
  if (value === null || value === undefined) return value;
  if (SECRET_KEY_RE.test(keyHint)) return '[redacted]';
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = scrub(v, k);
    return out;
  }
  return undefined;
}

/**
 * Report an exception. Never throws and never blocks the caller — a failure
 * in the reporter must not become a failure in the request.
 */
function captureException(err, context = {}) {
  if (!isEnabled()) return;
  const payload = {
    event_id: require('node:crypto').randomBytes(16).toString('hex'),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    logger: 'mortgage-platform',
    server_name: process.env.SENTRY_SERVER_NAME || os.hostname(),
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    exception: {
      values: [{
        type: err && err.name ? err.name : 'Error',
        value: scrubString(err && err.message ? err.message : String(err)),
        stacktrace: { frames: framesFrom(err) },
      }],
    },
    tags: scrub(context.tags || {}),
    extra: scrub({ ...context, tags: undefined }),
  };

  fetch(parsed.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': [
        'Sentry sentry_version=7',
        'sentry_client=mortgage-platform/1.0',
        `sentry_key=${parsed.key}`,
      ].join(', '),
    },
    body: JSON.stringify(payload),
  }).catch(() => { /* reporting must never break the request */ });
}

function framesFrom(err) {
  const stack = (err && err.stack) || '';
  return stack
    .split('\n')
    .slice(1, 25)
    .map((line) => {
      const m = line.match(/at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)/) || line.match(/at\s+(.*?):(\d+):(\d+)/);
      if (!m) return null;
      const isPathOnly = m.length === 4;
      return {
        function: isPathOnly ? '<anonymous>' : m[1],
        filename: isPathOnly ? m[1] : m[2],
        lineno: Number(isPathOnly ? m[2] : m[3]),
        colno: Number(isPathOnly ? m[3] : m[4]),
        in_app: !/node_modules|node:internal/.test(line),
      };
    })
    .filter(Boolean)
    .reverse();
}

module.exports = { init, isEnabled, captureException, scrub };
