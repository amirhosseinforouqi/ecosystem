'use strict';

/**
 * Generate a document encryption master key.
 *
 *   npm run keygen              → a first key (v1)
 *   npm run keygen -- --rotate  → the next key id, given the current set
 *
 * Rotation keeps every old key in DOCUMENT_ENCRYPTION_KEYS so existing
 * documents stay readable; only DOCUMENT_ENCRYPTION_ACTIVE_KEY changes, and
 * new documents are wrapped with the new key.
 */

const { generateMasterKey } = require('../server/crypto-store');

const existing = String(process.env.DOCUMENT_ENCRYPTION_KEYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const usedIds = existing
  .map((entry) => entry.split(':')[0])
  .filter((id) => /^v\d+$/.test(id))
  .map((id) => Number(id.slice(1)));

const nextId = `v${(usedIds.length ? Math.max(...usedIds) : 0) + 1}`;
const key = generateMasterKey();
const entry = `${nextId}:${key}`;
const all = [...existing, entry].join(',');

console.log('New key generated. Set these two variables in your hosting provider:\n');
console.log(`DOCUMENT_ENCRYPTION_KEYS=${all}`);
console.log(`DOCUMENT_ENCRYPTION_ACTIVE_KEY=${nextId}`);
console.log('\nKeep every previous key in DOCUMENT_ENCRYPTION_KEYS — removing one makes the');
console.log('documents wrapped with it permanently unreadable. Never commit these values.');
