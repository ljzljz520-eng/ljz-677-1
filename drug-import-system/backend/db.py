import sqlite3
import threading

from paths import DB_PATH

_local = threading.local()


def get_conn():
    """线程级 SQLite 连接（WAL 模式，读写可并发）。"""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _local.conn = conn
    return conn


def init_db():
    conn = get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS tasks (
            id                 TEXT PRIMARY KEY,
            filename           TEXT,
            total_rows         INTEGER DEFAULT 0,
            status             TEXT    DEFAULT 'pending',   -- pending/running/completed/failed
            stage              TEXT    DEFAULT 'pending',   -- pending/parsing/validating/submitting/done
            processed_rows     INTEGER DEFAULT 0,
            local_valid_rows   INTEGER DEFAULT 0,
            local_error_rows   INTEGER DEFAULT 0,
            platform_submitted INTEGER DEFAULT 0,
            platform_accepted  INTEGER DEFAULT 0,
            platform_rejected  INTEGER DEFAULT 0,
            message            TEXT    DEFAULT '',
            durations          TEXT    DEFAULT '{}',
            created_at         TEXT,
            updated_at         TEXT,
            finished_at        TEXT
        );
        CREATE TABLE IF NOT EXISTS errors (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id    TEXT,
            row_no     INTEGER,
            stage      TEXT,   -- local / platform
            field      TEXT,   -- drug_code/name/spec/price/manufacturer
            error_type TEXT,
            message    TEXT,
            row_data   TEXT    -- 原始行 JSON
        );
        CREATE INDEX IF NOT EXISTS idx_errors_task  ON errors(task_id, stage, field);
        CREATE INDEX IF NOT EXISTS idx_errors_rowno ON errors(task_id, row_no);
        """
    )
    conn.commit()
