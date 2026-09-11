"""Lanius engine entrypoint: mitmproxy + REST/WS API in one asyncio loop.

Usage::

    python -m app.main [--proxy-port 8080] [--api-port 8081]
"""

from __future__ import annotations

import argparse
import logging

import uvicorn

from .api import create_app
from .config import Settings


def parse_args(argv: list[str] | None = None) -> Settings:
    parser = argparse.ArgumentParser(prog="lanius-engine")
    defaults = Settings.from_env()
    parser.add_argument("--proxy-host", default=defaults.proxy_host)
    parser.add_argument("--proxy-port", type=int, default=defaults.proxy_port)
    parser.add_argument("--api-host", default=defaults.api_host)
    parser.add_argument("--api-port", type=int, default=defaults.api_port)
    parser.add_argument("--db", dest="db_path", default=None)
    parser.add_argument("--log-level", default=defaults.log_level)
    args = parser.parse_args(argv)
    return Settings(
        proxy_host=args.proxy_host,
        proxy_port=args.proxy_port,
        api_host=args.api_host,
        api_port=args.api_port,
        db_path=args.db_path,
        log_level=args.log_level,
    )


def main(argv: list[str] | None = None) -> None:
    settings = parse_args(argv)
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    app = create_app(settings)
    uvicorn.run(
        app,
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level,
    )


if __name__ == "__main__":  # pragma: no cover
    main()
