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

# Keep v12's schema unchanged so existing SQLite backups remain recognizable.
_MEDIA_COLUMNS = _COLUMNS + ", request_body_omitted, response_body_omitted"
_MEDIA_NEW = _NEW + ", NEW.request_body_omitted, NEW.response_body_omitted"
_MEDIA_INSERT = f"INSERT INTO flow_history(rowid, {_MEDIA_COLUMNS}) VALUES (NEW.rowid, {_MEDIA_NEW});"
MEDIA_MIGRATION = (
    "ALTER TABLE flows ADD COLUMN request_body_omitted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE flows ADD COLUMN response_body_omitted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE flow_history ADD COLUMN request_body_omitted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE flow_history ADD COLUMN response_body_omitted INTEGER NOT NULL DEFAULT 0",
    "DROP TRIGGER flow_history_insert",
    "DROP TRIGGER flow_history_update",
    f"CREATE TRIGGER flow_history_insert AFTER INSERT ON flows BEGIN {_MEDIA_INSERT} END",
    "CREATE TRIGGER flow_history_update AFTER UPDATE ON flows BEGIN "
    f"DELETE FROM flow_history WHERE rowid = OLD.rowid; {_MEDIA_INSERT} END",
)

# Keep request numbers stable across sorting, paging, deletion and restarts.
# The one-row sequence table deliberately survives History > Clear, so a
# number that appeared in an audit trail is never assigned to another request.
_NUMBER_COLUMNS = _MEDIA_COLUMNS + ", request_number"
_NUMBER_NEW = _MEDIA_NEW + ", NEW.request_number"
_NUMBER_INSERT = (
    f"INSERT INTO flow_history(rowid, {_NUMBER_COLUMNS}) "
    f"VALUES (NEW.rowid, {_NUMBER_NEW});"
)
REQUEST_NUMBER_MIGRATION = (
    "ALTER TABLE flows ADD COLUMN request_number INTEGER",
    "UPDATE flows SET request_number = rowid",
    "CREATE UNIQUE INDEX idx_flows_request_number ON flows(request_number) "
    "WHERE request_number IS NOT NULL",
    "ALTER TABLE flow_history ADD COLUMN request_number INTEGER",
    "UPDATE flow_history SET request_number = history_rowid",
    "CREATE TABLE flow_request_sequence ("
    "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), "
    "next_value INTEGER NOT NULL CHECK (next_value >= 1))",
    "INSERT INTO flow_request_sequence(singleton, next_value) "
    "SELECT 1, COALESCE(MAX(request_number), 0) + 1 FROM flows",
    "DROP TRIGGER flow_history_insert",
    "DROP TRIGGER flow_history_update",
    f"CREATE TRIGGER flow_history_insert AFTER INSERT ON flows BEGIN {_NUMBER_INSERT} END",
    "CREATE TRIGGER flow_history_update AFTER UPDATE ON flows BEGIN "
    f"DELETE FROM flow_history WHERE rowid = OLD.rowid; {_NUMBER_INSERT} END",
)
