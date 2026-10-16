"""Startup stages for the desktop shell, as marked lines on stdout.

Opening a large project can take a while, and a window that shows nothing
for that long reads as a hang. The shell sets ``LANIUS_STARTUP_PROGRESS=1``
and turns these lines into the status text under its spinner. Standalone
runs leave the variable unset and print nothing.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

MARKER = "LANIUS_STARTUP "


def report(stage: str, **data: Any) -> None:
    if os.environ.get("LANIUS_STARTUP_PROGRESS") != "1":
        return
    try:
        sys.stdout.write(MARKER + json.dumps({"stage": stage, **data}) + "\n")
        sys.stdout.flush()
    except (OSError, ValueError):  # pragma: no cover - closed stdout
        pass
