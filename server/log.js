'use strict';

const { run, touchFile } = require('./db');
const { now } = require('./util');

/**
 * Activity: the human-readable, per-file timeline shown to brokerage staff.
 * kind examples: client_created, email_sent, login, document_uploaded,
 * document_approved, stage_changed, message_sent, task_created ...
 */
function activity(fileId, actor, kind, message, meta = {}, clientVisible = false) {
  run(
    `INSERT INTO activity_log (file_id, actor_id, actor_name, kind, message, meta, client_visible, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    fileId ?? null,
    actor ? actor.id : null,
    actor ? `${actor.first_name} ${actor.last_name}`.trim() : 'System',
    kind,
    message,
    JSON.stringify(meta),
    clientVisible ? 1 : 0,
    now()
  );
  if (fileId) touchFile(fileId);
}

/**
 * Audit: append-only security log for sensitive operations. There are no
 * update or delete endpoints for this table.
 */
function audit(userId, action, entity, entityId, ip, meta = {}) {
  run(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, ip, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId ?? null, action, entity ?? null, entityId ?? null, ip ?? null, JSON.stringify(meta), now()
  );
}

module.exports = { activity, audit };
