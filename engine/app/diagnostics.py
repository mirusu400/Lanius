"""Error reports, and the bundle a user can hand to the developer.

When something breaks, the traceback is the most useful thing a bug report
can carry, and it is usually gone by the time anyone asks for it. Reports
are written to a local directory as they happen: by the engine, by the
desktop shell's panic hook and by the UI, which posts what it caught.

Nothing here sends anything anywhere. The user saves a bundle and attaches
it to an issue themselves. A proxy's logs are full of other people's hosts,
cookies and tokens, so everything that leaves this module is redacted, and
the preview the UI shows is the same redacted text the bundle contains.
"""

from __future__ import annotations

import collections
import datetime
import hashlib
import io
import json
import logging
import os
import platform
import re
import sys
import threading
import time
import traceback
import uuid
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from . import __version__

LOG_DIR_ENV = "LANIUS_LOG_DIR"
ENGINE_LOG_ENV = "LANIUS_ENGINE_LOG"
SHELL_LOG_ENV = "LANIUS_SHELL_LOG"

ISSUE_URL = "https://github.com/mirusu400/Lanius/issues/new"
# Reports beyond this are pruned, oldest first.
MAX_REPORTS = 50
# One runaway message must not fill the disk or the bundle.
MAX_FIELD_CHARS = 32_000
RECENT_LOG_LINES = 1000
LOG_TAIL_BYTES = 512 * 1024
# The same UI error tends to fire on every render.
DUPLICATE_WINDOW_SECONDS = 60.0
SOURCES = frozenset({"engine", "shell", "ui"})

logger = logging.getLogger(__name__)

# --- redaction ---------------------------------------------------------------

_SECRET_NAMES = (
    r"authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key"
    r"|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|session(?:id)?"
)
_REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    # A header line: everything after the colon is the secret.
    (re.compile(rf"(?im)^(\s*[\w-]*(?:{_SECRET_NAMES})\s*:\s*).+$"), r"\1<redacted>"),
    # A header as a Python or JSON pair: ('cookie', 'a=b; c=d').
    (
        re.compile(rf"""(?i)(['"](?:{_SECRET_NAMES})['"]\s*[:,]\s*)(['"]).*?(?<!\\)\2"""),
        r"\1\2<redacted>\2",
    ),
    # key=value in queries, forms and log messages.
    (re.compile(rf"(?i)\b([\w-]*(?:{_SECRET_NAMES})\s*=\s*)[^\s&;,'\"]+"), r"\1<redacted>"),
    (re.compile(r"(?i)\b(bearer|basic|digest)\s+[a-z0-9._~+/=-]{6,}"), r"\1 <redacted>"),
    # Captured URLs name the target. Loopback ones are the app itself.
    (
        re.compile(
            r"(?i)\b[a-z][a-z0-9+.-]*://(?!(?:127\.0\.0\.1|localhost|\[::1\])[:/\s'\"]|"
            r"(?:127\.0\.0\.1|localhost)$)[^\s'\"<>()\[\]{}]+"
        ),
        "<url>",
    ),
    (re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"), "<email>"),
    (
        re.compile(
            r"(?<![\w.])(?!127\.0\.0\.1(?![\d.]))(?!0\.0\.0\.0(?![\d.]))"
            r"(?:\d{1,3}\.){3}\d{1,3}(?![\w.])"
        ),
        "<ip>",
    ),
]


def redact(text: str) -> str:
    """Remove what identifies the user, their targets or their credentials."""
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    home = str(Path.home())
    if len(home) > 1:
        text = text.replace(home, "~")
    return text


def _clip(value: object) -> str:
    text = value if isinstance(value, str) else str(value)
    if len(text) > MAX_FIELD_CHARS:
        return text[:MAX_FIELD_CHARS] + "\n... (truncated)"
    return text


def _redacted_report(report: dict[str, Any]) -> dict[str, Any]:
    out = dict(report)
    for key in ("message", "traceback", "kind"):
        if isinstance(out.get(key), str):
            out[key] = redact(out[key])
    if isinstance(out.get("context"), dict):
        out["context"] = json.loads(redact(json.dumps(out["context"])))
    return out


# --- recent log --------------------------------------------------------------


class RecentLog(logging.Handler):
    """The last lines the engine logged, for a run without a log file."""

    def __init__(self, capacity: int = RECENT_LOG_LINES) -> None:
        super().__init__(level=logging.INFO)
        self.lines: collections.deque[str] = collections.deque(maxlen=capacity)
        self.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
        )

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.lines.append(self.format(record))
        except Exception:  # pragma: no cover - logging must never raise
            pass

    def text(self) -> str:
        return "\n".join(self.lines)


