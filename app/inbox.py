"""Monitored-inbox polling over IMAP (Zoho Mail: imappro.zoho.in:993)."""
from __future__ import annotations

import email
import imaplib
from email import policy

from .config import get_settings
from .email_parser import is_agent_generated, parse_eml
from .schemas import RawEnquiry


def fetch_unseen(limit: int = 20) -> tuple[list[RawEnquiry], int]:
    """Return (new enquiries, skipped count). Messages are marked \\Seen once read."""
    s = get_settings()
    enquiries: list[RawEnquiry] = []
    skipped = 0
    with imaplib.IMAP4_SSL(s.imap_host, s.imap_port, timeout=30) as imap:
        imap.login(s.imap_user, s.imap_password)
        imap.select(s.imap_folder)
        _, data = imap.uid("search", None, "UNSEEN")
        uids = data[0].split()[:limit] if data and data[0] else []
        for uid in uids:
            _, msg_data = imap.uid("fetch", uid, "(BODY.PEEK[])")
            raw_bytes = next((part[1] for part in msg_data if isinstance(part, tuple)), None)
            if raw_bytes is None:
                continue
            msg = email.message_from_bytes(raw_bytes, policy=policy.default)
            if is_agent_generated(msg):
                skipped += 1  # our own notification/alert landing in the same mailbox
            else:
                enquiries.append(parse_eml(raw_bytes, source="imap"))
            imap.uid("store", uid, "+FLAGS", "(\\Seen)")
    return enquiries, skipped


def check() -> str:
    s = get_settings()
    with imaplib.IMAP4_SSL(s.imap_host, s.imap_port, timeout=20) as imap:
        imap.login(s.imap_user, s.imap_password)
        _, data = imap.select(s.imap_folder, readonly=True)
        _, unseen = imap.search(None, "UNSEEN")
        n_unseen = len(unseen[0].split()) if unseen and unseen[0] else 0
        return f"Logged in to {s.imap_user}; {s.imap_folder} has {int(data[0])} messages ({n_unseen} unread)"
