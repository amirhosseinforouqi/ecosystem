'use strict';

/**
 * Document storage (audit findings C1, H4, M6, M8).
 *
 * Every stored document is encrypted with AES-256-GCM under an envelope key
 * before it touches disk — a stolen volume or backup yields ciphertext only.
 * The envelope metadata travels in the database row, so key rotation is a
 * config change rather than a data migration.
 *
 * Two backends, chosen by STORAGE_BACKEND:
 *
 *   local (default) — a directory under DATA_DIR. Right for a long-running
 *                     server with a persistent volume.
 *   s3              — any S3-compatible object store (Supabase Storage, R2,
 *                     MinIO, S3). Required on serverless platforms, whose
 *                     filesystem is empty again on the next request.
 *
 * Either way the bytes are already ciphertext by the time they are written,
 * so the store never holds a readable client document. OneDrive holds the
 * brokerage's own copy separately. Files are never served statically and
 * never live under the web root.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getSetting } = require('./db');
const { ApiError } = require('./util');
const cryptoStore = require('./crypto-store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

function backend() {
  const explicit = (process.env.STORAGE_BACKEND || '').toLowerCase();
  if (explicit) return explicit;
  // Convenience: configuring a bucket is unambiguous intent.
  return process.env.S3_BUCKET ? 's3' : 'local';
}

function usingObjectStore() {
  return backend() === 's3';
}

if (!usingObjectStore()) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Refuse to run on an ephemeral filesystem with the local backend.
 *
 * On Vercel and similar platforms a document written to disk is gone by the
 * next request. Failing at boot is far better than discovering it when a
 * client's payslip cannot be found.
 */
function assertBackendUsable() {
  if (usingObjectStore()) {
    require('./objectstore').assertConfigured();
    return;
  }
  const serverless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.FUNCTIONS_WORKER_RUNTIME;
  if (serverless && process.env.ALLOW_EPHEMERAL_STORAGE !== '1') {
    throw new Error(
      'This platform has an ephemeral filesystem, so documents written locally would be lost. ' +
      'Set STORAGE_BACKEND=s3 with S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY ' +
      '(Supabase Storage, R2, MinIO or S3), or set ALLOW_EPHEMERAL_STORAGE=1 if you genuinely ' +
      'have a persistent volume mounted at DATA_DIR.'
    );
  }
}

/** Write the raw (already encrypted) bytes for a stored name. */
async function writeRaw(storedName, bytes) {
  if (usingObjectStore()) {
    await require('./objectstore').putObject(storedName, bytes);
    return;
  }
  await fsp.mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  await fsp.writeFile(storedPath(storedName), bytes, { flag: 'wx', mode: 0o600 });
}

/** Read the raw (still encrypted) bytes, or null when there is nothing there. */
async function readRaw(storedName) {
  if (usingObjectStore()) {
    return require('./objectstore').getObject(storedName);
  }
  try {
    return await fsp.readFile(storedPath(storedName));
  } catch {
    return null;
  }
}

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
  await writeRaw(storedName, ciphertext);

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
  const ciphertext = await readRaw(storedName);
  if (ciphertext === null) {
    throw new ApiError(404, 'That file is no longer available.', 'not_found');
  }
  if (!envelope) {
    // A row written before encryption was enabled; return as-is so historical
    // documents stay readable. `npm run encrypt:backfill` migrates these.
    return ciphertext;
  }
  try {
    return cryptoStore.decryptBuffer(ciphertext, envelope);
  } catch {
    throw new ApiError(500, 'That document could not be decrypted. Contact your administrator.', 'decrypt_failed');
  }
}

async function removeStored(storedName) {
  if (usingObjectStore()) {
    try { return await require('./objectstore').deleteObject(storedName); } catch { return false; }
  }
  try {
    await fsp.rm(storedPath(storedName), { force: true });
    return true;
  } catch {
    return false;
  }
}

async function storedExists(storedName) {
  if (usingObjectStore()) {
    try { return !!(await require('./objectstore').headObject(storedName)); } catch { return false; }
  }
  try {
    await fsp.access(storedPath(storedName));
    return true;
  } catch {
    return false;
  }
}

/** Every stored name the backend currently holds, for orphan reporting. */
async function listStored() {
  if (usingObjectStore()) {
    return (await require('./objectstore').listObjects()).map((o) => o.key);
  }
  try {
    return await fsp.readdir(UPLOAD_DIR);
  } catch {
    return [];
  }
}

/** Total bytes currently held, for quota checks. */
async function usageBytes() {
  if (usingObjectStore()) {
    try {
      return (await require('./objectstore').listObjects()).reduce((n, o) => n + o.size, 0);
    } catch {
      return 0;
    }
  }
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
  readRaw,
  writeRaw,
  listStored,
  backend,
  usingObjectStore,
  assertBackendUsable,
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
