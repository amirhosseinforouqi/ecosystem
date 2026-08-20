'use strict';

/**
 * Document storage (audit findings C1, H4, M6, M8).
 *
 * Every stored document is encrypted with AES-256-GCM under an envelope key
 * before it touches disk — a stolen volume or backup yields ciphertext only.
 * The envelope metadata travels in the database row, so key rotation is a
 * config change rather than a data migration.
 *
 * The local driver keeps the working copy the app serves for preview and AI
 * review; OneDrive holds the brokerage's own copy. Files are never served
 * statically and never live under the web root.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { getSetting } = require('./db');
const { ApiError } = require('./util');
const cryptoStore = require('./crypto-store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
};

function extOf(filename) {
  return path.extname(String(filename || '')).slice(1).toLowerCase();
}

async function uploadLimits() {
  const cfg = await getSetting('uploads', {});
  return {
    maxBytes: (cfg.max_mb || 25) * 1024 * 1024,
    allowedExt: cfg.allowed_ext || Object.keys(MIME_BY_EXT),
  };
}

async function assertAllowedFilename(filename) {
  const ext = extOf(filename);
  const { allowedExt } = await uploadLimits();
  if (!ext || !allowedExt.includes(ext)) {
    throw new ApiError(
      400,
      `That file type isn't supported. Please upload one of: ${allowedExt.map((e) => e.toUpperCase()).join(', ')}.`,
      'bad_file_type'
    );
  }
  return ext;
}

/**
 * Magic-byte validation. This stops a renamed executable; it is explicitly
 * NOT malware detection — that is `scan.js`, which runs before a document is
 * made available for download.
 */
function sniffLooksValid(buffer, ext) {
  if (buffer.length < 12) return false;
  const head = buffer.subarray(0, 12);
  switch (ext) {
    case 'pdf':
      return head.subarray(0, 4).toString('latin1') === '%PDF';
    case 'png':
      return head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG';
    case 'jpg':
    case 'jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'webp':
      return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'heic':
    case 'heif': {
      // Check the brand, not just the container marker — 'ftyp' alone also
      // matches every MP4/MOV (audit finding L3).
      if (buffer.subarray(4, 8).toString('latin1') !== 'ftyp') return false;
      const brand = buffer.subarray(8, 12).toString('latin1');
      return ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif'].includes(brand);
    }
    default:
      return false;
  }
}

function storedPath(storedName) {
  // Stored names are generated server-side; still guard against traversal.
  const safe = path.basename(String(storedName || ''));
  return path.join(UPLOAD_DIR, safe);
}

/**
 * Read the request body, enforce the size cap, validate the content, then
 * encrypt and persist it.
 *
 * The body is buffered with an explicit cap (well below available memory) so
 * that backpressure is inherently respected — the previous streaming write
 * ignored `write()` backpressure and could balloon memory under concurrent
 * uploads (audit finding M8).
 */
async function saveRequestBody(req, filename) {
  cryptoStore.assertConfigured();
  const ext = await assertAllowedFilename(filename);
  const { maxBytes } = await uploadLimits();

  const plaintext = await readCapped(req, maxBytes);
  if (plaintext.length === 0) {
    throw new ApiError(400, 'The uploaded file was empty. Please try again.', 'empty_file');
  }
  if (!sniffLooksValid(plaintext, ext)) {
    throw new ApiError(
      400,
      "That file doesn't look like a valid document of that type. Please check the file and try again.",
      'bad_file_content'
    );
  }

  const { ciphertext, envelope } = cryptoStore.encryptBuffer(plaintext);
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${ext}.enc`;
  await fsp.writeFile(storedPath(storedName), ciphertext, { flag: 'wx', mode: 0o600 });

  return {
    storedName,
    size: plaintext.length,
    mime: MIME_BY_EXT[ext] || 'application/octet-stream',
    ext,
    envelope,
    plaintext, // caller may scan it; never persisted in this form
  };
}

function readCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err, { destroy = true } = {}) => {
      if (settled) return;
      settled = true;
      if (destroy) req.destroy();
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading, but leave the socket alive long enough to answer.
        // Destroying it here would leave the client with a network error
        // instead of being told, plainly, that the file is too big.
        req.pause();
        const err = new ApiError(
          413,
          `That file is too large. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
          'too_large'
        );
        err.closeConnection = true;
        return fail(err, { destroy: false });
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new ApiError(400, 'The upload was interrupted. Please try again.', 'aborted')));
  });
}

/** Decrypt and return a stored document's bytes. */
async function readStored(storedName, envelope) {
  const p = storedPath(storedName);
  let ciphertext;
  try {
    ciphertext = await fsp.readFile(p);
  } catch {
    throw new ApiError(404, 'That file is no longer available.', 'not_found');
  }
  if (!envelope) {
    // A row written before encryption was enabled; return as-is so historical
    // documents stay readable. `npm run encrypt:backfill` migrates these.
    return ciphertext;
  }
  try {
    return cryptoStore.decryptBuffer(ciphertext, envelope);
  } catch (err) {
    throw new ApiError(500, 'That document could not be decrypted. Contact your administrator.', 'decrypt_failed');
  }
}

async function removeStored(storedName) {
  try {
    await fsp.rm(storedPath(storedName), { force: true });
    return true;
  } catch {
    return false;
  }
}

async function storedExists(storedName) {
  try {
    await fsp.access(storedPath(storedName));
    return true;
  } catch {
    return false;
  }
}

/** Total bytes currently held on the local volume, for quota checks. */
async function usageBytes() {
  let total = 0;
  try {
    for (const name of await fsp.readdir(UPLOAD_DIR)) {
      const st = await fsp.stat(path.join(UPLOAD_DIR, name)).catch(() => null);
      if (st && st.isFile()) total += st.size;
    }
  } catch { /* directory missing */ }
  return total;
}

module.exports = {
  saveRequestBody,
  readStored,
  removeStored,
  storedExists,
  storedPath,
  usageBytes,
  uploadLimits,
  extOf,
  sniffLooksValid,
  MIME_BY_EXT,
  UPLOAD_DIR,
  DATA_DIR,
};
