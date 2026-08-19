'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { now, parseJsonSafe } = require('./util');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'platform.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'invited',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  welcomed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  ip TEXT,
  success INTEGER NOT NULL,
  attempted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE,
  name TEXT NOT NULL,
  client_label TEXT NOT NULL DEFAULT '',
  client_message TEXT NOT NULL DEFAULT '',
  client_step INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#4f6ef7',
  icon TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  send_email INTEGER NOT NULL DEFAULT 0,
  email_template_key TEXT,
  create_task INTEGER NOT NULL DEFAULT 0,
  task_title TEXT NOT NULL DEFAULT '',
  is_terminal INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS client_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_number TEXT NOT NULL UNIQUE,
  application_type_id INTEGER REFERENCES application_types(id),
  stage_id INTEGER REFERENCES stages(id),
  assigned_broker_id INTEGER REFERENCES users(id),
  purchase_price REAL,
  down_payment REAL,
  mortgage_amount REAL,
  property_address TEXT NOT NULL DEFAULT '',
  property_type TEXT NOT NULL DEFAULT '',
  closing_date TEXT,
  fthb INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT '',
  extra_info TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);

CREATE TABLE IF NOT EXISTS applicants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'primary',
  first_name TEXT NOT NULL,
  middle_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL,
  preferred_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  dob TEXT,
  address TEXT NOT NULL DEFAULT '',
  preferred_contact TEXT NOT NULL DEFAULT 'email',
  employment_type TEXT NOT NULL DEFAULT '',
  employer_name TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
  employment_notes TEXT NOT NULL DEFAULT '',
  portal_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS document_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  conditions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_rule_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL REFERENCES document_rules(id) ON DELETE CASCADE,
  document_type_id INTEGER NOT NULL REFERENCES document_types(id),
  requirement TEXT NOT NULL DEFAULT 'required',
  per_applicant INTEGER NOT NULL DEFAULT 0,
  expires_days INTEGER,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS document_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id INTEGER REFERENCES applicants(id) ON DELETE SET NULL,
  document_type_id INTEGER NOT NULL REFERENCES document_types(id),
  status TEXT NOT NULL DEFAULT 'required',
  requirement TEXT NOT NULL DEFAULT 'required',
  source TEXT NOT NULL DEFAULT 'rule',
  rule_id INTEGER,
  due_date TEXT,
  client_message TEXT NOT NULL DEFAULT '',
  internal_note TEXT NOT NULL DEFAULT '',
  expires_days INTEGER,
  expires_at TEXT,
  current_version_id INTEGER,
  reminders_enabled INTEGER NOT NULL DEFAULT 1,
  last_reminder_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  client_comment TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES document_requests(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  review_note_client TEXT NOT NULL DEFAULT '',
  review_note_internal TEXT NOT NULL DEFAULT '',
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL,
  reviewed_by INTEGER,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  sender_kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  attachment_name TEXT,
  attachment_stored TEXT,
  attachment_mime TEXT,
  attachment_size INTEGER,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  read_by_staff_at TEXT,
  read_by_client_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER REFERENCES client_files(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_to INTEGER REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'manual',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  from_stage_id INTEGER,
  to_stage_id INTEGER NOT NULL,
  changed_by INTEGER,
  note TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER,
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  client_visible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  ip TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  file_id INTEGER,
  link TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_templates (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  file_id INTEGER,
  template_key TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS consent_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id INTEGER REFERENCES applicants(id) ON DELETE SET NULL,
  form_id INTEGER NOT NULL,
  form_title TEXT NOT NULL,
  form_version INTEGER NOT NULL,
  form_body_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  requested_by INTEGER,
  requested_at TEXT NOT NULL,
  responded_at TEXT,
  responded_by INTEGER
);

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_applicants_file ON applicants(file_id);
CREATE INDEX IF NOT EXISTS idx_applicants_portal_user ON applicants(portal_user_id);
CREATE INDEX IF NOT EXISTS idx_requests_file ON document_requests(file_id);
CREATE INDEX IF NOT EXISTS idx_versions_request ON document_versions(request_id);
CREATE INDEX IF NOT EXISTS idx_messages_file ON messages(file_id);
CREATE INDEX IF NOT EXISTS idx_tasks_file ON tasks(file_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_notes_file ON notes(file_id);
CREATE INDEX IF NOT EXISTS idx_activity_file ON activity_log(file_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_email_log_file ON email_log(file_id);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(email, attempted_at);
`;

db.exec(SCHEMA);

function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

/** Run fn inside a transaction; rolls back on throw. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSetting(key, fallback) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  return parseJsonSafe(row.value, fallback);
}

function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value)
  );
}

/** Next sequential number for a counter key (transaction-safe when called inside tx). */
function nextCounter(key) {
  run('INSERT INTO counters (key, value) VALUES (?, 0) ON CONFLICT(key) DO NOTHING', key);
  run('UPDATE counters SET value = value + 1 WHERE key = ?', key);
  return get('SELECT value FROM counters WHERE key = ?', key).value;
}

function nextFileNumber() {
  const year = new Date().getUTCFullYear();
  const seq = nextCounter(`file:${year}`);
  return `MTG-${year}-${String(seq).padStart(5, '0')}`;
}

function touchFile(fileId) {
  run('UPDATE client_files SET last_activity_at = ?, updated_at = ? WHERE id = ?', now(), now(), fileId);
}

module.exports = {
  db,
  DATA_DIR,
  run,
  get,
  all,
  tx,
  getSetting,
  setSetting,
  nextCounter,
  nextFileNumber,
  touchFile,
};
