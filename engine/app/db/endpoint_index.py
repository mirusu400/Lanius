"""Materialized endpoint groups for large HTTP histories.

The per-flow key table makes endpoint detail paging indexed. Aggregate tables
keep group counts, statuses and query parameter names current on every insert,
replacement, update and delete, including imports that write SQL directly.
"""

from __future__ import annotations

import json
import sqlite3

from ..addons.endpoints import query_params, templatize


def register_functions(conn: sqlite3.Connection) -> None:
    conn.create_function(
        "lanius_endpoint_template", 1,
        lambda path: templatize(path or "/")[0], deterministic=True,
    )
    conn.create_function(
        "lanius_query_names", 1,
        lambda query: json.dumps(sorted(set(query_params(query)))),
        deterministic=True,
    )


_KEY = "scheme, host, port, method, template"
_NEW_KEY = "NEW.scheme, NEW.host, NEW.port, NEW.method, NEW.template"
_OLD_MATCH = (
    "scheme = OLD.scheme AND host = OLD.host AND port = OLD.port "
    "AND method = OLD.method AND template = OLD.template"
)

MIGRATION: tuple[str, ...] = (
    """CREATE TABLE flow_endpoint_keys (
      id TEXT PRIMARY KEY, scheme TEXT NOT NULL, host TEXT NOT NULL,
      port INTEGER NOT NULL, method TEXT NOT NULL, template TEXT NOT NULL,
      path TEXT, query TEXT, status_code INTEGER, response_size INTEGER,
      started_at REAL
    )""",
    """INSERT INTO flow_endpoint_keys
      SELECT id, COALESCE(scheme, 'http'), host, COALESCE(port, -1),
        UPPER(COALESCE(method, 'GET')), lanius_endpoint_template(path),
        path, query, status_code, response_size, started_at
      FROM flows WHERE type = 'http' AND host IS NOT NULL""",
    "CREATE INDEX idx_endpoint_keys_group ON flow_endpoint_keys"
    "(scheme, host, port, method, template, started_at DESC)",
    """CREATE TABLE flow_endpoint_stats (
      scheme TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
      method TEXT NOT NULL, template TEXT NOT NULL,
      flows INTEGER NOT NULL, last_seen REAL,
      PRIMARY KEY(scheme, host, port, method, template)
    )""",
    """INSERT INTO flow_endpoint_stats
      SELECT scheme, host, port, method, template, COUNT(*), MAX(started_at)
      FROM flow_endpoint_keys GROUP BY scheme, host, port, method, template""",
    """CREATE TABLE flow_endpoint_status_stats (
      scheme TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
      method TEXT NOT NULL, template TEXT NOT NULL,
      status_code INTEGER NOT NULL, flows INTEGER NOT NULL,
      PRIMARY KEY(scheme, host, port, method, template, status_code)
    )""",
    """INSERT INTO flow_endpoint_status_stats
      SELECT scheme, host, port, method, template, status_code, COUNT(*)
      FROM flow_endpoint_keys WHERE status_code IS NOT NULL
      GROUP BY scheme, host, port, method, template, status_code""",
    """CREATE TABLE flow_endpoint_query_stats (
      scheme TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
      method TEXT NOT NULL, template TEXT NOT NULL,
      name TEXT NOT NULL, flows INTEGER NOT NULL,
      PRIMARY KEY(scheme, host, port, method, template, name)
    )""",
    """INSERT INTO flow_endpoint_query_stats
      SELECT k.scheme, k.host, k.port, k.method, k.template,
        names.value, COUNT(*)
      FROM flow_endpoint_keys AS k, json_each(lanius_query_names(k.query)) AS names
      GROUP BY k.scheme, k.host, k.port, k.method, k.template, names.value""",
    f"""CREATE TRIGGER endpoint_key_insert AFTER INSERT ON flow_endpoint_keys BEGIN
      INSERT INTO flow_endpoint_stats({_KEY}, flows, last_seen)
        VALUES ({_NEW_KEY}, 1, NEW.started_at)
        ON CONFLICT({_KEY}) DO UPDATE SET
          flows = flows + 1,
          last_seen = CASE WHEN last_seen IS NULL THEN excluded.last_seen
            WHEN excluded.last_seen IS NULL THEN last_seen
            ELSE MAX(last_seen, excluded.last_seen) END;
      INSERT INTO flow_endpoint_status_stats({_KEY}, status_code, flows)
        SELECT {_NEW_KEY}, NEW.status_code, 1 WHERE NEW.status_code IS NOT NULL
        ON CONFLICT({_KEY}, status_code) DO UPDATE SET flows = flows + 1;
      INSERT INTO flow_endpoint_query_stats({_KEY}, name, flows)
        SELECT {_NEW_KEY}, value, 1
        FROM json_each(lanius_query_names(NEW.query)) WHERE 1
        ON CONFLICT({_KEY}, name) DO UPDATE SET flows = flows + 1;
    END""",
    f"""CREATE TRIGGER endpoint_key_delete AFTER DELETE ON flow_endpoint_keys BEGIN
      UPDATE flow_endpoint_stats SET flows = flows - 1 WHERE {_OLD_MATCH};
      UPDATE flow_endpoint_stats SET last_seen = (
        SELECT MAX(started_at) FROM flow_endpoint_keys WHERE {_OLD_MATCH}
      ) WHERE {_OLD_MATCH} AND last_seen IS OLD.started_at;
      DELETE FROM flow_endpoint_stats WHERE {_OLD_MATCH} AND flows = 0;
      UPDATE flow_endpoint_status_stats SET flows = flows - 1
        WHERE {_OLD_MATCH} AND status_code = OLD.status_code;
      DELETE FROM flow_endpoint_status_stats
        WHERE {_OLD_MATCH} AND status_code = OLD.status_code AND flows = 0;
      UPDATE flow_endpoint_query_stats SET flows = flows - 1
        WHERE {_OLD_MATCH} AND name IN (
          SELECT value FROM json_each(lanius_query_names(OLD.query))
        );
      DELETE FROM flow_endpoint_query_stats WHERE {_OLD_MATCH} AND flows = 0
        AND name IN (SELECT value FROM json_each(lanius_query_names(OLD.query)));
    END""",
    """CREATE TRIGGER endpoint_flow_insert AFTER INSERT ON flows BEGIN
      INSERT INTO flow_endpoint_keys
        SELECT NEW.id, COALESCE(NEW.scheme, 'http'), NEW.host,
          COALESCE(NEW.port, -1), UPPER(COALESCE(NEW.method, 'GET')),
          lanius_endpoint_template(NEW.path), NEW.path, NEW.query,
          NEW.status_code, NEW.response_size, NEW.started_at
        WHERE NEW.type = 'http' AND NEW.host IS NOT NULL;
    END""",
    """CREATE TRIGGER endpoint_flow_delete AFTER DELETE ON flows BEGIN
      DELETE FROM flow_endpoint_keys WHERE id = OLD.id;
    END""",
    """CREATE TRIGGER endpoint_flow_update AFTER UPDATE ON flows BEGIN
      DELETE FROM flow_endpoint_keys WHERE id = OLD.id;
      INSERT INTO flow_endpoint_keys
        SELECT NEW.id, COALESCE(NEW.scheme, 'http'), NEW.host,
          COALESCE(NEW.port, -1), UPPER(COALESCE(NEW.method, 'GET')),
          lanius_endpoint_template(NEW.path), NEW.path, NEW.query,
          NEW.status_code, NEW.response_size, NEW.started_at
        WHERE NEW.type = 'http' AND NEW.host IS NOT NULL;
    END""",
)
