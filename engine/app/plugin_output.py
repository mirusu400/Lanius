"""Attribute Python text output to the plugin currently being executed.

Plugins share the engine process, so temporarily replacing ``sys.stdout`` for
one callback would also steal output from unrelated asyncio tasks.  The
routers below stay installed and use a context variable to decide whether a
write belongs to a plugin.  Writes outside a managed plugin context are passed
through unchanged.
"""

from __future__ import annotations

import contextlib
import contextvars
import sys
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any, TextIO

OutputSink = Callable[[str, str, str], None]
_PARTIAL_LINE_LIMIT = 16 * 1024


@dataclass(slots=True)
class _OutputTarget:
    owner: str
    sink: OutputSink
    buffers: dict[str, str] = field(default_factory=dict)
    lock: threading.RLock = field(default_factory=threading.RLock)
    active: bool = True

    def write(self, source: str, value: str) -> bool:
        if not value:
            return True
        level = "error" if source == "stderr" else "info"
        with self.lock:
            if not self.active:
                return False
            pending = self.buffers.get(source, "") + value
            while "\n" in pending:
                line, pending = pending.split("\n", 1)
                if line.endswith("\r"):
                    line = line[:-1]
                if line:
                    self.sink(source, level, line)
            while len(pending) > _PARTIAL_LINE_LIMIT:
                self.sink(source, level, pending[:_PARTIAL_LINE_LIMIT])
                pending = pending[_PARTIAL_LINE_LIMIT:]
            self.buffers[source] = pending
        return True

    def flush(self, source: str | None = None) -> bool:
        with self.lock:
            if not self.active:
                return False
            self._flush_locked(source)
        return True

    def deactivate(self) -> None:
        """Flush this execution and make inherited stale contexts harmless."""

        with self.lock:
            if not self.active:
                return
            self._flush_locked()
            self.active = False

    def _flush_locked(self, source: str | None = None) -> None:
        sources = (source,) if source else tuple(self.buffers)
        for current in sources:
            pending = self.buffers.pop(current, "")
            if pending:
                level = "error" if current == "stderr" else "info"
                self.sink(current, level, pending)


_current_output: contextvars.ContextVar[_OutputTarget | None] = (
    contextvars.ContextVar("lanius_current_plugin_output", default=None)
)


class _RoutedTextIO:
    """A small TextIO proxy that preserves the original stream interface."""

    def __init__(self, fallback: TextIO, source: str) -> None:
        self.fallback = fallback
        self.source = source

    def write(self, value: str) -> int:
        target = _current_output.get()
        if target is None or not target.write(self.source, value):
            return self.fallback.write(value)
        return len(value)

    def flush(self) -> None:
        target = _current_output.get()
        if target is None or not target.flush(self.source):
            self.fallback.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self.fallback, name)


_install_lock = threading.Lock()


def install_output_routers() -> None:
    """Install idempotent stdout/stderr routers around the current streams."""

    global_stdout = sys.stdout
    global_stderr = sys.stderr
    with _install_lock:
        if not isinstance(global_stdout, _RoutedTextIO):
            sys.stdout = _RoutedTextIO(global_stdout, "stdout")  # type: ignore[assignment]
        if not isinstance(global_stderr, _RoutedTextIO):
            sys.stderr = _RoutedTextIO(global_stderr, "stderr")  # type: ignore[assignment]


@contextlib.contextmanager
def capture_plugin_output(owner: str, sink: OutputSink) -> Iterator[None]:
    """Route Python text output in this context to ``sink``.

    Asyncio tasks and ``asyncio.to_thread`` copy context variables, so managed
    plugin work keeps its owner without changing process-global streams for a
    single invocation.
    """

    current = _current_output.get()
    if current is not None and current.active and current.owner == owner:
        yield
        return
    target = _OutputTarget(owner, sink)
    token = _current_output.set(target)
    try:
        yield
    finally:
        target.deactivate()
        _current_output.reset(token)
