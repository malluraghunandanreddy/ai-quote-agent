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
