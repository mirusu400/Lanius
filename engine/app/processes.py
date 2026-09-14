"""Running processes, for choosing what to capture.

The redirector matches on substrings of the executable path, so a user
picking from a list beats typing a name and hoping. mitmproxy_rs exposes
the same process table it uses for matching, so what is listed here is
exactly what a rule can match.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def list_processes(visible_only: bool = False) -> list[dict[str, Any]]:
    """Executables currently running.

    ``visible_only`` keeps the handful with a user interface, which is
    what someone picking "capture Slack" is looking for; the full list
    includes background helpers and is long.
    """
    try:
        from mitmproxy_rs.process_info import active_executables
    except ImportError:  # pragma: no cover - mitmproxy_rs is a dependency
        return []

    try:
        found = active_executables()
    except Exception as exc:  # pragma: no cover - platform dependent
        logger.warning("could not list processes: %s", exc)
        return []

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for process in found:
        executable = str(process.executable)
        # The same binary appears once per running instance.
        if executable in seen:
            continue
        seen.add(executable)
        visible = bool(process.is_visible)
        if visible_only and not visible:
            continue
        items.append(
            {
                "name": process.display_name,
                "path": executable,
                "visible": visible,
                "system": bool(process.is_system),
            }
        )
    items.sort(key=lambda item: (not item["visible"], item["name"].lower()))
    return items
