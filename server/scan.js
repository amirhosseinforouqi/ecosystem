'use strict';

/**
 * Malware scanning for uploaded documents (audit finding H4).
 *
 * Brokers download and open whatever clients upload, so the platform is a
 * delivery path into the brokerage unless uploads are scanned. Scanning runs
 * on the background pass; until a document is marked clean it can be listed
 * but its bytes are not served.
 *
 * Two backends:
 *   clamd  — ClamAV daemon over TCP (free, self-hosted, the default choice)
 *   none   — no scanning; refuses to start in production unless the operator
 *            explicitly accepts the risk via MALWARE_SCAN_MODE=disabled
 *
 * The INSTREAM protocol is implemented directly on a socket so no npm
 * dependency is needed.
 */

const net = require('node:net');

const CHUNK = 64 * 1024;

function mode() {
  return (process.env.MALWARE_SCAN_MODE || 'clamd').toLowerCase();
}

function isEnabled() {
  return mode() === 'clamd';
}

/**
 * Production must not silently run without scanning. Called at boot.
 */
function assertConfiguredForProduction() {
  if (process.env.NODE_ENV !== 'production') return;
  if (mode() === 'disabled') return; // explicit, documented acceptance
  if (mode() !== 'clamd') {
    throw new Error(
      `MALWARE_SCAN_MODE="${mode()}" is not valid. Set it to "clamd" with CLAMAV_HOST/CLAMAV_PORT, ` +
      'or to "disabled" to explicitly accept running without upload scanning.'
    );
  }
  if (!process.env.CLAMAV_HOST) {
    throw new Error('MALWARE_SCAN_MODE=clamd requires CLAMAV_HOST (and optionally CLAMAV_PORT).');
  }
}

/**
 * Scan a buffer.
 * @returns {{status:'clean'|'infected'|'skipped'|'error', signature?:string, detail?:string}}
 */
async function scanBuffer(buffer) {
  if (!isEnabled()) return { status: 'skipped', detail: `scanning ${mode()}` };
  const host = process.env.CLAMAV_HOST || '127.0.0.1';
  const port = Number(process.env.CLAMAV_PORT) || 3310;
  const timeoutMs = Number(process.env.CLAMAV_TIMEOUT_MS) || 30000;

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let response = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish({ status: 'error', detail: 'scanner timed out' }));
    socket.on('error', (err) => finish({ status: 'error', detail: err.message }));

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < buffer.length; offset += CHUNK) {
        const slice = buffer.subarray(offset, Math.min(offset + CHUNK, buffer.length));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(slice.length);
        socket.write(header);
        socket.write(slice);
      }
      const terminator = Buffer.alloc(4); // zero-length chunk ends the stream
      socket.write(terminator);
    });

    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });

    socket.on('end', () => {
      const text = response.replace(/\0/g, '').trim();
      if (/\bOK$/.test(text)) return finish({ status: 'clean' });
      const found = text.match(/stream:\s*(.+)\s+FOUND/i);
      if (found) return finish({ status: 'infected', signature: found[1].trim() });
      finish({ status: 'error', detail: text || 'unrecognized scanner response' });
    });
  });
}

/** True when a version's scan state permits serving its bytes. */
function isServable(version) {
  if (!version) return false;
  if (version.scan_status === 'infected') return false;
  // 'pending' is allowed only when scanning is switched off entirely;
  // otherwise the bytes stay withheld until the scan completes.
  if (version.scan_status === 'pending' && isEnabled()) return false;
  return true;
}

module.exports = { isEnabled, mode, assertConfiguredForProduction, scanBuffer, isServable };
