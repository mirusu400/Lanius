"""Run the Lanius MCP server over stdio.

Read-only by default: it reads the project database directly, so it can run
alongside (or without) the GUI engine.

    python -m app.mcp            # stdio server for an MCP client
"""

from __future__ import annotations

import argparse
import asyncio
import logging

from ..config import Settings
from ..db.store import FlowStore
from .server import build_server


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="lanius-mcp")
    parser.add_argument("--db", default=None, help="project database path")
    parser.add_argument("--log-level", default="warning")
    args = parser.parse_args(argv)

    # stderr only: stdout is the MCP transport.
    logging.basicConfig(level=args.log_level.upper())

    settings = Settings.from_env()
    settings.ensure_dirs()
    store = FlowStore(args.db or settings.db_path)
    server = build_server(store)
    try:
        asyncio.run(server.run_stdio_async())
    finally:
        store.close()


if __name__ == "__main__":  # pragma: no cover
    main()
