"""SQLite persistence: enquiries, line items, Zoho refs, dedup hashes, exceptions, audit log."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from .config import get_settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS enquiries (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    source                TEXT NOT NULL,           -- imap | upload | sample
    message_id            TEXT,
    received_at           TEXT,
    sender_email          TEXT,
    sender_name           TEXT,
    subject               TEXT,
    body_text             TEXT,
    attachment_name       TEXT,
    attachment_blob       BLOB,
    dedup_hash            TEXT,
    customer_name         TEXT,
    contact_name          TEXT,
    reference             TEXT,
    required_by           TEXT,
    notes                 TEXT,
    status                TEXT NOT NULL,           -- RECEIVED | PROCESSING | RETRY_PENDING | DRAFT_CREATED | NEEDS_REVIEW | EXCEPTION | DUPLICATE | IGNORED | DISMISSED | APPROVED | REJECTED
    error_code            TEXT,
    error_message         TEXT,
    duplicate_of          INTEGER,
    erp_connector             TEXT,
    erp_customer_id      TEXT,
    erp_customer_name    TEXT,
    erp_quote_id      TEXT,
    erp_quote_number  TEXT,
    erp_quote_status  TEXT,
    erp_quote_url     TEXT,
    quote_total        REAL,
    currency              TEXT,
    processing_ms         INTEGER,
    source_sheet          TEXT,                    -- where the items were read from (for the source view)
    source_header_row     INTEGER,
    source_mapping        TEXT,                    -- JSON {field: column_index}
    mapped_by             TEXT,                    -- rules | ai | email
    contact_phone         TEXT,
    delivery_address      TEXT,
    delivery_terms        TEXT,
    retry_count           INTEGER NOT NULL DEFAULT 0,
    next_retry_at         TEXT                     -- set while status = RETRY_PENDING
);
CREATE INDEX IF NOT EXISTS ix_enquiries_status ON enquiries(status);

CREATE TABLE IF NOT EXISTS line_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    enquiry_id      INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
    line_no         INTEGER NOT NULL,
    source          TEXT,                         -- excel | email
    sku             TEXT,
    name            TEXT,
    description     TEXT,
    quantity        REAL,
    unit            TEXT,
    customer_rate   REAL,                         -- price the customer quoted/targeted, if any
    erp_item_id    TEXT,
    erp_item_name  TEXT,
    erp_sku        TEXT,
    rate            REAL,                         -- rate used on the estimate (Zoho price list)
    amount          REAL,
    match_method    TEXT,                         -- sku | name | fuzzy | ai | NULL (unmatched)
    match_score     REAL,
    source_row      INTEGER,                      -- 0-based row in the source sheet
    flags           TEXT,                         -- comma list: not_found, price_missing, ambiguous, unit_mismatch
    review_note     TEXT                          -- human-readable reasons for the flags
);
CREATE INDEX IF NOT EXISTS ix_line_items_enquiry ON line_items(enquiry_id);

CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    enquiry_id    INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    content_type  TEXT,
    blob          BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attachments_enquiry ON attachments(enquiry_id);

CREATE TABLE IF NOT EXISTS dedup_hashes (
    hash        TEXT PRIMARY KEY,
    enquiry_id  INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exceptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    enquiry_id  INTEGER,
    created_at  TEXT NOT NULL,
    code        TEXT NOT NULL,
    message     TEXT NOT NULL,
    alerted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    enquiry_id  INTEGER,
    created_at  TEXT NOT NULL,
    stage       TEXT NOT NULL,
    level       TEXT NOT NULL,                    -- info | warn | error | success
    message     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_enquiry ON audit_events(enquiry_id);

CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    enquiry_id  INTEGER,
    created_at  TEXT NOT NULL,
    kind        TEXT NOT NULL,                    -- internal | alert
    recipients  TEXT NOT NULL,
    subject     TEXT NOT NULL,
    body_html   TEXT NOT NULL,
    status      TEXT NOT NULL,                    -- sent | logged | failed
    error       TEXT
);
"""


