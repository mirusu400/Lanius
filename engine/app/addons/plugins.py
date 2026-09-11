"""Plugin system: load Python addons from disk at runtime (M7).

A plugin is a ``.py`` file (or package with ``__init__.py``) exposing either an
``addons`` list or a class/instance named ``Plugin``. Loaded objects are added
to the live mitmproxy addon chain, so they receive the same hooks as our
built-in addons (codex.md §5: addons are plain Python objects, not sandboxed).
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List

logger = logging.getLogger(__name__)

ENABLED_KEY = "plugins.enabled"


class PluginError(Exception):
    """Plugin could not be loaded or toggled (mapped to HTTP 4xx)."""


@dataclass(slots=True)
class Plugin:
    """A discovered plugin on disk."""

    name: str
    path: Path
    enabled: bool = False
    loaded: bool = False
    error: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    objects: list[Any] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": str(self.path),
            "enabled": self.enabled,
            "loaded": self.loaded,
            "error": self.error,
            "description": self.meta.get("description"),
            "version": self.meta.get("version"),
            "author": self.meta.get("author"),
            "hooks": self.meta.get("hooks", []),
        }


def _module_hooks(obj: Any) -> list[str]:
    """Which mitmproxy hooks does this addon implement?"""
    known = {
        "request",
        "response",
        "error",
        "tcp_start",
        "tcp_message",
        "tcp_end",
        "tcp_error",
        "running",
        "done",
        "websocket_message",
    }
    return sorted(h for h in known if callable(getattr(obj, h, None)))


class PluginManager:
    """Discovers, loads and unloads plugins."""

    def __init__(
        self,
        directory: Path | str,
        store: Any | None = None,
        broker: Any | None = None,
        addons: Any | None = None,
        on_chain_changed: Any | None = None,
    ) -> None:
        self.directory = Path(directory)
        self.store = store
        self.broker = broker
        self.addons = addons  # mitmproxy AddonManager, set once running
        # Called after the addon chain changes, so the engine can keep the
        # capture addon last (it must record plugin modifications).
        self.on_chain_changed = on_chain_changed
        self.plugins: dict[str, Plugin] = {}

    # --- persistence ------------------------------------------------------
    def _enabled_names(self) -> set[str]:
        if self.store is None:
            return set()
        raw = self.store.get_setting(ENABLED_KEY, "[]") or "[]"
        try:
            return set(json.loads(raw))
        except json.JSONDecodeError:
            return set()

    def _save_enabled(self) -> None:
        if self.store is None:
            return
        names = sorted(p.name for p in self.plugins.values() if p.enabled)
        self.store.set_setting(ENABLED_KEY, json.dumps(names))

    def _publish(self) -> None:
        if self.broker is not None:
            self.broker.publish("plugins.changed", self.list())

    # --- discovery --------------------------------------------------------
    def discover(self) -> List[Plugin]:
        """Scan the plugin directory, keeping already-loaded instances."""
        if not self.directory.exists():
            return list(self.plugins.values())

        found: dict[str, Path] = {}
        for entry in sorted(self.directory.iterdir()):
            if entry.name.startswith(("_", ".")):
                continue
            if entry.is_file() and entry.suffix == ".py":
                found[entry.stem] = entry
            elif entry.is_dir() and (entry / "__init__.py").exists():
                found[entry.name] = entry / "__init__.py"

        enabled = self._enabled_names()
        for name, path in found.items():
            existing = self.plugins.get(name)
            if existing is not None:
                existing.path = path
                continue
            self.plugins[name] = Plugin(
                name=name, path=path, enabled=name in enabled
            )

        # Drop plugins whose files disappeared (unloading them first).
        for name in list(self.plugins):
            if name not in found:
                self._unload(self.plugins[name])
                del self.plugins[name]

        return list(self.plugins.values())

    def list(self) -> List[dict[str, Any]]:
        return [p.as_dict() for p in sorted(self.plugins.values(), key=lambda p: p.name)]

    def get(self, name: str) -> Plugin:
        plugin = self.plugins.get(name)
        if plugin is None:
            raise PluginError(f"plugin {name!r} not found")
        return plugin

    # --- loading ----------------------------------------------------------
    def load_enabled(self) -> None:
        """Load every plugin marked enabled (called once the engine is up)."""
        self.discover()
        for plugin in self.plugins.values():
            if plugin.enabled and not plugin.loaded:
                try:
                    self._load(plugin)
                except PluginError:
                    logger.warning("plugin %s failed to load", plugin.name)

    def _import(self, plugin: Plugin) -> Any:
        module_name = f"lanius_plugins.{plugin.name}"
        spec = importlib.util.spec_from_file_location(module_name, plugin.path)
        if spec is None or spec.loader is None:
            raise PluginError(f"cannot import {plugin.path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            sys.modules.pop(module_name, None)
            raise PluginError(
                f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=3)}"
            ) from exc
        return module

    def _instantiate(self, module: Any) -> List[Any]:
        objects = getattr(module, "addons", None)
        if objects is None:
            candidate = getattr(module, "Plugin", None)
            if candidate is None:
                raise PluginError(
                    "plugin must define `addons = [...]` or a `Plugin` class"
                )
            objects = [candidate() if isinstance(candidate, type) else candidate]
        if not isinstance(objects, (list, tuple)) or not objects:
            raise PluginError("`addons` must be a non-empty list")
        return list(objects)

    @staticmethod
    def _namespace(plugin: Plugin, objects: List[Any]) -> None:
        """Give each addon a unique mitmproxy name.

        mitmproxy derives an addon's name from its class name, so two plugins
        that both define ``class Plugin`` would collide with
        "An addon called 'plugin' already exists."
        """
        for index, obj in enumerate(objects):
            suffix = "" if len(objects) == 1 else f"_{index}"
            try:
                obj.name = f"{plugin.name}{suffix}"
            except AttributeError:  # pragma: no cover - exotic addon objects
                logger.debug("cannot rename addon from plugin %s", plugin.name)

    def _load(self, plugin: Plugin) -> Plugin:
        try:
            module = self._import(plugin)
            objects = self._instantiate(module)
        except PluginError as exc:
            plugin.error = str(exc)
            plugin.loaded = False
            raise
        self._namespace(plugin, objects)
        plugin.meta = {
            "description": getattr(module, "DESCRIPTION", None),
            "version": getattr(module, "VERSION", None),
            "author": getattr(module, "AUTHOR", None),
            "hooks": sorted({h for obj in objects for h in _module_hooks(obj)}),
        }
        plugin.objects = objects
        plugin.error = None
        if self.addons is not None:
            try:
                for obj in objects:
                    self.addons.add(obj)
            except Exception as exc:
                # Roll back a partial registration so the chain stays clean.
                for obj in objects:
                    try:
                        self.addons.remove(obj)
                    except Exception:
                        pass
                plugin.objects = []
                plugin.loaded = False
                plugin.error = f"{type(exc).__name__}: {exc}"
                raise PluginError(plugin.error) from exc
        plugin.loaded = True
        self._chain_changed()
        return plugin

    def _chain_changed(self) -> None:
        if self.on_chain_changed is not None:
            try:
                self.on_chain_changed()
            except Exception:  # pragma: no cover - defensive
                logger.exception("chain-changed callback failed")

    def _unload(self, plugin: Plugin) -> None:
        if self.addons is not None:
            for obj in plugin.objects:
                try:
                    self.addons.remove(obj)
                except Exception:  # pragma: no cover - defensive
                    logger.exception("failed to remove addon %s", plugin.name)
        plugin.objects = []
        plugin.loaded = False
        sys.modules.pop(f"lanius_plugins.{plugin.name}", None)

    # --- public control ---------------------------------------------------
    def enable(self, name: str) -> Plugin:
        plugin = self.get(name)
        if not plugin.loaded:
            self._load(plugin)
        plugin.enabled = True
        self._save_enabled()
        self._publish()
        return plugin

    def disable(self, name: str) -> Plugin:
        plugin = self.get(name)
        self._unload(plugin)
        plugin.enabled = False
        self._save_enabled()
        self._publish()
        return plugin

    def reload(self, name: str) -> Plugin:
        plugin = self.get(name)
        was_enabled = plugin.enabled
        self._unload(plugin)
        if was_enabled:
            self._load(plugin)
            plugin.enabled = True
        self._publish()
        return plugin
