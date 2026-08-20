-- ---------------------------------------------------------------------------
-- Mortgage client platform — PostgreSQL schema (Supabase-compatible).
--
-- Timestamp columns are stored as ISO-8601 UTC TEXT rather than TIMESTAMPTZ.
-- This is deliberate: ISO-8601 UTC sorts and range-scans correctly as text,
-- and it keeps the application's existing comparison semantics byte-for-byte
-- identical through the SQLite→Postgres migration, which matters more than
-- type purity in a system of record for financial documents. Migrating these
-- to TIMESTAMPTZ is tracked as a follow-up.
--
-- Boolean-ish columns are SMALLINT 0/1 with CHECK constraints for the same
-- reason — the application's truthiness logic is preserved exactly.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role                  TEXT NOT NULL,
  email                 TEXT NOT NULL,
  first_name            TEXT NOT NULL DEFAULT '',
  last_name             TEXT NOT NULL DEFAULT '',
  phone                 TEXT NOT NULL DEFAULT '',
  password_hash         TEXT,
  status                TEXT NOT NULL DEFAULT 'invited',
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  last_login_at         TEXT,
  welcomed_at           TEXT,
  must_change_password  SMALLINT NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  mfa_secret            TEXT,
  mfa_enrolled_at       TEXT,
  mfa_last_used_step    BIGINT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
-- Case-insensitive uniqueness; all writes normalize to lowercase already.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON mfa_recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_seen_at  TEXT,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        TEXT,
  ip           TEXT,
  success      SMALLINT NOT NULL CHECK (success IN (0,1)),
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, attempted_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, attempted_at);