# Columns renamed when the agent became ERP-neutral (Zoho-specific names -> erp_*).
RENAMES = {
    "enquiries": {"zoho_mode": "erp_connector", "zoho_customer_id": "erp_customer_id", "zoho_customer_name": "erp_customer_name",
                  "zoho_estimate_id": "erp_quote_id", "zoho_estimate_number": "erp_quote_number",
                  "zoho_estimate_status": "erp_quote_status", "zoho_estimate_url": "erp_quote_url", "estimate_total": "quote_total"},
    "line_items": {"zoho_item_id": "erp_item_id", "zoho_item_name": "erp_item_name", "zoho_sku": "erp_sku"},
}
# Columns added after the first release; ALTERed into databases created by older versions.
MIGRATIONS = {
    "enquiries": {"processing_ms": "INTEGER", "source_sheet": "TEXT", "source_header_row": "INTEGER",
                  "source_mapping": "TEXT", "mapped_by": "TEXT", "contact_phone": "TEXT", "delivery_address": "TEXT",
                  "delivery_terms": "TEXT", "retry_count": "INTEGER NOT NULL DEFAULT 0", "next_retry_at": "TEXT"},
    "line_items": {"source_row": "INTEGER", "flags": "TEXT", "review_note": "TEXT"},
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(get_settings().db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        for table, columns in RENAMES.items():  # before SCHEMA so old tables keep their data under the new names
            existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            for old, new in columns.items():
                if old in existing and new not in existing:
                    conn.execute(f"ALTER TABLE {table} RENAME COLUMN {old} TO {new}")
        conn.executescript(SCHEMA)
        for table, columns in MIGRATIONS.items():
            existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            for name, sql_type in columns.items():
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")


def _row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(r) if r is not None else None


# --- generic helpers ----------------------------------------------------------

def insert(table: str, **values: Any) -> int:
    cols = ", ".join(values)
    marks = ", ".join("?" for _ in values)
    with connect() as conn:
        cur = conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(values.values()))
        return int(cur.lastrowid)


def update_enquiry(enquiry_id: int, **values: Any) -> None:
    values["updated_at"] = now_iso()
    sets = ", ".join(f"{k} = ?" for k in values)
    with connect() as conn:
        conn.execute(f"UPDATE enquiries SET {sets} WHERE id = ?", (*values.values(), enquiry_id))


def fetch_one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    with connect() as conn:
        return _row(conn.execute(sql, params).fetchone())


def fetch_all(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def execute(sql: str, params: tuple = ()) -> None:
    with connect() as conn:
        conn.execute(sql, params)


# --- domain helpers -----------------------------------------------------------

def log_event(enquiry_id: int | None, stage: str, message: str, level: str = "info") -> None:
    insert("audit_events", enquiry_id=enquiry_id, created_at=now_iso(), stage=stage, level=level, message=message)


def find_dedup(hash_: str) -> int | None:
    row = fetch_one("SELECT enquiry_id FROM dedup_hashes WHERE hash = ?", (hash_,))
    return row["enquiry_id"] if row else None


def add_dedup(hash_: str, enquiry_id: int) -> None:
    execute(
        "INSERT OR IGNORE INTO dedup_hashes (hash, enquiry_id, created_at) VALUES (?, ?, ?)",
        (hash_, enquiry_id, now_iso()),
    )


def replace_line_items(enquiry_id: int, rows: list[dict[str, Any]]) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM line_items WHERE enquiry_id = ?", (enquiry_id,))
        for r in rows:
            cols = ", ".join(["enquiry_id", *r])
            marks = ", ".join("?" for _ in range(len(r) + 1))
            conn.execute(f"INSERT INTO line_items ({cols}) VALUES ({marks})", (enquiry_id, *r.values()))


def enquiry_detail(enquiry_id: int) -> dict[str, Any] | None:
    enquiry = fetch_one("SELECT * FROM enquiries WHERE id = ?", (enquiry_id,))
    if not enquiry:
        return None
    enquiry.pop("attachment_blob", None)
    enquiry["line_items"] = fetch_all("SELECT * FROM line_items WHERE enquiry_id = ? ORDER BY line_no", (enquiry_id,))
    enquiry["exceptions"] = fetch_all("SELECT * FROM exceptions WHERE enquiry_id = ? ORDER BY id", (enquiry_id,))
    enquiry["events"] = fetch_all("SELECT * FROM audit_events WHERE enquiry_id = ? ORDER BY id", (enquiry_id,))
    enquiry["notifications"] = fetch_all("SELECT * FROM notifications WHERE enquiry_id = ? ORDER BY id", (enquiry_id,))
    enquiry["attachments"] = fetch_all("SELECT id, name, content_type, length(blob) AS size FROM attachments "
                                       "WHERE enquiry_id = ? ORDER BY id", (enquiry_id,))
    return enquiry
