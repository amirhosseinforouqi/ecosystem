'use strict';

/**
 * Exercises the hand-rolled SMTP client end-to-end against a real TCP/TLS
 * mock server that speaks the actual STARTTLS + AUTH LOGIN + DATA protocol
 * (not a stub) — so the wire format is genuinely verified, not assumed.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { sendMail } = require('../server/smtp');

// A throwaway self-signed cert, generated fresh for this test run via the
// system `openssl` CLI (no npm dependency). If openssl isn't available in
// this environment, the TLS-dependent tests skip rather than fail.
let CERT_DIR = null;
before(() => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-test-cert-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      '-days', '1', '-nodes', '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
    CERT_DIR = dir;
  } catch {
    CERT_DIR = null;
  }
});
after(() => {
  if (CERT_DIR) fs.rmSync(CERT_DIR, { recursive: true, force: true });
});
const hasCert = () => !!CERT_DIR;

/**
 * A minimal STARTTLS-capable SMTP server for testing. Tracks every socket
 * (plain and upgraded) so the test can force them all closed afterward —
 * otherwise a lingering half-open connection keeps the process alive.
 */
function startMockServer() {
  const cert = fs.readFileSync(path.join(CERT_DIR, 'cert.pem'));
  const key = fs.readFileSync(path.join(CERT_DIR, 'key.pem'));
  const received = { auths: [], mailFrom: null, rcptTo: null, dataLines: [] };
  const sockets = new Set();

  function handleConnection(socket) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));

    let buf = '';
    let inData = false;
    let authStep = 0; // 0=none, 1=awaiting user, 2=awaiting pass

    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 OK: queued\r\n');
          } else {
            received.dataLines.push(line);
          }
          continue;
        }

        if (authStep === 1) {
          received.auths.push(Buffer.from(line, 'base64').toString('utf8'));
          authStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (authStep === 2) {
          received.auths.push(Buffer.from(line, 'base64').toString('utf8'));
          authStep = 0;
          socket.write('235 Authentication successful\r\n');
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-mock.smtp.test\r\n250 STARTTLS\r\n');
        } else if (upper === 'STARTTLS') {
          socket.write('220 Ready to start TLS\r\n');
          const secureSocket = new tls.TLSSocket(socket, { isServer: true, cert, key });
          handleConnection(secureSocket);
          return; // this plain-socket listener is done; secureSocket takes over
        } else if (upper === 'AUTH LOGIN') {
          authStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          received.mailFrom = line.slice('MAIL FROM:'.length);
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          received.rcptTo = line.slice('RCPT TO:'.length);
          socket.write('250 OK\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 Start mail input\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('500 unrecognized command\r\n');
        }
      }
    });
  }

  const server = net.createServer((socket) => {
    socket.write('220 mock.smtp.test ESMTP\r\n'); // greeting — only for genuinely new connections
    handleConnection(socket);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      received,
      async stop() {
        for (const s of sockets) s.destroy();
        await new Promise((r) => server.close(r));
      },
    }));
  });
}

test('SMTP client — full STARTTLS + AUTH LOGIN + DATA conversation', async (t) => {
  if (!hasCert()) return t.skip('openssl not available to generate a test cert');
  const { port, received, stop } = await startMockServer();
  try {
    await sendMail({
      host: '127.0.0.1',
      port,
      secure: false,
      rejectUnauthorized: false, // test cert is self-signed
      user: 'broker@example.com',
      pass: 'app-password-123',
      from: 'broker@example.com',
      fromName: 'Jane Broker',
      to: 'client@example.com',
      toName: 'John Smith',
      subject: 'Please upload your pay stub — café ☕',
      text: 'Hi John,\n\nWe still need your most recent pay stub.\n\nThanks!',
    });

    assert.deepStrictEqual(received.auths, ['broker@example.com', 'app-password-123'], 'credentials sent via AUTH LOGIN, base64-decoded correctly');
    assert.strictEqual(received.mailFrom, '<broker@example.com>');
    assert.strictEqual(received.rcptTo, '<client@example.com>');

    const raw = received.dataLines.join('\r\n');
    assert.match(raw, /^From: .*Jane Broker.*<broker@example\.com>/m, 'From header present with display name');
    assert.match(raw, /^To: .*John Smith.*<client@example\.com>/m);
    assert.match(raw, /^Subject: =\?UTF-8\?B\?/m, 'non-ASCII subject was RFC 2047 encoded');
    assert.match(raw, /^Content-Transfer-Encoding: base64/m);

    // Decode the base64 body back out and confirm round-trip fidelity,
    // including the UTF-8 character in the subject.
    const bodyStart = raw.indexOf('\r\n\r\n') + 4;
    const bodyB64 = raw.slice(bodyStart).replace(/\r\n/g, '');
    const decodedBody = Buffer.from(bodyB64, 'base64').toString('utf8');
    assert.strictEqual(decodedBody, 'Hi John,\n\nWe still need your most recent pay stub.\n\nThanks!');

    const subjectMatch = raw.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=/m);
    const decodedSubject = Buffer.from(subjectMatch[1], 'base64').toString('utf8');
    assert.strictEqual(decodedSubject, 'Please upload your pay stub — café ☕');
  } finally {
    await stop();
  }
});

test('SMTP client — surfaces a clean error on bad auth', async (t) => {
  if (!hasCert()) return t.skip('openssl not available to generate a test cert');
  const cert = fs.readFileSync(path.join(CERT_DIR, 'cert.pem'));
  const key = fs.readFileSync(path.join(CERT_DIR, 'key.pem'));
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 mock.smtp.test ESMTP\r\n');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) socket.write('250-mock\r\n250 STARTTLS\r\n');
        else if (upper === 'STARTTLS') {
          socket.write('220 Ready to start TLS\r\n');
          const secure = new tls.TLSSocket(socket, { isServer: true, cert, key });
          sockets.add(secure);
          secure.on('close', () => sockets.delete(secure));
          let sbuf = '';
          secure.on('data', (c2) => {
            sbuf += c2.toString('latin1');
            let i2;
            while ((i2 = sbuf.indexOf('\r\n')) !== -1) {
              const l2 = sbuf.slice(0, i2);
              sbuf = sbuf.slice(i2 + 2);
              const u2 = l2.toUpperCase();
              if (u2.startsWith('EHLO')) secure.write('250 mock\r\n');
              else if (u2 === 'AUTH LOGIN') secure.write('334 VXNlcm5hbWU6\r\n');
              else secure.write('535 Authentication failed\r\n');
            }
          });
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    await assert.rejects(
      () => sendMail({
        host: '127.0.0.1', port, secure: false, rejectUnauthorized: false,
        user: 'x', pass: 'y', from: 'a@example.com', to: 'b@example.com', subject: 'x', text: 'x',
      }),
      /Mail server said: 535/
    );
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});
