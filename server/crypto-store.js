'use strict';

/**
 * Envelope encryption for data at rest (C1).
 *
 * Every protected payload gets a fresh random 256-bit data key. The data key
 * encrypts the payload with AES-256-GCM; the data key itself is then wrapped
 * with a master key held outside the database. Only the wrapped key, the IVs
 * and the auth tags are stored, so a stolen database or a stolen document
 * volume is useless on its own — an attacker needs the master key too.
 *
 * Master keys are supplied as environment variables and identified by a key
 * id, so keys can be rotated without rewriting historical data:
 *
 *   DOCUMENT_ENCRYPTION_KEYS = v1:<base64 32 bytes>,v2:<base64 32 bytes>
 *   DOCUMENT_ENCRYPTION_ACTIVE_KEY = v2
 *
 * New writes use the active key; reads use whichever key id is recorded
 * against the row. Generate a key with:  npm run keygen
 */

const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;   // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

let cachedKeys = null;

function loadKeys() {
  if (cachedKeys) return cachedKeys;
  const raw = process.env.DOCUMENT_ENCRYPTION_KEYS || '';
  const keys = new Map();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    if (idx < 1) continue;
    const id = entry.slice(0, idx).trim();
    const material = Buffer.from(entry.slice(idx + 1).trim(), 'base64');
    if (material.length !== KEY_BYTES) {
      throw new Error(`DOCUMENT_ENCRYPTION_KEYS: key "${id}" must be exactly 32 bytes (base64-encoded).`);
    }
    keys.set(id, material);
  }
  const activeId = (process.env.DOCUMENT_ENCRYPTION_ACTIVE_KEY || [...keys.keys()][0] || '').trim();
  if (keys.size > 0 && !keys.has(activeId)) {
    throw new Error(`DOCUMENT_ENCRYPTION_ACTIVE_KEY "${activeId}" is not present in DOCUMENT_ENCRYPTION_KEYS.`);
  }
  cachedKeys = { keys, activeId };
  return cachedKeys;
}

/** Test/CLI hook — forget cached key material after the environment changes. */
function resetKeyCache() {
  cachedKeys = null;
}

function isConfigured() {
  return loadKeys().keys.size > 0;
}

/**
 * Encryption is mandatory in production. Refusing to start without keys is
 * deliberate: silently falling back to plaintext storage is exactly the
 * failure mode this control exists to prevent.
 */
function assertConfigured() {
  if (!isConfigured()) {
    throw new Error(
      'Document encryption is not configured. Set DOCUMENT_ENCRYPTION_KEYS (see `npm run keygen`). ' +
      'Refusing to store client documents unencrypted.'
    );
  }
}

function masterKey(keyId) {
  const { keys } = loadKeys();
  const key = keys.get(keyId);
  if (!key) {
    throw new Error(`No encryption key available for key id "${keyId}". Restore it in DOCUMENT_ENCRYPTION_KEYS to read this data.`);
  }
  return key;
}

function activeKeyId() {
  assertConfigured();
  return loadKeys().activeId;
}

/**
 * Encrypt a buffer. Returns the ciphertext plus the envelope metadata that
 * must be stored alongside it (all values are safe to keep in the database).
 */
function encryptBuffer(plaintext) {
  assertConfigured();
  const keyId = activeKeyId();

  // Per-payload data key, wrapped with the master key.
  const dataKey = crypto.randomBytes(KEY_BYTES);
  const wrapIv = crypto.randomBytes(IV_BYTES);
  const wrapCipher = crypto.createCipheriv(ALGO, masterKey(keyId), wrapIv);
  const wrappedKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  dataKey.fill(0); // don't leave the plaintext data key lying in memory

  return {
    ciphertext,
    envelope: {
      v: 1,
      key_id: keyId,
      wrapped_key: Buffer.concat([wrapIv, wrapTag, wrappedKey]).toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    },
  };
}

/** Decrypt a buffer produced by encryptBuffer. Throws if tampered with. */
function decryptBuffer(ciphertext, envelope) {
  if (!envelope || envelope.v !== 1) throw new Error('Unsupported encryption envelope.');
  const wrapped = Buffer.from(envelope.wrapped_key, 'base64');
  const wrapIv = wrapped.subarray(0, IV_BYTES);
  const wrapTag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const wrappedKey = wrapped.subarray(IV_BYTES + TAG_BYTES);

  const unwrap = crypto.createDecipheriv(ALGO, masterKey(envelope.key_id), wrapIv);
  unwrap.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([unwrap.update(wrappedKey), unwrap.final()]);

  const decipher = crypto.createDecipheriv(ALGO, dataKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  dataKey.fill(0);
  return plaintext;
}

/**
 * Encrypt a JSON-serializable value into a single self-contained string,
 * for database columns holding sensitive extracted data (AI review output).
 */
function encryptJson(value) {
  const { ciphertext, envelope } = encryptBuffer(Buffer.from(JSON.stringify(value), 'utf8'));
  return JSON.stringify({ ...envelope, data: ciphertext.toString('base64') });
}

function decryptJson(stored) {
  if (stored === null || stored === undefined || stored === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  // Tolerate values written before encryption was enabled.
  if (!parsed || parsed.v !== 1 || !parsed.data) return parsed;
  const plaintext = decryptBuffer(Buffer.from(parsed.data, 'base64'), parsed);
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
}

/** Generate a fresh master key for operators to paste into their config. */
function generateMasterKey() {
  return crypto.randomBytes(KEY_BYTES).toString('base64');
}

module.exports = {
  isConfigured,
  assertConfigured,
  activeKeyId,
  encryptBuffer,
  decryptBuffer,
  encryptJson,
  decryptJson,
  generateMasterKey,
  resetKeyCache,
};
