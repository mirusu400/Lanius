"""Body-free history rows, kept in sync by SQLite triggers.

Selecting scalar columns after a large BLOB can still traverse its overflow
pages. Keep list data in its own small table so history never reads bodies.
"""

FIELDS = {
    "id": "TEXT NOT NULL UNIQUE",
    "type": "TEXT",
    "client_addr": "TEXT", "server_addr": "TEXT", "local_source_ip": "TEXT",
    "scheme": "TEXT", "method": "TEXT", "host": "TEXT", "port": "INTEGER",
    "path": "TEXT", "query": "TEXT", "http_version": "TEXT",
    "request_size": "INTEGER", "started_at": "REAL", "status_code": "INTEGER",
    "reason": "TEXT", "response_size": "INTEGER", "response_mime": "TEXT",
    "completed_at": "REAL", "duration_ms": "REAL", "error": "TEXT",
    "source": "TEXT", "comment": "TEXT", "auto_modified": "INTEGER", "modified": "INTEGER",
}

_COLUMNS = ", ".join(FIELDS)
_NEW = ", ".join(f"NEW.{name}" for name in FIELDS)
_INSERT = f"INSERT INTO flow_history(rowid, {_COLUMNS}) VALUES (NEW.rowid, {_NEW});"

MIGRATION = (
    "CREATE TABLE flow_history (history_rowid INTEGER PRIMARY KEY, "
    + ", ".join(f"{name} {kind}" for name, kind in FIELDS.items()) + ")",
    f"INSERT INTO flow_history(rowid, {_COLUMNS}) SELECT rowid, {_COLUMNS} FROM flows",
    "CREATE INDEX idx_flow_history_started ON flow_history(started_at DESC, history_rowid DESC)",
    "CREATE INDEX idx_flow_history_method ON flow_history(method, started_at DESC, history_rowid DESC)",
    "CREATE INDEX idx_flow_history_status ON flow_history(status_code, started_at DESC, history_rowid DESC)",
    f"CREATE TRIGGER flow_history_insert AFTER INSERT ON flows BEGIN {_INSERT} END",
    "CREATE TRIGGER flow_history_delete AFTER DELETE ON flows BEGIN "
    "DELETE FROM flow_history WHERE rowid = OLD.rowid; END",
    "CREATE TRIGGER flow_history_update AFTER UPDATE ON flows BEGIN "
    f"DELETE FROM flow_history WHERE rowid = OLD.rowid; {_INSERT} END",
)
