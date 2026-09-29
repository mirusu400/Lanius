"""Materialized counters for views that must stay fast as captures grow.

The triggers also cover imports, deletes and direct SQL writes. A flow is
saved twice in normal capture (request, then response), so REPLACE's implicit
delete must fire its trigger; FlowStore enables recursive_triggers for that.
"""

_SITE_KEY_NEW = "COALESCE(NEW.scheme, ''), NEW.host, COALESCE(NEW.port, -1)"
_SITE_KEY_OLD = "COALESCE(OLD.scheme, ''), OLD.host, COALESCE(OLD.port, -1)"
_SITE_WHERE_OLD = (
    "scheme = COALESCE(OLD.scheme, '') AND host = OLD.host "
    "AND port = COALESCE(OLD.port, -1)"
)

_ADD = f"""
UPDATE flow_totals SET
  flows = flows + 1,
  bytes = bytes + COALESCE(NEW.request_size, 0) + COALESCE(NEW.response_size, 0),
  duration_sum = duration_sum + COALESCE(NEW.duration_ms, 0),
  duration_count = duration_count + (NEW.duration_ms IS NOT NULL),
  errors = errors + (NEW.error IS NOT NULL),
  pending = pending + (NEW.status_code IS NULL)
WHERE id = 1;
INSERT INTO flow_status_stats(bucket, flows)
  SELECT NEW.status_code / 100, 1 WHERE NEW.status_code IS NOT NULL
  ON CONFLICT(bucket) DO UPDATE SET flows = flows + 1;
INSERT INTO flow_method_stats(method, flows)
  SELECT NEW.method, 1 WHERE NEW.method IS NOT NULL
  ON CONFLICT(method) DO UPDATE SET flows = flows + 1;
INSERT INTO flow_site_stats(scheme, host, port, flows, paths, errors, bytes, last_seen)
  SELECT {_SITE_KEY_NEW}, 1,
    CASE WHEN NEW.path IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM flow_path_stats WHERE
        scheme = COALESCE(NEW.scheme, '') AND host = NEW.host
        AND port = COALESCE(NEW.port, -1) AND path = NEW.path
    ) THEN 1 ELSE 0 END,
    COALESCE(NEW.status_code >= 400, 0),
    COALESCE(NEW.request_size, 0) + COALESCE(NEW.response_size, 0),
    NEW.started_at
  WHERE NEW.host IS NOT NULL
  ON CONFLICT(scheme, host, port) DO UPDATE SET
    flows = flows + 1,
    paths = paths + excluded.paths,
    errors = errors + excluded.errors,
    bytes = bytes + excluded.bytes,
    last_seen = CASE
      WHEN last_seen IS NULL THEN excluded.last_seen
      WHEN excluded.last_seen IS NULL THEN last_seen
      ELSE MAX(last_seen, excluded.last_seen) END;
INSERT INTO flow_path_stats(scheme, host, port, path, flows)
  SELECT {_SITE_KEY_NEW}, NEW.path, 1
  WHERE NEW.host IS NOT NULL AND NEW.path IS NOT NULL
  ON CONFLICT(scheme, host, port, path) DO UPDATE SET flows = flows + 1;
"""

_REMOVE = f"""
UPDATE flow_totals SET
  flows = flows - 1,
  bytes = bytes - COALESCE(OLD.request_size, 0) - COALESCE(OLD.response_size, 0),
  duration_sum = duration_sum - COALESCE(OLD.duration_ms, 0),
  duration_count = duration_count - (OLD.duration_ms IS NOT NULL),
  errors = errors - (OLD.error IS NOT NULL),
  pending = pending - (OLD.status_code IS NULL)
WHERE id = 1;
UPDATE flow_status_stats SET flows = flows - 1
  WHERE OLD.status_code IS NOT NULL AND bucket = OLD.status_code / 100;
DELETE FROM flow_status_stats WHERE flows = 0;
UPDATE flow_method_stats SET flows = flows - 1
  WHERE OLD.method IS NOT NULL AND method = OLD.method;
DELETE FROM flow_method_stats WHERE flows = 0;
UPDATE flow_site_stats SET
  flows = flows - 1,
  paths = paths - CASE WHEN OLD.path IS NOT NULL AND (
    SELECT flows FROM flow_path_stats WHERE {_SITE_WHERE_OLD} AND path = OLD.path
  ) = 1 THEN 1 ELSE 0 END,
  errors = errors - COALESCE(OLD.status_code >= 400, 0),
  bytes = bytes - COALESCE(OLD.request_size, 0) - COALESCE(OLD.response_size, 0)
WHERE OLD.host IS NOT NULL AND {_SITE_WHERE_OLD};
UPDATE flow_site_stats SET last_seen = (
  SELECT MAX(started_at) FROM flows WHERE
    scheme IS OLD.scheme AND host = OLD.host AND port IS OLD.port
) WHERE OLD.host IS NOT NULL AND {_SITE_WHERE_OLD}
  AND last_seen = OLD.started_at;
DELETE FROM flow_site_stats WHERE flows = 0;
UPDATE flow_path_stats SET flows = flows - 1
  WHERE OLD.host IS NOT NULL AND OLD.path IS NOT NULL
    AND {_SITE_WHERE_OLD} AND path = OLD.path;
DELETE FROM flow_path_stats WHERE flows = 0;
"""

