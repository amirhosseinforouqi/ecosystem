'use strict';

/**
 * AI document review pipeline (audit findings C6, C1, H5).
 *
 * Disabled by default. Sending a client's government ID or bank statements to
 * a third-party processor is a disclosure of personal information, so it now
 * requires an operator to make three separate, deliberate decisions:
 *
 *   1. AI_DOCUMENT_REVIEW_ENABLED=true      — the operator enables the feature
 *   2. AI_PROCESSING_AGREEMENT_REF=<ref>    — a processing agreement is on file
 *   3. Settings → AI review turned on       — the brokerage opts in, and
 *      per-file client consent is recorded where the brokerage requires it
 *
 * Missing any one of them means no document ever leaves this server. Having
 * an API key present is explicitly NOT sufficient any more.
 *
 * Results are encrypted at rest (they contain extracted income and banking
 * figures) and are never serialized to the client portal.
 */

const path = require('node:path');
const fs = require('node:fs');
const { run, get, all, getSetting } = require('./db');
const { now, parseJsonSafe } = require('./util');
const cryptoStore = require('./crypto-store');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'document-review', 'SKILL.md');
const MAX_ATTEMPTS = 3;
const RUNNING_LEASE_MS = 10 * 60 * 1000;

const IMAGE_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Server-level switches. Both must be present. */
function isServerEnabled() {
  return (
    process.env.AI_DOCUMENT_REVIEW_ENABLED === 'true' &&
    !!process.env.ANTHROPIC_API_KEY &&
    !!process.env.AI_PROCESSING_AGREEMENT_REF
  );
}

/** Why the feature is off, for the Integrations settings screen. */
function disabledReason() {
  if (process.env.AI_DOCUMENT_REVIEW_ENABLED !== 'true') {
    return 'Turned off at the server (AI_DOCUMENT_REVIEW_ENABLED is not "true").';
  }
  if (!process.env.ANTHROPIC_API_KEY) return 'No ANTHROPIC_API_KEY is configured.';
  if (!process.env.AI_PROCESSING_AGREEMENT_REF) {
    return 'No data processing agreement reference is recorded (AI_PROCESSING_AGREEMENT_REF).';
  }
  return null;
}

/** Brokerage-level switch plus, optionally, per-file client consent. */
async function isEnabledForFile(file) {
  if (!isServerEnabled()) return false;
  const cfg = await getSetting('ai_review', {});
  if (cfg.enabled !== true) return false;
  if (cfg.require_client_consent !== false) {
    return !!(file && file.ai_consent === 1);
  }
  return true;
}

/** Used by settings/status displays only. */
async function isEnabled() {
  if (!isServerEnabled()) return false;
  return (await getSetting('ai_review', {})).enabled === true;
}

function baseUrl() {
  return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
}

function model() {
  return process.env.ANTHROPIC_MODEL || 'claude-opus-5';
}

let skillCache = null;
function loadSkill() {
  if (!skillCache) skillCache = fs.readFileSync(SKILL_PATH, 'utf8');
  return skillCache;
}

function supportedMedia(mime) {
  return mime === 'application/pdf' || IMAGE_MEDIA.includes(mime);
}

/**
 * Queue a review for a freshly uploaded version. When the feature is off for
 * this file the row is recorded as 'disabled' — the document is never sent,
 * and the broker can see plainly that no AI processing happened.
 */
