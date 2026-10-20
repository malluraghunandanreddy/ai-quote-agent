"""Back up (or restore) everything the agent keeps: database, settings file, standalone files.

    .venv/bin/python scripts/backup.py                     # writes backups/quote-agent-YYYYmmdd-HHMMSS.tar.gz
    .venv/bin/python scripts/backup.py --keep 14           # …and deletes all but the 14 newest backups
    .venv/bin/python scripts/backup.py --restore FILE      # restore (stop the server first)

In Docker:  docker compose exec quote-agent python scripts/backup.py --keep 14
The database is copied with SQLite's online-backup API, so the server can keep running during a backup.
The archive contains credentials (.env) — store it somewhere access-controlled.
"""
from __future__ import annotations

import argparse
import io
import sqlite3
import sys
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.envfile import ENV_PATH  # noqa: E402


def backup_dir() -> Path:
    s = get_settings()
    return s.db_path.parent / "backups"


def make_backup(keep: int | None) -> Path:
    s = get_settings()
    target_dir = backup_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"quote-agent-{datetime.now():%Y%m%d-%H%M%S}.tar.gz"
    with tempfile.TemporaryDirectory() as tmp, tarfile.open(target, "w:gz") as tar:
        if s.db_path.exists():
            snapshot = Path(tmp) / "poc_agent.db"
            src, dst = sqlite3.connect(s.db_path), sqlite3.connect(snapshot)
            with dst:
                src.backup(dst)
            src.close()
            dst.close()
            tar.add(snapshot, arcname="poc_agent.db")
        if ENV_PATH.exists():
            tar.add(ENV_PATH, arcname=".env")
        if s.standalone_dir.exists():
            tar.add(s.standalone_dir, arcname="standalone")
        manifest = f"created={datetime.now().isoformat(timespec='seconds')}\ndb={s.db_path}\nstandalone={s.standalone_dir}\n"
        info = tarfile.TarInfo("MANIFEST")
        info.size = len(manifest)
        tar.addfile(info, io.BytesIO(manifest.encode()))
    target.chmod(0o600)
    if keep:
        for old in sorted(target_dir.glob("quote-agent-*.tar.gz"))[:-keep]:
            old.unlink()
    return target


def restore(archive: Path) -> None:
    s = get_settings()
    with tarfile.open(archive, "r:gz") as tar:
        names = tar.getnames()
        if "poc_agent.db" in names:
            s.db_path.parent.mkdir(parents=True, exist_ok=True)
            s.db_path.write_bytes(tar.extractfile("poc_agent.db").read())
            for suffix in ("-wal", "-shm"):
                Path(f"{s.db_path}{suffix}").unlink(missing_ok=True)
        if ".env" in names:
            ENV_PATH.write_bytes(tar.extractfile(".env").read())
        for m in tar.getmembers():
            if m.name.startswith("standalone/") and m.isfile():
                dest = s.standalone_dir / m.name.removeprefix("standalone/")
                if not dest.resolve().is_relative_to(s.standalone_dir.resolve()):
                    continue  # never write outside the standalone folder
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(tar.extractfile(m).read())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keep", type=int, help="keep only the N newest backups")
    parser.add_argument("--restore", type=Path, help="restore from this archive (stop the server first)")
    args = parser.parse_args()
    if args.restore:
        restore(args.restore)
        print(f"Restored from {args.restore}. Start the server again.")
    else:
        print(f"Backup written: {make_backup(args.keep)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
