"""Durable local fingerprint evidence and retry queue (SQLite, stdlib only)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterable
from contextlib import contextmanager


HASH_LENGTH = 64


def _connect(path: str | Path) -> sqlite3.Connection:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(target, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        """CREATE TABLE IF NOT EXISTS transmission_queue (
            id INTEGER PRIMARY KEY,
            driver_id TEXT NOT NULL,
            video_name TEXT NOT NULL,
            frame_number INTEGER NOT NULL,
            payload TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            UNIQUE(driver_id, video_name, frame_number)
        )"""
    )
    return connection


@contextmanager
def _database(path: str | Path):
    connection = _connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def enqueue_records(path: str | Path, records: Iterable[dict]) -> int:
    """Durably add records; repeated submissions are ignored by evidence identity."""
    rows = [
        (str(r["driver_id"]), str(r["video_name"]), int(r["frame_number"]),
         json.dumps(r, separators=(",", ":")))
        for r in records
    ]
    with _database(path) as db:
        before = db.total_changes
        db.executemany(
            "INSERT OR IGNORE INTO transmission_queue(driver_id,video_name,frame_number,payload) VALUES(?,?,?,?)",
            rows,
        )
        return db.total_changes - before


def pending_records(path: str | Path, limit: int = 200) -> list[dict]:
    with _database(path) as db:
        rows = db.execute(
            "SELECT payload FROM transmission_queue ORDER BY id LIMIT ?", (limit,)
        ).fetchall()
    return [json.loads(row["payload"]) for row in rows]


def mark_sent(path: str | Path, records: Iterable[dict]) -> None:
    keys = [(str(r["driver_id"]), str(r["video_name"]), int(r["frame_number"])) for r in records]
    with _database(path) as db:
        db.executemany(
            "DELETE FROM transmission_queue WHERE driver_id=? AND video_name=? AND frame_number=?",
            keys,
        )


def record_failure(path: str | Path, records: Iterable[dict], error: str) -> None:
    keys = [(str(r["driver_id"]), str(r["video_name"]), int(r["frame_number"]), str(error)[:500]) for r in records]
    with _database(path) as db:
        db.executemany(
            "UPDATE transmission_queue SET attempts=attempts+1,last_error=? WHERE driver_id=? AND video_name=? AND frame_number=?",
            [(err, driver, video, frame) for driver, video, frame, err in keys],
        )


def queue_size(path: str | Path) -> int:
    with _database(path) as db:
        return int(db.execute("SELECT count(*) FROM transmission_queue").fetchone()[0])


def retry_pending(path: str | Path, sender, limit: int = 200) -> int:
    """Send one durable batch; retain and annotate it on every failure."""
    batch = pending_records(path, limit)
    if not batch:
        return 0
    try:
        sender(batch)
    except Exception as exc:
        record_failure(path, batch, str(exc))
        return 0
    mark_sent(path, batch)
    return len(batch)


def save_fingerprint_txt(path: str | Path, records: Iterable[dict]) -> Path:
    """Write both a plain one-hash-per-line evidence file and a metadata sidecar."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    rows = list(records)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            value = str(row.get("fingerprint", "")).strip().lower()
            if len(value) == HASH_LENGTH and all(c in "0123456789abcdef" for c in value):
                handle.write(value + "\n")
    sidecar = target.with_suffix(target.suffix + ".json")
    sidecar.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    return target


def load_fingerprint_txt(path: str | Path) -> list[str]:
    """Load bare hashes or the legacy 'frame | hash | timestamp' TXT format."""
    target = Path(path)
    hashes: list[str] = []
    for line in target.read_text(encoding="utf-8-sig").splitlines():
        candidate = line.strip().split("|")
        value = (candidate[1] if len(candidate) > 1 else candidate[0]).strip().lower()
        if len(value) == HASH_LENGTH and all(c in "0123456789abcdef" for c in value):
            hashes.append(value)
    return hashes