async function queueReview(versionId) {
  const version = await get('SELECT * FROM document_versions WHERE id = ?', versionId);
  if (!version) return;
  const request = await get('SELECT * FROM document_requests WHERE id = ?', version.request_id);
  if (!request) return;
  const file = await get('SELECT * FROM client_files WHERE id = ?', request.file_id);

  let status = 'disabled';
  if (await isEnabledForFile(file)) {
    status = supportedMedia(version.mime) ? 'pending' : 'unsupported';
  }
  await run(
    `INSERT INTO ai_reviews (version_id, request_id, file_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    versionId, request.id, request.file_id, status, now(), now()
  );
}

async function fileBlock(version) {
  const storage = require('./storage');
  const data = (await storage.readStored(version.stored_name, parseJsonSafe(version.enc_envelope, null)))
    .toString('base64');
  if (version.mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: version.mime, data } };
}

async function callClaude(version, expectedDocName) {
  const body = {
    model: model(),
    max_tokens: 4096,
    system: loadSkill(),
    messages: [
      {
        role: 'user',
        content: [
          await fileBlock(version),
          {
            type: 'text',
            text: `Expected document type for this checklist item: "${expectedDocName}". Review the attached document and return the JSON result.`,
          },
        ],
      },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.ANTHROPIC_TIMEOUT_MS) || 120000);
  let res;
  try {
    res = await fetch(`${baseUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && data.error.message) || `HTTP ${res.status}`;
    const err = new Error(`Claude API error: ${message}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  if (data.stop_reason === 'refusal') {
    return {
      detected_type: 'unknown', matches_expected: false, confidence: 'low',
      summary: 'The AI declined to review this document.', extracted: {},
      issues: ['AI review declined'], suggested_action: 'Review manually.',
    };
  }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return parseReviewJson(text);
}

function parseReviewJson(text) {
  const direct = parseJsonSafe(String(text).trim(), null);
  if (direct && typeof direct === 'object') return direct;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (match) {
    const inner = parseJsonSafe(match[0], null);
    if (inner && typeof inner === 'object') return inner;
  }
  throw Object.assign(new Error('Claude returned a response that was not valid JSON.'), { retryable: true });
}

/**
 * Reclaim reviews whose worker died mid-call (audit finding H5). Without this
 * a deploy during an API call left the row 'running' forever, invisible and
 * unretryable.
 */
async function reclaimStalled() {
  const cutoff = new Date(Date.now() - RUNNING_LEASE_MS).toISOString();
  const res = await run(
    `UPDATE ai_reviews SET status = 'pending', updated_at = ?
      WHERE status = 'running' AND (running_since IS NULL OR running_since < ?)`,
    now(), cutoff
  );
  return res.rowCount;
}

async function processAiReviews() {
  if (!isServerEnabled()) return;
  await reclaimStalled();

  const { notifyStaffForFile } = require('./notify');
  const { activity } = require('./log');
  const onedrive = require('./onedrive');

  const pending = await all(
    `SELECT * FROM ai_reviews WHERE status = 'pending' AND attempts < ? ORDER BY id LIMIT 3`,
    MAX_ATTEMPTS
  );
  for (const review of pending) {
    const version = await get('SELECT * FROM document_versions WHERE id = ?', review.version_id);
    const request = await get('SELECT * FROM document_requests WHERE id = ?', review.request_id);
    const file = await get('SELECT * FROM client_files WHERE id = ?', review.file_id);
    if (!version || !request || !file) {
      await run("UPDATE ai_reviews SET status = 'failed', error = 'record no longer exists', updated_at = ? WHERE id = ?", now(), review.id);
      continue;
    }
    // Consent can be withdrawn between queueing and processing.
    if (!(await isEnabledForFile(file))) {
      await run("UPDATE ai_reviews SET status = 'disabled', updated_at = ? WHERE id = ?", now(), review.id);
      continue;
    }

    await run(
      "UPDATE ai_reviews SET status = 'running', attempts = attempts + 1, running_since = ?, updated_at = ? WHERE id = ?",
      now(), now(), review.id
    );
    const docType = await get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);

    try {
      const result = await callClaude(version, docType ? docType.name : 'Unknown');
      await run(
        "UPDATE ai_reviews SET status = 'done', result = ?, model = ?, error = NULL, running_since = NULL, updated_at = ?, completed_at = ? WHERE id = ?",
        cryptoStore.encryptJson(result), model(), now(), now(), review.id
      );
      await activity(file.id, null, 'ai_review_done', `AI review completed for ${docType ? docType.name : 'a document'} (v${version.version})`);
      await notifyStaffForFile(
        file, 'ai_review_done',
        `AI review ready: ${docType ? docType.name : 'document'}`,
        String(result.summary || '').slice(0, 200),
        `#/files/${file.id}/documents`
      );
      if (onedrive.isEnabled() && file.onedrive_folder_path) {
        try {
          await onedrive.uploadAiReviewToOneDrive(file, docType ? docType.name : 'Document', version.version, result);
        } catch (err) {
          console.error('[ai-review] OneDrive mirror failed:', err.message);
        }
      }
    } catch (err) {
      const exhausted = review.attempts + 1 >= MAX_ATTEMPTS || err.retryable === false;
      await run(
        `UPDATE ai_reviews SET status = ?, error = ?, running_since = NULL, updated_at = ? WHERE id = ?`,
        exhausted ? 'failed' : 'pending', String(err.message).slice(0, 500), now(), review.id
      );
      console.error('[ai-review] review', review.id, exhausted ? 'failed permanently:' : 'will retry:', err.message);
    }
  }
}

/** Broker-triggered retry, including for rows stuck in 'running'. */
async function retryReview(reviewId) {
  await run(
    `UPDATE ai_reviews SET status = 'pending', attempts = 0, error = NULL, running_since = NULL, updated_at = ?
      WHERE id = ? AND status IN ('failed','disabled','unsupported','running')`,
    now(), reviewId
  );
}

/** Latest review per version, decrypted — brokerage-internal callers only. */
async function reviewForVersion(versionId) {
  const row = await get('SELECT * FROM ai_reviews WHERE version_id = ? ORDER BY id DESC LIMIT 1', versionId);
  if (!row) return null;
  let result = null;
  if (row.result) {
    try {
      result = cryptoStore.decryptJson(row.result);
    } catch {
      result = null; // key rotated away or tampered; surfaced as an error state
    }
  }
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    model: row.model,
    error: row.error,
    completed_at: row.completed_at,
    result,
  };
}

module.exports = {
  isEnabled,
  isServerEnabled,
  isEnabledForFile,
  disabledReason,
  queueReview,
  processAiReviews,
  reclaimStalled,
  retryReview,
  reviewForVersion,
};
