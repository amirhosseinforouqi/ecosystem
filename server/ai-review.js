'use strict';

/**
 * AI document review pipeline (background, retryable, never blocks uploads).
 *
 * Every upload enqueues an ai_reviews row. A scheduler pass picks pending
 * rows up, sends the document to Claude using the project's reusable
 * document-review skill (skills/document-review/SKILL.md — the skill file IS
 * the system prompt, so review behavior is configured there, not hard-coded
 * into upload handlers), stores the structured JSON result, and notifies the
 * assigned broker. Results are internal-only: they are never exposed through
 * any client-portal endpoint or email.
 *
 * Claude is called over raw HTTPS (global fetch) to keep this project's
 * zero-npm-dependency architecture — the same reason SMTP and Microsoft
 * Graph are hand-rolled here. Request shape follows the Messages API:
 * PDF documents as base64 `document` blocks, images as base64 `image`
 * blocks.
 *
 * Environment:
 *   ANTHROPIC_API_KEY    required to enable reviews (absent → skipped)
 *   ANTHROPIC_MODEL      default claude-opus-5
 *   ANTHROPIC_BASE_URL   default https://api.anthropic.com (tests point
 *                        this at a local protocol-accurate mock)
 */

const fs = require('node:fs');
const path = require('node:path');
const { run, get, all, DATA_DIR } = require('./db');
const { now, parseJsonSafe } = require('./util');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'document-review', 'SKILL.md');
const MAX_ATTEMPTS = 3;

// Media types the Messages API accepts for vision/document input.
const IMAGE_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function isEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
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

/** Queue a review for a freshly uploaded version. */
function queueReview(versionId) {
  const version = get('SELECT * FROM document_versions WHERE id = ?', versionId);
  if (!version) return;
  const request = get('SELECT * FROM document_requests WHERE id = ?', version.request_id);
  if (!request) return;
  const status = isEnabled()
    ? supportedMedia(version.mime) ? 'pending' : 'unsupported'
    : 'disabled';
  run(
    `INSERT INTO ai_reviews (version_id, request_id, file_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    versionId, request.id, request.file_id, status, now(), now()
  );
}

function supportedMedia(mime) {
  return mime === 'application/pdf' || IMAGE_MEDIA.includes(mime);
}

/** Build the Messages API content block for the stored file. */
function fileBlock(version) {
  const localPath = path.join(DATA_DIR, 'uploads', path.basename(version.stored_name));
  const data = fs.readFileSync(localPath).toString('base64');
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
          fileBlock(version),
          {
            type: 'text',
            text: `Expected document type for this checklist item: "${expectedDocName}". Review the attached document and return the JSON result.`,
          },
        ],
      },
    ],
  };
  const res = await fetch(`${baseUrl()}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && data.error.message) || `HTTP ${res.status}`;
    const retryable = res.status === 429 || res.status >= 500;
    const err = new Error(`Claude API error: ${message}`);
    err.retryable = retryable;
    throw err;
  }
  if (data.stop_reason === 'refusal') {
    return { detected_type: 'unknown', matches_expected: false, confidence: 'low', summary: 'The AI declined to review this document.', extracted: {}, issues: ['AI review declined'], suggested_action: 'Review manually.' };
  }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return parseReviewJson(text);
}

/** Parse the model's JSON, tolerating code fences or stray prose. */
function parseReviewJson(text) {
  const direct = parseJsonSafe(text.trim(), null);
  if (direct && typeof direct === 'object') return direct;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    const inner = parseJsonSafe(match[0], null);
    if (inner && typeof inner === 'object') return inner;
  }
  throw Object.assign(new Error('Claude returned a response that was not valid JSON.'), { retryable: true });
}

/** Scheduler pass: process a few pending reviews per tick. */
async function processAiReviews() {
  if (!isEnabled()) return;
  const { notifyStaffForFile } = require('./notify');
  const { activity } = require('./log');
  const onedrive = require('./onedrive');

  const pending = all(
    `SELECT * FROM ai_reviews WHERE status = 'pending' AND attempts < ? ORDER BY id LIMIT 3`,
    MAX_ATTEMPTS
  );
  for (const review of pending) {
    run("UPDATE ai_reviews SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", now(), review.id);
    const version = get('SELECT * FROM document_versions WHERE id = ?', review.version_id);
    const request = get('SELECT * FROM document_requests WHERE id = ?', review.request_id);
    const file = get('SELECT * FROM client_files WHERE id = ?', review.file_id);
    const docType = request ? get('SELECT * FROM document_types WHERE id = ?', request.document_type_id) : null;
    if (!version || !request || !file) {
      run("UPDATE ai_reviews SET status = 'failed', error = 'record no longer exists', updated_at = ? WHERE id = ?", now(), review.id);
      continue;
    }
    try {
      const result = await callClaude(version, docType ? docType.name : 'Unknown');
      run(
        "UPDATE ai_reviews SET status = 'done', result = ?, model = ?, error = NULL, updated_at = ?, completed_at = ? WHERE id = ?",
        JSON.stringify(result), model(), now(), now(), review.id
      );
      activity(file.id, null, 'ai_review_done', `AI review completed for ${docType ? docType.name : 'a document'} (v${version.version})`);
      notifyStaffForFile(
        file, 'ai_review_done',
        `AI review ready: ${docType ? docType.name : 'document'}`,
        String(result.summary || '').slice(0, 200),
        `#/files/${file.id}/documents`
      );
      // Mirror the structured result into the client's OneDrive "AI Review" folder.
      if (onedrive.isEnabled() && file.onedrive_folder_path) {
        try {
          await onedrive.uploadAiReviewToOneDrive(file, docType ? docType.name : 'Document', version.version, result);
        } catch (err) {
          console.error('[ai-review] OneDrive mirror failed:', err.message);
        }
      }
    } catch (err) {
      const exhausted = review.attempts + 1 >= MAX_ATTEMPTS || err.retryable === false;
      run(
        `UPDATE ai_reviews SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
        exhausted ? 'failed' : 'pending', String(err.message).slice(0, 500), now(), review.id
      );
      console.error('[ai-review] review', review.id, exhausted ? 'failed permanently:' : 'will retry:', err.message);
    }
  }
}

/** Broker-triggered retry for a failed/unsupported review. */
function retryReview(reviewId) {
  run(
    "UPDATE ai_reviews SET status = 'pending', attempts = 0, error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed','disabled','unsupported')",
    now(), reviewId
  );
}

/** Latest review row per version, for the broker serializer. */
function reviewForVersion(versionId) {
  const row = get('SELECT * FROM ai_reviews WHERE version_id = ? ORDER BY id DESC LIMIT 1', versionId);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    model: row.model,
    error: row.error,
    completed_at: row.completed_at,
    result: row.result ? parseJsonSafe(row.result, null) : null,
  };
}

module.exports = { isEnabled, queueReview, processAiReviews, retryReview, reviewForVersion };
