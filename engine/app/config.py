"""Runtime configuration for the Lanius engine."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _split_env(name: str) -> list[str]:
    raw = os.environ.get(name, "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def _default_data_dir() -> Path:
    return Path(os.environ.get("LANIUS_DATA_DIR", Path.home() / ".lanius"))


@dataclass(slots=True)
class Settings:
    proxy_host: str = "127.0.0.1"
    proxy_port: int = 8080
    api_host: str = "127.0.0.1"  # local-only binding (codex.md §10)
    api_port: int = 8081
    data_dir: Path = None  # type: ignore[assignment]
    db_path: Path = None  # type: ignore[assignment]
    confdir: Path = None  # type: ignore[assignment]
    log_level: str = "info"
    # Extra mitmproxy modes, e.g. "reverse:tcp://127.0.0.1:19100@19101" for
    # intercepting a non-HTTP service (codex.md §5, raw TCP).
    extra_modes: list[str] = None  # type: ignore[assignment]
    # Hosts forced through the raw TCP layer instead of HTTP parsing.
    tcp_hosts: list[str] = None  # type: ignore[assignment]
    plugins_dir: Path = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.data_dir is None:
            self.data_dir = _default_data_dir()
        self.data_dir = Path(self.data_dir)
        if self.db_path is None:
            self.db_path = self.data_dir / "lanius.sqlite"
        self.db_path = Path(self.db_path)
        if self.confdir is None:
            self.confdir = Path(
                os.environ.get("LANIUS_MITM_CONFDIR", Path.home() / ".mitmproxy")
            )
        self.confdir = Path(self.confdir)
        if self.extra_modes is None:
            self.extra_modes = _split_env("LANIUS_EXTRA_MODES")
        if self.tcp_hosts is None:
            self.tcp_hosts = _split_env("LANIUS_TCP_HOSTS")
        if self.plugins_dir is None:
            self.plugins_dir = Path(
                os.environ.get("LANIUS_PLUGINS_DIR", self.data_dir / "plugins")
            )
        self.plugins_dir = Path(self.plugins_dir)

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            proxy_host=os.environ.get("LANIUS_PROXY_HOST", "127.0.0.1"),
            proxy_port=int(os.environ.get("LANIUS_PROXY_PORT", "8080")),
            api_host=os.environ.get("LANIUS_API_HOST", "127.0.0.1"),
            api_port=int(os.environ.get("LANIUS_API_PORT", "8081")),
            log_level=os.environ.get("LANIUS_LOG_LEVEL", "info"),
        )

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.plugins_dir.mkdir(parents=True, exist_ok=True)
