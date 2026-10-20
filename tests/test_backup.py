"""Backup → wipe → restore brings back the database, settings file and standalone files."""
import importlib.util
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_backup_module(monkeypatch, isolated):
    spec = importlib.util.spec_from_file_location("backup_script", ROOT / "scripts" / "backup.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "ENV_PATH", isolated / ".env")
    return mod


def test_backup_and_restore(monkeypatch, isolated):
    from app import db
    db.insert("enquiries", created_at=db.now_iso(), updated_at=db.now_iso(), source="test", status="DRAFT_CREATED",
              subject="keep me")
    (isolated / ".env").write_text("ADMIN_USER=admin\nMARKER=1\n")
    bk = load_backup_module(monkeypatch, isolated)
    archive = bk.make_backup(keep=2)
    assert archive.exists() and oct(archive.stat().st_mode)[-3:] == "600"
    names = tarfile.open(archive).getnames()
    assert {"poc_agent.db", ".env", "MANIFEST"} <= set(names) and any(n.startswith("standalone/") for n in names)

    db.execute("DELETE FROM enquiries")
    (isolated / ".env").write_text("broken\n")
    (isolated / "standalone" / "price_list.xlsx").unlink()
    bk.restore(archive)
    assert db.fetch_one("SELECT subject FROM enquiries")["subject"] == "keep me"
    assert "MARKER=1" in (isolated / ".env").read_text()
    assert (isolated / "standalone" / "price_list.xlsx").exists()


def test_keep_prunes_old_backups(monkeypatch, isolated):
    bk = load_backup_module(monkeypatch, isolated)
    folder = bk.backup_dir()
    folder.mkdir(parents=True, exist_ok=True)
    for i in range(5):
        (folder / f"quote-agent-2026010{i}-000000.tar.gz").write_bytes(b"x")
    bk.make_backup(keep=3)
    assert len(list(folder.glob("quote-agent-*.tar.gz"))) == 3
