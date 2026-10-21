-- AI Quote Creation Agent: local state (SQLite). Applied idempotently at startup by src/db/index.ts.

-- One row per (email, Excel attachment). Created atomically before any side effect happens.
CREATE TABLE IF NOT EXISTS enquiries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- sha256(excel bytes + sender + message-id): idempotency key, one row per delivery of one attachment
  message_key       TEXT    NOT NULL UNIQUE,
  -- sha256(excel bytes + sender): fingerprint used for the "same enquiry re-sent within N hours" check
  content_hash      TEXT    NOT NULL,
  message_id        TEXT    NOT NULL,
  sender_email      TEXT    NOT NULL,
  subject           TEXT    NOT NULL DEFAULT '',
  attachment_name   TEXT,
  status            TEXT    NOT NULL CHECK (status IN (
                      'PROCESSING', 'NEEDS_INFO', 'HALTED_CUSTOMER_NOT_FOUND', 'HALTED_CUSTOMER_AMBIGUOUS',
                      'QUOTE_CREATED', 'QUOTE_CREATED_WITH_EXCEPTIONS', 'FAILED')),
  attempts          INTEGER NOT NULL DEFAULT 1,
  zoho_customer_id  TEXT,
  zoho_estimate_id  TEXT,
  estimate_number   TEXT,
  quote_url         TEXT,
  total_amount      REAL,
  currency_code     TEXT,
  line_count        INTEGER,
  matched_count     INTEGER,
  unmatched_count   INTEGER,
  error             TEXT,
  -- shown on the dashboard (never email bodies or attachments)
  customer_name     TEXT,
  match_tier        TEXT,
  company_in_email  TEXT,
  email_date        TEXT,
  unreadable_rows   INTEGER,
  review_flags      TEXT,
  -- set while the email is kept waiting for a new customer to be added in Zoho Books
  hold_until        TEXT,
  -- details of a not-yet-existing customer read from the email, to pre-fill the "add customer" form (cleared once added)
  customer_draft    TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_enquiries_content ON enquiries (content_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_enquiries_status  ON enquiries (status);

-- Notifications already delivered, so a retry after a partial failure never double-sends.
CREATE TABLE IF NOT EXISTS notifications (
  enquiry_id  INTEGER NOT NULL REFERENCES enquiries (id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  sent_at     TEXT    NOT NULL,
  PRIMARY KEY (enquiry_id, kind)
);

-- Append-only audit trail (what happened to each enquiry, in order).
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id  INTEGER REFERENCES enquiries (id) ON DELETE CASCADE,
  event       TEXT    NOT NULL,
  detail      TEXT,
  at          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_enquiry ON audit_log (enquiry_id, id);

-- Small key/value store for service state: last poll, last backup, dashboard session key ...
CREATE TABLE IF NOT EXISTS app_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Model usage per day and task, so the dashboard can show calls, tokens and estimated cost.
CREATE TABLE IF NOT EXISTS llm_usage_daily (
  day            TEXT    NOT NULL,
  task           TEXT    NOT NULL,
  calls          INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, task)
);

-- People who can sign in to the dashboard. Never deleted (history keeps pointing at them); switched off instead.
CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  email                 TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name          TEXT    NOT NULL,
  role                  TEXT    NOT NULL,
  password_hash         TEXT    NOT NULL,
  must_change_password  INTEGER NOT NULL DEFAULT 0,
  active                INTEGER NOT NULL DEFAULT 1,
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  created_by            INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  last_login_at         TEXT
);

-- Server-side sessions. `id` is sha256 of the cookie value, so a copy of this file cannot be used to sign in.
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- Who did what in the dashboard: sign-ins, team changes, downloads, notes. Names are copied in so history stays readable.
CREATE TABLE IF NOT EXISTS security_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT    NOT NULL,
  actor_id     INTEGER,
  actor_label  TEXT,
  event        TEXT    NOT NULL,
  target       TEXT,
  detail       TEXT,
  ip           TEXT
);

CREATE INDEX IF NOT EXISTS idx_security_events_at ON security_events (id);

-- Notes and "handled" marks that the team leaves on an enquiry. Local to this server; nothing is written to Zoho.
CREATE TABLE IF NOT EXISTS enquiry_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id  INTEGER NOT NULL REFERENCES enquiries (id) ON DELETE CASCADE,
  user_id     INTEGER,
  author      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  body        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_enquiry_notes ON enquiry_notes (enquiry_id, id);

-- An email from a customer who is not in Zoho Books yet is kept here, temporarily, so the quote can be created
-- automatically once the customer is added. Deleted when the quote is made, when the hold runs out, or with the enquiry.
CREATE TABLE IF NOT EXISTS held_mail (
  enquiry_id  INTEGER PRIMARY KEY REFERENCES enquiries (id) ON DELETE CASCADE,
  raw         BLOB    NOT NULL,
  held_at     TEXT    NOT NULL,
  checked_at  TEXT    NOT NULL
);