-- Distributed rate limiting: works across serverless instances because the
-- counter lives in the database, not in process memory.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_types (
  id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key    TEXT UNIQUE,
  name   TEXT NOT NULL,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employment_statuses (
  id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key    TEXT UNIQUE,
  name   TEXT NOT NULL,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stages (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key                TEXT UNIQUE,
  name               TEXT NOT NULL,
  client_label       TEXT NOT NULL DEFAULT '',
  client_message     TEXT NOT NULL DEFAULT '',
  client_step        INTEGER NOT NULL DEFAULT 1,
  color              TEXT NOT NULL DEFAULT '#4f6ef7',
  icon               TEXT NOT NULL DEFAULT '',
  sort               INTEGER NOT NULL DEFAULT 0,
  active             SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  send_email         SMALLINT NOT NULL DEFAULT 0 CHECK (send_email IN (0,1)),
  email_template_key TEXT,
  create_task        SMALLINT NOT NULL DEFAULT 0 CHECK (create_task IN (0,1)),
  task_title         TEXT NOT NULL DEFAULT '',
  is_terminal        SMALLINT NOT NULL DEFAULT 0 CHECK (is_terminal IN (0,1))
);

CREATE TABLE IF NOT EXISTS client_files (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_number          TEXT NOT NULL UNIQUE,
  application_type_id  INTEGER REFERENCES application_types(id),
  stage_id             INTEGER REFERENCES stages(id),
  assigned_broker_id   INTEGER REFERENCES users(id),
  purchase_price       NUMERIC(14,2),
  down_payment         NUMERIC(14,2),
  mortgage_amount      NUMERIC(14,2),
  property_address     TEXT NOT NULL DEFAULT '',
  property_type        TEXT NOT NULL DEFAULT '',
  closing_date         TEXT,
  fthb                 SMALLINT NOT NULL DEFAULT 0 CHECK (fthb IN (0,1)),
  purpose              TEXT NOT NULL DEFAULT '',
  extra_info           TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'active',
  -- Per-file consent to automated (Claude) document review, with when it
  -- was recorded and how, so the decision is auditable (audit finding C6).
  ai_consent           SMALLINT NOT NULL DEFAULT 0 CHECK (ai_consent IN (0,1)),
  ai_consent_at        TEXT,
  ai_consent_source    TEXT,
  onedrive_folder_id   TEXT,
  onedrive_folder_path TEXT,
  onedrive_status      TEXT,
  onedrive_attempts    INTEGER NOT NULL DEFAULT 0,
  onedrive_error       TEXT,
  created_by           INTEGER REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  last_activity_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_status ON client_files(status);
CREATE INDEX IF NOT EXISTS idx_files_status_broker ON client_files(status, assigned_broker_id);
CREATE INDEX IF NOT EXISTS idx_files_activity ON client_files(status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_onedrive ON client_files(onedrive_status);

CREATE TABLE IF NOT EXISTS applicants (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id           INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  role              TEXT NOT NULL DEFAULT 'primary',
  first_name        TEXT NOT NULL,
  middle_name       TEXT NOT NULL DEFAULT '',
  last_name         TEXT NOT NULL,
  preferred_name    TEXT NOT NULL DEFAULT '',
  email             TEXT NOT NULL DEFAULT '',
  phone             TEXT NOT NULL DEFAULT '',
  dob               TEXT,
  address           TEXT NOT NULL DEFAULT '',
  preferred_contact TEXT NOT NULL DEFAULT 'email',
  employment_type   TEXT NOT NULL DEFAULT '',
  employer_name     TEXT NOT NULL DEFAULT '',
  job_title         TEXT NOT NULL DEFAULT '',
  employment_notes  TEXT NOT NULL DEFAULT '',
  portal_user_id    INTEGER REFERENCES users(id),
  -- When 1, this applicant may see documents belonging to other applicants
  -- on the same file. Off by default: a guarantor must not inherit the
  -- primary borrower's ID and bank statements (audit finding H3).
  shares_documents  SMALLINT NOT NULL DEFAULT 0 CHECK (shares_documents IN (0,1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applicants_file ON applicants(file_id);
CREATE INDEX IF NOT EXISTS idx_applicants_portal_user ON applicants(portal_user_id);

CREATE TABLE IF NOT EXISTS document_types (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key                   TEXT UNIQUE,
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'other',
  description           TEXT NOT NULL DEFAULT '',
  active                SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort                  INTEGER NOT NULL DEFAULT 0,
  default_requirement   TEXT NOT NULL DEFAULT 'required',
  default_per_applicant SMALLINT NOT NULL DEFAULT 0 CHECK (default_per_applicant IN (0,1)),
  default_expires_days  INTEGER
);

CREATE TABLE IF NOT EXISTS document_rules (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  active     SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  conditions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_rule_items (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id          INTEGER NOT NULL REFERENCES document_rules(id) ON DELETE CASCADE,
  document_type_id INTEGER NOT NULL REFERENCES document_types(id),
  requirement      TEXT NOT NULL DEFAULT 'required',
  per_applicant    SMALLINT NOT NULL DEFAULT 0 CHECK (per_applicant IN (0,1)),
  expires_days     INTEGER,
  note             TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rule_items_rule ON document_rule_items(rule_id);

CREATE TABLE IF NOT EXISTS checklist_exclusions (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  document_type_id INTEGER NOT NULL,
  applicant_id     INTEGER,
  excluded_by      INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exclusions_file ON checklist_exclusions(file_id);
-- NULL applicant_id must still collide, so uniqueness uses a sentinel.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exclusions_unique
  ON checklist_exclusions (file_id, document_type_id, COALESCE(applicant_id, -1));

CREATE TABLE IF NOT EXISTS document_requests (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id            INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id       INTEGER REFERENCES applicants(id) ON DELETE SET NULL,
  document_type_id   INTEGER NOT NULL REFERENCES document_types(id),
  status             TEXT NOT NULL DEFAULT 'required',
  requirement        TEXT NOT NULL DEFAULT 'required',
  source             TEXT NOT NULL DEFAULT 'rule',
  rule_id            INTEGER,
  due_date           TEXT,
  client_message     TEXT NOT NULL DEFAULT '',
  internal_note      TEXT NOT NULL DEFAULT '',
  expires_days       INTEGER,
  expires_at         TEXT,
  current_version_id INTEGER,
  reminders_enabled  SMALLINT NOT NULL DEFAULT 1 CHECK (reminders_enabled IN (0,1)),
  last_reminder_at   TEXT,
  reminder_count     INTEGER NOT NULL DEFAULT 0,
  client_comment     TEXT NOT NULL DEFAULT '',
  created_by         INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_file ON document_requests(file_id);
CREATE INDEX IF NOT EXISTS idx_requests_file_status ON document_requests(file_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_applicant ON document_requests(applicant_id);

CREATE TABLE IF NOT EXISTS document_versions (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id          INTEGER NOT NULL REFERENCES document_requests(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  original_name       TEXT NOT NULL,
  display_name        TEXT NOT NULL DEFAULT '',
  stored_name         TEXT NOT NULL,
  mime                TEXT NOT NULL,
  size                BIGINT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'uploaded',
  review_note_client  TEXT NOT NULL DEFAULT '',
  review_note_internal TEXT NOT NULL DEFAULT '',
  -- AES-256-GCM envelope for the stored bytes (audit finding C1).
  enc_envelope        TEXT,
  scan_status         TEXT NOT NULL DEFAULT 'pending',
  scan_result         TEXT,
  onedrive_item_id    TEXT,
  onedrive_path       TEXT,
  onedrive_status     TEXT,
  onedrive_attempts   INTEGER NOT NULL DEFAULT 0,
  onedrive_error      TEXT,
  uploaded_by         INTEGER,
  uploaded_at         TEXT NOT NULL,
  reviewed_by         INTEGER,
  reviewed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_versions_request ON document_versions(request_id);
CREATE INDEX IF NOT EXISTS idx_versions_onedrive ON document_versions(onedrive_status);

CREATE TABLE IF NOT EXISTS ai_reviews (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id    INTEGER NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  request_id    INTEGER NOT NULL,
  file_id       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  running_since TEXT,
  model         TEXT,
  result        TEXT,          -- encrypted at rest (envelope JSON)
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_reviews_status ON ai_reviews(status);
CREATE INDEX IF NOT EXISTS idx_ai_reviews_version ON ai_reviews(version_id);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id           INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  sender_id         INTEGER NOT NULL REFERENCES users(id),
  sender_kind       TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  attachment_name   TEXT,
  attachment_stored TEXT,
  attachment_mime   TEXT,
  attachment_size   BIGINT,
  created_at        TEXT NOT NULL,
  edited_at         TEXT,
  read_by_staff_at  TEXT,
  read_by_client_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_file ON messages(file_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(file_id, sender_kind, read_by_staff_at);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id      INTEGER REFERENCES client_files(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  due_date     TEXT,
  priority     TEXT NOT NULL DEFAULT 'normal',
  status       TEXT NOT NULL DEFAULT 'pending',
  assigned_to  INTEGER REFERENCES users(id),
  source       TEXT NOT NULL DEFAULT 'manual',
  created_by   INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_file ON tasks(file_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, due_date);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  pinned     SMALLINT NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_file ON notes(file_id);

CREATE TABLE IF NOT EXISTS stage_history (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  from_stage_id INTEGER,
  to_stage_id   INTEGER NOT NULL,
  changed_by    INTEGER,
  note          TEXT NOT NULL DEFAULT '',
  changed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage_history_file ON stage_history(file_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id        INTEGER,
  actor_id       INTEGER,
  actor_name     TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL,
  message        TEXT NOT NULL,
  meta           TEXT NOT NULL DEFAULT '{}',
  client_visible SMALLINT NOT NULL DEFAULT 0 CHECK (client_visible IN (0,1)),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_file ON activity_log(file_id, id DESC);

-- Append-only audit trail. A hash chain makes excision detectable: each row
-- carries the hash of the previous row, so removing or editing history breaks
-- the chain (audit finding H9). Revoke UPDATE/DELETE from the app role in
-- production; see docs/DEPLOYMENT.md.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  ip         TEXT,
  meta       TEXT NOT NULL DEFAULT '{}',
  prev_hash  TEXT,
  row_hash   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, id DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  file_id    INTEGER,
  link       TEXT NOT NULL DEFAULT '',
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS email_templates (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  active     SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS email_log (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  to_email     TEXT NOT NULL,
  to_name      TEXT NOT NULL DEFAULT '',
  user_id      INTEGER,
  file_id      INTEGER,
  template_key TEXT,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  error        TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_log_file ON email_log(file_id, id DESC);

CREATE TABLE IF NOT EXISTS consent_forms (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  active     SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS consents (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id            INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id       INTEGER REFERENCES applicants(id) ON DELETE SET NULL,
  form_id            INTEGER NOT NULL,
  form_title         TEXT NOT NULL,
  form_version       INTEGER NOT NULL,
  form_body_snapshot TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'requested',
  requested_by       INTEGER,
  requested_at       TEXT NOT NULL,
  responded_at       TEXT,
  responded_by       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_consents_file ON consents(file_id);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