MIGRATION: tuple[str, ...] = (
    """CREATE TABLE flow_totals (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      flows INTEGER NOT NULL, bytes INTEGER NOT NULL,
      duration_sum REAL NOT NULL, duration_count INTEGER NOT NULL,
      errors INTEGER NOT NULL, pending INTEGER NOT NULL)""",
    """INSERT INTO flow_totals
      SELECT 1, COUNT(*),
        COALESCE(SUM(COALESCE(request_size, 0) + COALESCE(response_size, 0)), 0),
        COALESCE(SUM(duration_ms), 0), COUNT(duration_ms),
        COALESCE(SUM(error IS NOT NULL), 0),
        COALESCE(SUM(status_code IS NULL), 0) FROM flows""",
    "CREATE TABLE flow_status_stats (bucket INTEGER PRIMARY KEY, flows INTEGER NOT NULL)",
    """INSERT INTO flow_status_stats SELECT status_code / 100, COUNT(*)
      FROM flows WHERE status_code IS NOT NULL GROUP BY status_code / 100""",
    "CREATE TABLE flow_method_stats (method TEXT PRIMARY KEY, flows INTEGER NOT NULL)",
    """INSERT INTO flow_method_stats SELECT method, COUNT(*)
      FROM flows WHERE method IS NOT NULL GROUP BY method""",
    """CREATE TABLE flow_site_stats (
      scheme TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
      flows INTEGER NOT NULL, paths INTEGER NOT NULL, errors INTEGER NOT NULL,
      bytes INTEGER NOT NULL, last_seen REAL,
      PRIMARY KEY(scheme, host, port))""",
    """INSERT INTO flow_site_stats
      SELECT COALESCE(scheme, ''), host, COALESCE(port, -1), COUNT(*), 0,
        COALESCE(SUM(status_code >= 400), 0),
        COALESCE(SUM(COALESCE(request_size, 0) + COALESCE(response_size, 0)), 0),
        MAX(started_at)
      FROM flows WHERE host IS NOT NULL
      GROUP BY COALESCE(scheme, ''), host, COALESCE(port, -1)""",
    """CREATE TABLE flow_path_stats (
      scheme TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
      path TEXT NOT NULL, flows INTEGER NOT NULL,
      PRIMARY KEY(scheme, host, port, path))""",
    """INSERT INTO flow_path_stats
      SELECT COALESCE(scheme, ''), host, COALESCE(port, -1), path, COUNT(*)
      FROM flows WHERE host IS NOT NULL AND path IS NOT NULL
      GROUP BY COALESCE(scheme, ''), host, COALESCE(port, -1), path""",
    """UPDATE flow_site_stats SET paths = (
      SELECT COUNT(*) FROM flow_path_stats WHERE
        scheme = flow_site_stats.scheme AND host = flow_site_stats.host
        AND port = flow_site_stats.port)""",
    "CREATE INDEX idx_flows_site_started ON flows(scheme, host, port, started_at DESC)",
    "CREATE INDEX idx_flows_site_path ON flows(scheme, host, port, path, method)",
    f"CREATE TRIGGER flow_stats_insert AFTER INSERT ON flows BEGIN {_ADD} END",
    f"CREATE TRIGGER flow_stats_delete AFTER DELETE ON flows BEGIN {_REMOVE} END",
    f"CREATE TRIGGER flow_stats_update AFTER UPDATE ON flows BEGIN {_REMOVE} {_ADD} END",
)
