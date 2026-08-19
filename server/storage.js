'use strict';

/**
 * Document storage abstraction. Files live outside the web root, are never
 * served statically, and are streamed only through authenticated,
 * authorization-checked endpoints. The local driver can be replaced by a
 * cloud provider (S3, Google Drive, OneDrive/SharePoint...) by implementing
 * save/open/remove with the same signatures.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR, getSetting } = require('./db');
const { ApiError } = require('./util');

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

function uploadLimits() {
  const cfg = getSetting('uploads', {});
  return {
    maxBytes: (cfg.max_mb || 25) * 1024 * 1024,
    allowedExt: cfg.allowed_ext || Object.keys(MIME_BY_EXT),
  };
}

function assertAllowedFilename(filename) {
  const ext = extOf(filename);
  const { allowedExt } = uploadLimits();
  if (!ext || !allowedExt.includes(ext)) {
    throw new ApiError(
      400,
      `That file type isn't supported. Please upload one of: ${allowedExt.map((e) => e.toUpperCase()).join(', ')}.`,
      'bad_file_type'
    );
  }
  return ext;
}

/** Light magic-byte validation so a renamed executable can't slip through. */
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
      const ftyp = buffer.subarray(4, 8).toString('latin1');
      return ftyp === 'ftyp';
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
 * Read the request body into a stored file with a size cap.
 * Resolves { storedName, size, mime, ext }.
 */
function saveRequestBody(req, filename) {
  const ext = assertAllowedFilename(filename);
  const { maxBytes } = uploadLimits();
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  const filePath = storedPath(storedName);

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath, { flags: 'wx' });
    let size = 0;
    let firstChunk = null;
    let failed = false;

    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(filePath, { force: true }, () => {});
      reject(err);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        return fail(new ApiError(413, `That file is too large. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`, 'too_large'));
      }
      if (!firstChunk) firstChunk = chunk;
      out.write(chunk);
    });
    req.on('end', () => {
      out.end(() => {
        if (failed) return;
        if (size === 0) return fail(new ApiError(400, 'The uploaded file was empty. Please try again.', 'empty_file'));
        if (!firstChunk || !sniffLooksValid(firstChunk, ext)) {
          return fail(new ApiError(400, "That file doesn't look like a valid document of that type. Please check the file and try again.", 'bad_file_content'));
        }
        resolve({ storedName, size, mime: MIME_BY_EXT[ext] || 'application/octet-stream', ext });
      });
    });
    req.on('error', fail);
    out.on('error', fail);
  });
}

function openStored(storedName) {
  const p = storedPath(storedName);
  if (!fs.existsSync(p)) throw new ApiError(404, 'File not found.', 'not_found');
  return { stream: fs.createReadStream(p), size: fs.statSync(p).size };
}

function removeStored(storedName) {
  fs.rm(storedPath(storedName), { force: true }, () => {});
}

module.exports = { saveRequestBody, openStored, removeStored, uploadLimits, extOf, MIME_BY_EXT };