_recent_log = RecentLog()


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


# --- reports -----------------------------------------------------------------


class Diagnostics:
    def __init__(
        self,
        log_dir: Path,
        *,
        engine_log: Path | None = None,
        shell_log: Path | None = None,
    ) -> None:
        self.log_dir = Path(log_dir)
        self.reports_dir = self.log_dir / "reports"
        self.engine_log = engine_log
        self.shell_log = shell_log
        self._lock = threading.Lock()
        self._recent: dict[str, float] = {}

    @classmethod
    def from_env(cls, data_dir: Path) -> "Diagnostics":
        def path(name: str) -> Path | None:
            raw = os.environ.get(name, "").strip()
            return Path(raw) if raw else None

        return cls(
            path(LOG_DIR_ENV) or Path(data_dir) / "logs",
            engine_log=path(ENGINE_LOG_ENV),
            shell_log=path(SHELL_LOG_ENV),
        )

    def record(
        self,
        source: str,
        kind: str,
        message: str,
        trace: str = "",
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Write one report. ``None`` when it repeats one written just now."""
        report = {
            "id": uuid.uuid4().hex[:12],
            "source": source if source in SOURCES else "engine",
            "time": _now(),
            "version": __version__,
            "kind": _clip(kind)[:200],
            "message": _clip(message),
            "traceback": _clip(trace),
            "context": context or {},
        }
        fingerprint = hashlib.sha256(
            f"{report['source']}\0{report['kind']}\0{report['message']}\0{report['traceback']}".encode()
        ).hexdigest()
        now = time.monotonic()
        with self._lock:
            self._recent = {
                key: seen for key, seen in self._recent.items()
                if now - seen < DUPLICATE_WINDOW_SECONDS
            }
            if fingerprint in self._recent:
                return None
            self._recent[fingerprint] = now
            try:
                self._write(report)
            except OSError:
                # A full or read-only disk must not turn one error into two.
                logger.warning("could not write an error report", exc_info=True)
                return None
        return report

    def record_exception(
        self,
        source: str,
        error: BaseException,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        return self.record(
            source,
            type(error).__name__,
            str(error),
            "".join(traceback.format_exception(type(error), error, error.__traceback__)),
            context,
        )

    def _write(self, report: dict[str, Any]) -> None:
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        if os.name == "posix":
            os.chmod(self.reports_dir, 0o700)
        # Named by a fixed-width nanosecond clock so names sort by age. The
        # shell's panic hook names its reports the same way.
        path = self.reports_dir / f"{time.time_ns():020d}-{report['source']}-{report['id']}.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
        for stale in self._files()[MAX_REPORTS:]:
            stale.unlink(missing_ok=True)

    def _files(self) -> list[Path]:
        """Report files, newest first."""
        try:
            files = [p for p in self.reports_dir.glob("*.json") if p.is_file()]
        except OSError:
            return []
        return sorted(files, key=lambda p: p.name, reverse=True)

    def reports(self, limit: int = MAX_REPORTS) -> list[dict[str, Any]]:
        """Recorded reports, newest first, redacted as they would be sent."""
        out = []
        for path in self._files()[:limit]:
            try:
                report = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(report, dict):
                out.append(_redacted_report(report))
        return out

    def clear(self) -> int:
        removed = 0
        for path in self._files():
            try:
                path.unlink()
                removed += 1
            except OSError:
                pass
        return removed

    # --- bundle --------------------------------------------------------------

    def _log_tail(self, path: Path | None) -> str | None:
        if path is None:
            return None
        try:
            with path.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - LOG_TAIL_BYTES))
                data = handle.read()
        except OSError:
            return None
        text = data.decode("utf-8", errors="replace")
        if size > LOG_TAIL_BYTES:
            # Drop the partial first line.
            text = text.split("\n", 1)[-1]
        return text

    def bundle(self, state: dict[str, Any]) -> bytes:
        """A zip of everything a bug report needs, redacted."""
        files: dict[str, str] = {
            "README.txt": (
                "Lanius diagnostic bundle\n\n"
                "Attach this file to an issue at "
                "https://github.com/mirusu400/Lanius/issues\n\n"
                "Captured requests, responses and project data are not included.\n"
                "URLs, IP addresses, e-mail addresses, cookies, tokens and the home\n"
                "directory have been replaced with placeholders. Review the files\n"
                "before sharing if your environment is sensitive.\n"
            ),
            "state.json": redact(json.dumps(
                {"created_at": _now(), "system": system_info(), **state},
                indent=2, ensure_ascii=False, default=str,
            )),
            "reports.json": json.dumps(self.reports(), indent=2, ensure_ascii=False),
            "logs/recent.log": redact(_recent_log.text()),
        }
        for name, path in (("logs/engine.log", self.engine_log), ("logs/shell.log", self.shell_log)):
            tail = self._log_tail(path)
            if tail:
                files[name] = redact(tail)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, text in files.items():
                archive.writestr(name, text)
        return buffer.getvalue()

    def issue_url(self, about: dict[str, Any], shell: str | None = None) -> str:
        """A new-issue page with the build and the latest error filled in."""
        reports = self.reports(limit=1)
        lines = [
            "## What happened",
            "",
            "<!-- Describe what you were doing when the error occurred. -->",
            "",
            "## Environment",
            "",
            f"- Lanius {about.get('version')} "
            f"({about.get('release') or 'development build'})",
        ]
        if about.get("commit_short"):
            lines.append(f"- Commit {about['commit_short']}{' (modified)' if about.get('dirty') else ''}")
        if shell:
            lines.append(f"- Desktop shell {shell}")
        lines.append(f"- {platform.system()} {platform.release()} ({platform.machine()})")
        title = "Bug report"
        if reports:
            latest = reports[0]
            summary = f"{latest['kind']}: {latest['message']}".strip(": ")
            first_line = summary.splitlines()[0] if summary else latest["kind"]
            title = f"[{latest['source']}] {first_line}"[:120]
            lines += [
                "",
                "## Latest error",
                "",
                "```",
                _clip(summary)[:1500],
                "```",
            ]
        lines += [
            "",
            "## Diagnostic bundle",
            "",
            "<!-- Drag the lanius-diagnostics zip saved from Settings > About here. -->",
        ]
        return f"{ISSUE_URL}?{urlencode({'title': title, 'body': chr(10).join(lines)})}"


def system_info() -> dict[str, Any]:
    info: dict[str, Any] = {
        "engine_version": __version__,
        "python": sys.version.split()[0],
        "implementation": platform.python_implementation(),
        "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "frozen": bool(getattr(sys, "frozen", False)),
        "utc_offset_minutes": int(
            (datetime.datetime.now().astimezone().utcoffset() or datetime.timedelta()).total_seconds()
            // 60
        ),
    }
    try:
        import sqlite3

        info["sqlite"] = sqlite3.sqlite_version
    except Exception:  # pragma: no cover
        pass
    try:
        from mitmproxy import version as mitm_version

        info["mitmproxy"] = mitm_version.VERSION
    except Exception:
        info["mitmproxy"] = None
    return info


# --- hooks -------------------------------------------------------------------

_active: Diagnostics | None = None
_hooks_installed = False


def install(diagnostics: Diagnostics) -> None:
    """Route uncaught errors and recent log lines to ``diagnostics``.

    The process hooks are installed once and follow the latest instance, so
    an app rebuilt in the same process (tests, a project switch) does not
    stack hooks.
    """
    global _active, _hooks_installed
    _active = diagnostics
    root = logging.getLogger()
    if _recent_log not in root.handlers:
        root.addHandler(_recent_log)
    if _hooks_installed:
        return
    _hooks_installed = True
    previous_excepthook = sys.excepthook
    previous_threadhook = threading.excepthook

    def excepthook(kind: type[BaseException], error: BaseException, tb: Any) -> None:
        if _active is not None and not issubclass(kind, KeyboardInterrupt):
            _active.record(
                "engine", kind.__name__, str(error),
                "".join(traceback.format_exception(kind, error, tb)),
                {"where": "uncaught"},
            )
        previous_excepthook(kind, error, tb)

    def threadhook(args: threading.ExceptHookArgs) -> None:
        if _active is not None and args.exc_value is not None:
            _active.record(
                "engine", args.exc_type.__name__, str(args.exc_value),
                "".join(traceback.format_exception(
                    args.exc_type, args.exc_value, args.exc_traceback
                )),
                {"where": "thread", "thread": getattr(args.thread, "name", None)},
            )
        previous_threadhook(args)

    sys.excepthook = excepthook
    threading.excepthook = threadhook


def install_loop_handler(diagnostics: Diagnostics) -> None:
    """Record exceptions nobody awaited on the running event loop."""
    import asyncio

    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()

    def handler(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        error = context.get("exception")
        where = {"where": "event loop", "detail": str(context.get("message", ""))[:500]}
        if isinstance(error, BaseException):
            diagnostics.record_exception("engine", error, where)
        if previous is not None:
            previous(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handler)
