"""Classify email attachments and pull text out of Word files (no extra dependency: .docx is zipped XML)."""
from __future__ import annotations

import io
import re
import zipfile
from xml.etree import ElementTree

SHEET_EXT = (".xlsx", ".xlsm", ".xls", ".csv")
IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
MAX_AI_FILE_BYTES = 15 * 1024 * 1024
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def kind(filename: str) -> str | None:
    """sheet | pdf | image | docx | None (ignored, e.g. signatures, .ics, zip)."""
    name = (filename or "").lower()
    if name.endswith(SHEET_EXT):
        return "sheet"
    if name.endswith(".pdf"):
        return "pdf"
    if name.endswith(tuple(IMAGE_MIME)):
        return "image"
    if name.endswith(".docx"):
        return "docx"
    return None


def mime(filename: str) -> str:
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        return "application/pdf"
    return next((m for ext, m in IMAGE_MIME.items() if name.endswith(ext)), "application/octet-stream")


def docx_text(data: bytes) -> str:
    """Paragraphs as lines; table rows as 'cell | cell | cell' so item tables survive."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        root = ElementTree.fromstring(z.read("word/document.xml"))
    body = root.find(f"{W}body")
    lines: list[str] = []

    def text_of(el) -> str:
        return "".join(t.text or "" for t in el.iter(f"{W}t")).strip()

    for block in body if body is not None else []:
        if block.tag == f"{W}p":
            lines.append(text_of(block))
        elif block.tag == f"{W}tbl":
            for row in block.iter(f"{W}tr"):
                cells = [text_of(c) for c in row.iter(f"{W}tc")]
                lines.append(" | ".join(cells))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
