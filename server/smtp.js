'use strict';

/**
 * Minimal zero-dependency SMTP client (RFC 5321/2047) — enough to send a
 * plain-text email through a real mailbox (Gmail, Microsoft 365/Outlook, or
 * any other SMTP-AUTH provider) using an app password. Built only on
 * node:net / node:tls so the project keeps zero npm dependencies.
 *
 * Not a general-purpose mail library: one recipient, text/plain body,
 * AUTH LOGIN only. That covers every transactional email this platform
 * sends (welcome, reminders, stage updates...).
 */

const net = require('node:net');
const tls = require('node:tls');

const TIMEOUT_MS = 15000;

function toBase64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/** RFC 2047 "encoded word" — only applied when the string isn't plain ASCII. */
/**
 * Reject anything that could break out of an SMTP command or a header line.
 *
 * Addresses reaching here have already been validated upstream, but header and
 * command injection is a whole class of bug worth closing at the boundary
 * rather than trusting every caller forever.
 */
function assertAddress(value, what) {
  const address = String(value || '').trim();
  if (!/^[^\s<>",;:\\]+@[^\s<>",;:\\]+\.[^\s<>",;:\\]+$/.test(address) || address.length > 254) {
    throw new Error(`The ${what} address is not a valid email address.`);
  }
  return address;
}

function encodeHeaderValue(str) {
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  return `=?UTF-8?B?${toBase64(str)}?=`;
}

/** Reads one SMTP response (possibly multi-line) at a time off a socket. */
function makeReader(socket) {
  let buf = '';
  let pending = null;

  const fail = (err) => {
    if (pending) {
      const { reject } = pending;
      pending = null;
      reject(err);
    }
  };

  const tryResolve = () => {
    if (!pending) return;
    const lines = [];
    let rest = buf;
    let consumed = 0;
    for (;;) {
      const i = rest.indexOf('\r\n');
      if (i === -1) return; // wait for more data
      const line = rest.slice(0, i);
      lines.push(line);
      rest = rest.slice(i + 2);
      consumed += i + 2;
      if (line.length >= 4 && line[3] === ' ') {
        buf = buf.slice(consumed);
        const code = parseInt(line.slice(0, 3), 10);
        const { resolve } = pending;
        pending = null;
        resolve({ code, text: lines.map((l) => l.slice(4)).join('\n') });
        return;
      }
      // else: "code-text" continuation line — keep reading this block
    }
  };

  socket.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    tryResolve();
  });
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('The mail server closed the connection unexpectedly.')));

  return {
    read() {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        tryResolve();
      });
    },
    rebind(newSocket) {
      socket = newSocket;
      buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        tryResolve();
      });
      socket.on('error', fail);
      socket.on('close', () => fail(new Error('The mail server closed the connection unexpectedly.')));
    },
  };
}

function writeLine(socket, line) {
  socket.write(line + '\r\n');
}

function connectPlain(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

// SNI's servername must be a hostname, not an IP literal (RFC 6066) — omit
// it when connecting straight to an IP (e.g. a self-hosted relay).
function sniName(host) {
  return net.isIP(host) ? undefined : host;
}

function upgradeToTls(socket, host, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, host, servername: sniName(host), rejectUnauthorized });
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

function connectTls(host, port, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: sniName(host), rejectUnauthorized });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * Send one plain-text email.
 * @param {object} opts
 * @param {string} opts.host - SMTP server, e.g. smtp.gmail.com
 * @param {number} [opts.port=587]
 * @param {boolean} [opts.secure] - true = implicit TLS (typically port 465).
 *   Defaults to true when port is 465, otherwise STARTTLS is used.
 * @param {string} opts.user - SMTP username (usually your email address)
 * @param {string} opts.pass - SMTP password / app password
 * @param {string} opts.from - envelope + header From address
 * @param {string} [opts.fromName]
 * @param {string} opts.to
 * @param {string} [opts.toName]
 * @param {string} opts.subject
 * @param {string} opts.text
 */
async function sendMail(opts) {
  const from = assertAddress(opts.from, 'sender');
  const to = assertAddress(opts.to, 'recipient');
  const port = opts.port || 587;
  const useImplicitTls = opts.secure ?? port === 465;
  // Real usage always verifies the server certificate; only tests (against
  // an in-process throwaway cert) ever pass this as false.
  const rejectUnauthorized = opts.rejectUnauthorized !== false;
  let socket;

  try {
    socket = useImplicitTls
      ? await connectTls(opts.host, port, rejectUnauthorized)
      : await connectPlain(opts.host, port);
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('Connecting to the mail server timed out.')));

    const reader = makeReader(socket);
    const expect = async (...okCodes) => {
      const res = await reader.read();
      if (!okCodes.includes(res.code)) {
        throw new Error(`Mail server said: ${res.code} ${res.text}`);
      }
      return res;
    };
    const ehlo = async () => {
      writeLine(socket, 'EHLO localhost');
      await expect(250);
    };

    await expect(220); // greeting
    await ehlo();

    if (!useImplicitTls) {
      writeLine(socket, 'STARTTLS');
      await expect(220);
      socket = await upgradeToTls(socket, opts.host, rejectUnauthorized);
      socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('Connecting to the mail server timed out.')));
      reader.rebind(socket);
      await ehlo();
    }

    writeLine(socket, 'AUTH LOGIN');
    await expect(334);
    writeLine(socket, toBase64(opts.user));
    await expect(334);
    writeLine(socket, toBase64(opts.pass));
    await expect(235);

    writeLine(socket, `MAIL FROM:<${from}>`);
    await expect(250);
    writeLine(socket, `RCPT TO:<${to}>`);
    await expect(250, 251);
    writeLine(socket, 'DATA');
    await expect(354);

    const headers = [
      `From: ${opts.fromName ? `${encodeHeaderValue(opts.fromName)} <${from}>` : from}`,
      `To: ${opts.toName ? `${encodeHeaderValue(opts.toName)} <${to}>` : to}`,
      `Subject: ${encodeHeaderValue(opts.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      `Date: ${new Date().toUTCString()}`,
      '',
      '',
    ].join('\r\n');

    // Base64 body sidesteps SMTP dot-stuffing entirely (its alphabet never
    // contains ".") and handles any Unicode content safely.
    const bodyB64 = Buffer.from(opts.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    socket.write(headers + bodyB64 + '\r\n.\r\n');
    await expect(250);

    writeLine(socket, 'QUIT');
    await expect(221).catch(() => {});
    socket.end();
  } catch (err) {
    if (socket) socket.destroy();
    throw err;
  }
}

module.exports = { sendMail };
