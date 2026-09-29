"""Runtime plugin loading and lifecycle management.

Legacy plugins are Python files or packages that expose either ``Plugin`` or
``addons``. They run in the engine process as mitmproxy addons. Discovery is
kept separate from runtime mutation so filesystem work can happen off the
event loop without touching the live addon chain from another thread.
"""

from __future__ import annotations

import ast
import asyncio
import importlib
import importlib.util
import inspect
import json
import logging
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, List

from mitmproxy import hooks as mitm_hooks

from .. import codegen
from ..plugin_registry import ContributionRegistry
from ..plugin_packages import (
    PluginPackageError,
    PluginPackageManager,
    load_manifest,
    verify_integrity,
)
from lanius_sdk import API_VERSION, Disposable

logger = logging.getLogger(__name__)

ENABLED_KEY = "plugins.enabled"
ORDER_KEY = "plugins.order"
AUTO_RELOAD_KEY = "plugins.auto_reload"
WATCH_INTERVAL_SECONDS = 1.0

# Hook classes are spread across several mitmproxy modules and are registered
# lazily. Keep the public names explicit so discovery and runtime reporting do
# not depend on which protocol modules happened to be imported first.
HOOK_NAMES = frozenset(
    {
        "load",
        "configure",
        "running",
        "update",
        "done",
        "client_connected",
        "client_disconnected",
        "server_connect",
        "server_connected",
        "server_disconnected",
        "server_connect_error",
        "next_layer",
        "requestheaders",
        "request",
        "responseheaders",
        "response",
        "error",
        "http_connect",
        "http_connect_upstream",
        "http_connected",
        "http_connect_error",
        "dns_request",
        "dns_response",
        "dns_error",
        "tcp_start",
        "tcp_message",
        "tcp_end",
        "tcp_error",
        "udp_start",
        "udp_message",
        "udp_end",
        "udp_error",
        "quic_start_client",
        "quic_start_server",
        "tls_clienthello",
        "tls_start_client",
        "tls_start_server",
        "tls_established_client",
        "tls_established_server",
        "tls_failed_client",
        "tls_failed_server",
        "websocket_start",
        "websocket_message",
        "websocket_end",
        "websocket_error",
    }
)

_ABSENT = object()


class PluginError(Exception):
    """Plugin could not be loaded or toggled (mapped to HTTP 4xx)."""


@dataclass(slots=True)
class RegistryChange:
    """One command or option replaced while a plugin was loading."""

    before: Any
    after: Any


@dataclass(slots=True)
class DiscoveredPlugin:
    """Filesystem scan result that is safe to construct in a worker thread."""

    name: str
    path: Path
    meta: dict[str, Any]
    fingerprint: tuple[tuple[str, int, int], ...]
    package_root: Path | None = None


@dataclass(slots=True)
class Plugin:
    """A discovered plugin and its current runtime state."""

    name: str
    path: Path
    enabled: bool = False
    loaded: bool = False
    error: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    objects: list[Any] = field(default_factory=list)
    order: int = 0
    command_changes: dict[str, RegistryChange] = field(default_factory=dict)
    option_changes: dict[str, RegistryChange] = field(default_factory=dict)
    auto_reload: bool = False
    fingerprint: tuple[tuple[str, int, int], ...] = ()
    uses_sdk: bool = False
    package_root: Path | None = None

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
            "order": self.order,
            "auto_reload": self.auto_reload,
            "sdk_api_version": API_VERSION if self.uses_sdk else None,
            "contributions": self.meta.get("contributions", {}),
            "package": self.meta.get("package"),
            "ui": self.meta.get("ui"),
        }


def _module_hooks(obj: Any) -> list[str]:
    """Return every public mitmproxy hook implemented by an addon object."""

    return sorted(h for h in HOOK_NAMES if callable(getattr(obj, h, None)))


def _literal_string(node: ast.AST) -> str | None:
    try:
        value = ast.literal_eval(node)
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, str) else None


def _legacy_metadata(path: Path) -> dict[str, Any]:
    """Read display metadata without executing an untrusted plugin."""

    meta: dict[str, Any] = {
        "description": None,
        "version": None,
        "author": None,
        "hooks": [],
    }
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError, UnicodeError):
        return meta

    names = {
        "DESCRIPTION": "description",
        "VERSION": "version",
        "AUTHOR": "author",
    }
    declared_hooks: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            value_node = node.value
            for target in targets:
                if isinstance(target, ast.Name) and target.id in names and value_node:
                    value = _literal_string(value_node)
                    if value is not None:
                        meta[names[target.id]] = value
        elif isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if item.name in HOOK_NAMES:
                        declared_hooks.add(item.name)
    meta["hooks"] = sorted(declared_hooks)
    return meta


def _purge_modules(name: str) -> None:
    prefix = _module_name(name)
    module_names = [
        module_name
        for module_name in sys.modules
        if module_name == prefix or module_name.startswith(prefix + ".")
    ]
    for module_name in module_names:
        sys.modules.pop(module_name, None)
    importlib.invalidate_caches()


def _module_name(name: str) -> str:
    """Return a valid, collision-free module name for any manifest plugin ID."""

    return f"lanius_plugins.p_{name.encode('utf-8').hex()}"


def _purge_bytecode(path: Path) -> None:
    """Avoid timestamp-granularity stale imports during rapid reloads."""

    if path.name == "__init__.py":
        candidates = path.parent.rglob("__pycache__/*.pyc")
    else:
        candidates = path.parent.glob(f"__pycache__/{path.stem}.*.pyc")
    for candidate in candidates:
        try:
            candidate.unlink()
        except OSError:
            logger.debug("could not remove stale bytecode %s", candidate)


def _fingerprint(path: Path) -> tuple[tuple[str, int, int], ...]:
    if path.name == "__init__.py":
        root = path.parent
        files = sorted(root.rglob("*.py"))
    else:
        root = path.parent
        files = [path]
    values: list[tuple[str, int, int]] = []
    for candidate in files:
        try:
            stat = candidate.stat()
        except OSError:
            continue
        values.append((str(candidate.relative_to(root)), stat.st_mtime_ns, stat.st_size))
    return tuple(values)


def _package_fingerprint(root: Path) -> tuple[tuple[str, int, int], ...]:
    values: list[tuple[str, int, int]] = []
    for candidate in sorted(root.rglob("*")):
        if not candidate.is_file() or "__pycache__" in candidate.parts:
            continue
        try:
            stat = candidate.stat()
        except OSError:
            continue
        values.append((str(candidate.relative_to(root)), stat.st_mtime_ns, stat.st_size))
    return tuple(values)


class PluginManager:
    """Discover, load, order and unload engine plugins."""

    def __init__(
        self,
        directory: Path | str,
        store: Any | None = None,
        broker: Any | None = None,
        addons: Any | None = None,
        on_chain_changed: Any | None = None,
        user_values_path: Path | None = None,
        registry: ContributionRegistry | None = None,
        packages: PluginPackageManager | None = None,
        *,
        safe_mode: bool = False,
        lockdown_enabled: Callable[[], bool] | None = None,
    ) -> None:
        self.directory = Path(directory)
        self.store = store
        self.broker = broker
        self.addons = addons
        self.on_chain_changed = on_chain_changed
        self.safe_mode = safe_mode
        self.lockdown_enabled = lockdown_enabled or (lambda: False)
        self.registry = registry or ContributionRegistry(store, user_values_path)
        self.packages = packages
        self.runtime_started = False
        self.plugins: dict[str, Plugin] = {}
        self._lock = asyncio.Lock()
        self._watch_task: asyncio.Task[None] | None = None

    @property
    def suspended(self) -> bool:
        """Whether plugin code may not run at all.

        Plugins are arbitrary Python and can open their own sockets, so
        Lockdown Mode suspends them exactly as safe mode does. Every load
        path goes through :meth:`_load`, which checks this.
        """
        return self.safe_mode or self.lockdown_enabled()

    @property
    def suspended_reason(self) -> str:
        if self.safe_mode:
            return "plugins are disabled by safe mode"
        return "Lockdown Mode blocks plugin execution"

    # --- persistence --------------------------------------------------
    def _json_setting(self, key: str) -> list[str]:
        if self.store is None:
            return []
        raw = self.store.get_setting(key, "[]") or "[]"
        try:
            value = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, str)]

    def _enabled_names(self) -> set[str]:
        return set(self._json_setting(ENABLED_KEY))

    def _saved_order(self) -> list[str]:
        return self._json_setting(ORDER_KEY)

    def _auto_reload_names(self) -> set[str]:
        return set(self._json_setting(AUTO_RELOAD_KEY))

    def _save_enabled(self) -> None:
        if self.store is None:
            return
        names = sorted(p.name for p in self.plugins.values() if p.enabled)
        self.store.set_setting(ENABLED_KEY, json.dumps(names))

    def _save_order(self) -> None:
        if self.store is None:
            return
        self.store.set_setting(
            ORDER_KEY,
            json.dumps([p.name for p in self._ordered_plugins()]),
        )

    def _save_auto_reload(self) -> None:
        if self.store is None:
            return
        names = sorted(p.name for p in self.plugins.values() if p.auto_reload)
        self.store.set_setting(AUTO_RELOAD_KEY, json.dumps(names))

    def _publish(self) -> None:
        if self.broker is not None:
            self.broker.publish("plugins.changed", self.list())

    # --- discovery ----------------------------------------------------
    def scan(self) -> dict[str, DiscoveredPlugin]:
        """Read plugin paths and literal metadata without changing runtime state."""

        if not self.directory.exists():
            return {}
        found: dict[str, DiscoveredPlugin] = {}
        for entry in sorted(self.directory.iterdir()):
            if entry.name.startswith(("_", ".")):
                continue
            package_root: Path | None = None
            if entry.is_dir() and (entry / "plugin.json").is_file():
                try:
                    if self.packages is not None:
                        manifest, trust = self.packages.inspect(entry)
                    else:
                        manifest = load_manifest(entry)
                        verify_integrity(entry, manifest)
                        trust = "development" if entry.is_symlink() else "unmanaged"
                except PluginPackageError as exc:
                    logger.warning("ignoring invalid plugin package %s: %s", entry, exc)
                    continue
                path = entry / manifest.backend_entrypoint
                name = manifest.id
                meta = manifest.metadata(entry)
                meta["package"]["trust"] = trust
                package_root = entry
                fingerprint = _package_fingerprint(entry)
            elif entry.is_file() and entry.suffix == ".py":
                path = entry
                name = entry.stem
            elif entry.is_dir() and (entry / "__init__.py").exists():
                path = entry / "__init__.py"
                name = entry.name
            else:
                continue
            found[name] = DiscoveredPlugin(
                name,
                path,
                meta if package_root else _legacy_metadata(path),
                fingerprint if package_root else _fingerprint(path),
                package_root,
            )
        return found

    def _apply_discovery(self, found: dict[str, DiscoveredPlugin]) -> list[Plugin]:
        """Apply a scan before the live runtime starts."""

        enabled = self._enabled_names()
        auto_reload = self._auto_reload_names()
        order = self._saved_order()
        order_index = {name: index for index, name in enumerate(order)}
        next_order = len(order_index)
        for name, item in found.items():
            existing = self.plugins.get(name)
            if existing is not None:
                existing.path = item.path
                existing.fingerprint = item.fingerprint
                existing.package_root = item.package_root
                if not existing.loaded:
                    existing.meta = item.meta
                continue
            plugin_order = order_index.get(name, next_order)
            if name not in order_index:
                next_order += 1
            self.plugins[name] = Plugin(
                name=name,
                path=item.path,
                enabled=name in enabled,
                meta=item.meta,
                order=plugin_order,
                auto_reload=name in auto_reload,
                fingerprint=item.fingerprint,
                package_root=item.package_root,
            )

        for name in list(self.plugins):
            if name not in found:
                self._unload_sync(self.plugins[name])
                del self.plugins[name]
        self._normalize_order()
        return self._ordered_plugins()

    def discover(self) -> List[Plugin]:
        """Synchronous discovery for startup and non-running test managers."""

        if self.runtime_started:
            raise PluginError("live plugin discovery must be awaited")
        return self._apply_discovery(self.scan())

    async def refresh(self) -> List[Plugin]:
        """Scan in a worker, then reconcile the live runtime on its event loop."""

        found = await asyncio.to_thread(self.scan)
        async with self._lock:
            enabled = self._enabled_names()
            auto_reload = self._auto_reload_names()
            order = self._saved_order()
            order_index = {name: index for index, name in enumerate(order)}
            next_order = len(order_index)
            changed = False
            for name, item in found.items():
                existing = self.plugins.get(name)
                if existing is not None:
                    source_changed = existing.fingerprint != item.fingerprint
                    existing.path = item.path
                    existing.fingerprint = item.fingerprint
                    if not existing.loaded:
                        existing.meta = item.meta
                    # An enabled plugin that failed to load is retried too, so
                    # fixing the file recovers it without a manual reload.
                    if (
                        source_changed
                        and existing.auto_reload
                        and (existing.loaded or existing.enabled)
                    ):
                        if existing.loaded:
                            await self._unload_async(existing)
                        else:
                            existing.meta = item.meta
                        if existing.enabled and not self.suspended:
                            try:
                                await self._load_async(existing)
                            except PluginError:
                                logger.warning("plugin %s failed to auto-reload", name)
                        changed = True
                    continue
                plugin_order = order_index.get(name, next_order)
                if name not in order_index:
                    next_order += 1
                self.plugins[name] = Plugin(
                    name=name,
                    path=item.path,
                    enabled=name in enabled,
                    meta=item.meta,
                    order=plugin_order,
                    auto_reload=name in auto_reload,
                    fingerprint=item.fingerprint,
                    package_root=item.package_root,
                )
                changed = True

            for name in list(self.plugins):
                if name not in found:
                    await self._unload_async(self.plugins[name])
                    del self.plugins[name]
                    changed = True
            self._normalize_order()
            if changed:
                self._save_order()
                self._publish()
            return self._ordered_plugins()

    def _normalize_order(self) -> None:
        for index, plugin in enumerate(self._ordered_plugins()):
            plugin.order = index

    def _ordered_plugins(self) -> list[Plugin]:
        return sorted(self.plugins.values(), key=lambda p: (p.order, p.name))

    def list(self) -> List[dict[str, Any]]:
        return [p.as_dict() for p in self._ordered_plugins()]

    def get(self, name: str) -> Plugin:
        plugin = self.plugins.get(name)
        if plugin is None:
            raise PluginError(f"plugin {name!r} not found")
        return plugin

    # --- registry ownership ------------------------------------------
    def _registry_snapshots(self) -> tuple[dict[str, Any], dict[str, Any]]:
        master = getattr(self.addons, "master", None)
        commands = getattr(getattr(master, "commands", None), "commands", None)
        options = getattr(getattr(master, "options", None), "_options", None)
        return (
            dict(commands) if isinstance(commands, dict) else {},
            dict(options) if isinstance(options, dict) else {},
        )

    @staticmethod
    def _registry_changes(
        before: dict[str, Any], after: dict[str, Any]
    ) -> dict[str, RegistryChange]:
        changes: dict[str, RegistryChange] = {}
        for key in before.keys() | after.keys():
            previous = before.get(key, _ABSENT)
            current = after.get(key, _ABSENT)
            if previous is not current:
                changes[key] = RegistryChange(previous, current)
        return changes

    def _capture_registry_changes(
        self,
        plugin: Plugin,
        before_commands: dict[str, Any],
        before_options: dict[str, Any],
    ) -> None:
        after_commands, after_options = self._registry_snapshots()
        plugin.command_changes = self._registry_changes(before_commands, after_commands)
        plugin.option_changes = self._registry_changes(before_options, after_options)

    def _restore_registries(self, plugin: Plugin) -> None:
        master = getattr(self.addons, "master", None)
        command_manager = getattr(master, "commands", None)
        commands = getattr(command_manager, "commands", None)
        if isinstance(commands, dict):
            for name, change in plugin.command_changes.items():
                if commands.get(name, _ABSENT) is not change.after:
                    continue
                if change.before is _ABSENT:
                    commands.pop(name, None)
                else:
                    commands[name] = change.before
            parse_partial = getattr(command_manager, "parse_partial", None)
            cache_clear = getattr(parse_partial, "cache_clear", None)
            if cache_clear is not None:
                cache_clear()

        option_manager = getattr(master, "options", None)
        options = getattr(option_manager, "_options", None)
        restored_options: set[str] = set()
        if isinstance(options, dict):
            for name, change in plugin.option_changes.items():
                if options.get(name, _ABSENT) is not change.after:
                    continue
                if change.before is _ABSENT:
                    options.pop(name, None)
                else:
                    options[name] = change.before
                restored_options.add(name)
        if restored_options and option_manager is not None:
            try:
                option_manager.changed.send(updated=restored_options)
            except Exception:
                logger.exception("failed to announce restored plugin options")
        plugin.command_changes.clear()
        plugin.option_changes.clear()

    # --- loading ------------------------------------------------------
    def load_enabled(self) -> None:
        """Load enabled plugins before the mitmproxy master starts running."""

        self.discover()
        if self.suspended:
            return
        for plugin in self._ordered_plugins():
            if plugin.enabled and not plugin.loaded:
                try:
                    self._load(plugin)
                except PluginError:
                    logger.warning("plugin %s failed to load", plugin.name)

    async def suspend_for_lockdown(self) -> None:
        """Detach loaded plugins without changing their saved enabled state.

        The enabled flags stay on disk, so turning Lockdown Mode off again
        restores the same set of plugins.
        """
        async with self._lock:
            for plugin in self.plugins.values():
                if plugin.loaded:
                    await self._unload_async(plugin)
            self._publish()

    async def resume_after_lockdown(self) -> None:
        """Load enabled plugins again once Lockdown Mode is off.

        `load_enabled` runs before the master does and cannot fire the
        running hook, so a plugin resumed while the proxy is live needs the
        async path instead.
        """
        if self.suspended:
            return
        async with self._lock:
            for plugin in self._ordered_plugins():
                if plugin.enabled and not plugin.loaded:
                    try:
                        await self._load_async(plugin)
                    except PluginError:
                        logger.warning("plugin %s failed to load", plugin.name)
            self._publish()

    def _import(self, plugin: Plugin) -> Any:
        module_name = _module_name(plugin.name)
        _purge_modules(plugin.name)
        _purge_bytecode(plugin.path)
        if plugin.package_root is not None:
            spec = importlib.util.spec_from_file_location(
                module_name,
                plugin.path,
                submodule_search_locations=[str(plugin.path.parent)],
            )
        else:
            # Omitting submodule_search_locations lets importlib recognize a
            # legacy __init__.py as a package and enables relative imports.
            spec = importlib.util.spec_from_file_location(module_name, plugin.path)
        if spec is None or spec.loader is None:
            raise PluginError(f"cannot import {plugin.path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            _purge_modules(plugin.name)
            raise PluginError(
                f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=3)}"
            ) from exc
        return module

    def _instantiate_legacy(self, module: Any) -> List[Any]:
        objects = getattr(module, "addons", None)
        if objects is None:
            candidate = getattr(module, "Plugin", None)
            if candidate is None:
                return []
            objects = [candidate() if isinstance(candidate, type) else candidate]
        if not isinstance(objects, (list, tuple)) or not objects:
            raise PluginError("`addons` must be a non-empty list")
        return list(objects)

    def _activate_sdk(self, plugin: Plugin, module: Any) -> List[Any]:
        activate = getattr(module, "activate", None)
        if activate is None:
            return []
        if not callable(activate):
            raise PluginError("`activate` must be callable")
        resource_root = (
            plugin.package_root / "resources"
            if plugin.package_root is not None
            else None
        )
        result = activate(self.registry.context(plugin.name, resource_root))
        if inspect.isawaitable(result):
            close = getattr(result, "close", None)
            if close is not None:
                close()
            raise PluginError("`activate` must be synchronous")
        plugin.uses_sdk = True
        if result is None:
            return []
        if isinstance(result, Disposable):
            self.registry.adopt(plugin.name, result)
            return []
        if isinstance(result, (list, tuple)):
            return list(result)
        return [result]

    @staticmethod
    def _namespace(plugin: Plugin, objects: List[Any]) -> None:
        for index, obj in enumerate(objects):
            suffix = "" if len(objects) == 1 else f"_{index}"
            try:
                obj.name = f"{plugin.name}{suffix}"
            except AttributeError:  # pragma: no cover - exotic addon objects
                logger.debug("cannot rename addon from plugin %s", plugin.name)

    @staticmethod
    def _register_formats(plugin: Plugin, objects: List[Any]) -> None:
        for obj in objects:
            formats = getattr(obj, "codegen_formats", None)
            if not formats:
                continue
            for kind, entry in dict(formats).items():
                try:
                    label, generator = entry
                    codegen.register_format(plugin.name, kind, label, generator)
                except (TypeError, ValueError) as exc:
                    logger.warning(
                        "plugin %s offers an unusable format %r: %s",
                        plugin.name,
                        kind,
                        exc,
                    )

    def _initial_configure(self, objects: List[Any]) -> None:
        invoke = getattr(self.addons, "invoke_addon_sync", None)
        master = getattr(self.addons, "master", None)
        if invoke is None or master is None:
            return
        updated = set(master.options.keys())
        for obj in objects:
            invoke(obj, mitm_hooks.ConfigureHook(updated))

    def _load(self, plugin: Plugin) -> Plugin:
        if self.suspended:
            raise PluginError(self.suspended_reason)
        plugin.uses_sdk = False
        try:
            module = self._import(plugin)
            sdk_objects = self._activate_sdk(plugin, module)
            objects = [*self._instantiate_legacy(module), *sdk_objects]
            if not objects and not plugin.uses_sdk:
                raise PluginError(
                    "plugin must define `activate`, `addons = [...]` or a `Plugin` class"
                )
        except PluginError as exc:
            self.registry.dispose_owner(plugin.name)
            plugin.error = str(exc)
            plugin.loaded = False
            raise
        except Exception as exc:
            self.registry.dispose_owner(plugin.name)
            plugin.error = f"{type(exc).__name__}: {exc}"
            plugin.loaded = False
            raise PluginError(plugin.error) from exc

        self._namespace(plugin, objects)
        discovered_meta = dict(plugin.meta)
        plugin.meta = {
            **discovered_meta,
            "description": getattr(module, "DESCRIPTION", None)
            or discovered_meta.get("description"),
            "version": getattr(module, "VERSION", None)
            or discovered_meta.get("version"),
            "author": getattr(module, "AUTHOR", None)
            or discovered_meta.get("author"),
            "hooks": sorted({h for obj in objects for h in _module_hooks(obj)}),
            "contributions": self.registry.counts(plugin.name),
        }
        plugin.objects = objects
        plugin.error = None
        before_commands, before_options = self._registry_snapshots()
        registered: list[Any] = []
        try:
            self._register_formats(plugin, objects)
            if self.addons is not None:
                for obj in objects:
                    self.addons.add(obj)
                    registered.append(obj)
                self._initial_configure(objects)
            self._capture_registry_changes(plugin, before_commands, before_options)
        except Exception as exc:
            addons = self.addons
            for obj in reversed(registered):
                try:
                    if addons is not None:
                        addons.remove(obj)
                except Exception:
                    logger.debug("partial plugin registration cleanup failed", exc_info=True)
            self._capture_registry_changes(plugin, before_commands, before_options)
            self._restore_registries(plugin)
            codegen.unregister_owner(plugin.name)
            self.registry.dispose_owner(plugin.name)
            plugin.meta["contributions"] = self.registry.counts(plugin.name)
            plugin.objects = []
            plugin.loaded = False
            plugin.error = f"{type(exc).__name__}: {exc}"
            _purge_modules(plugin.name)
            raise PluginError(plugin.error) from exc
        plugin.loaded = True
        self._chain_changed()
        return plugin

    async def _load_async(self, plugin: Plugin) -> Plugin:
        self._load(plugin)
        if not self.runtime_started:
            return plugin
        invoke = getattr(self.addons, "invoke_addon", None)
        if invoke is None:
            return plugin
        try:
            for obj in plugin.objects:
                await invoke(obj, mitm_hooks.RunningHook())
        except Exception as exc:
            plugin.error = f"{type(exc).__name__}: {exc}"
            await self._unload_async(plugin, preserve_error=True)
            raise PluginError(plugin.error) from exc
        return plugin

    def _chain_changed(self) -> None:
        self._apply_chain_order()
        if self.on_chain_changed is not None:
            try:
                self.on_chain_changed()
            except Exception:  # pragma: no cover - defensive
                logger.exception("chain-changed callback failed")

    def _apply_chain_order(self) -> None:
        chain = getattr(self.addons, "chain", None)
        if not isinstance(chain, list):
            return
        ordered_objects = [
            obj
            for plugin in self._ordered_plugins()
            if plugin.loaded
            for obj in plugin.objects
        ]
        indices = [chain.index(obj) for obj in ordered_objects if obj in chain]
        if not indices:
            return
        anchor = min(indices)
        chain[:] = [item for item in chain if item not in ordered_objects]
        for offset, obj in enumerate(ordered_objects):
            chain.insert(anchor + offset, obj)

    def _unload_sync(self, plugin: Plugin) -> None:
        if self.addons is not None:
            for obj in reversed(plugin.objects):
                try:
                    self.addons.remove(obj)
                except Exception:
                    logger.exception("failed to remove addon %s", plugin.name)
        self._restore_registries(plugin)
        codegen.unregister_owner(plugin.name)
        self.registry.dispose_owner(plugin.name)
        plugin.meta["contributions"] = self.registry.counts(plugin.name)
        plugin.objects = []
        plugin.loaded = False
        _purge_modules(plugin.name)
        self._chain_changed()

    async def _remove_live_addon(self, obj: Any) -> None:
        addons = self.addons
        if addons is None:
            return
        invoke = getattr(addons, "invoke_addon", None)
        lookup = getattr(addons, "lookup", None)
        chain = getattr(addons, "chain", None)
        if invoke is None or not isinstance(lookup, dict) or not isinstance(chain, list):
            addons.remove(obj)
            return

        from mitmproxy.addonmanager import _get_name, traverse

        for addon in traverse([obj]):
            name = _get_name(addon)
            chain[:] = [item for item in chain if item is not addon]
            if lookup.get(name) is addon:
                del lookup[name]
        await invoke(obj, mitm_hooks.DoneHook())

    async def _unload_async(
        self, plugin: Plugin, *, preserve_error: bool = False
    ) -> None:
        for obj in reversed(plugin.objects):
            try:
                if self.addons is not None:
                    await self._remove_live_addon(obj)
            except Exception:
                logger.exception("failed to remove addon %s", plugin.name)
        self._restore_registries(plugin)
        codegen.unregister_owner(plugin.name)
        await self.registry.dispose_owner_async(plugin.name)
        plugin.meta["contributions"] = self.registry.counts(plugin.name)
        plugin.objects = []
        plugin.loaded = False
        if not preserve_error:
            plugin.error = None
        _purge_modules(plugin.name)
        self._chain_changed()

    # --- public control ----------------------------------------------
    def enable(self, name: str) -> Plugin:
        if self.runtime_started:
            raise PluginError("live plugin changes must be awaited")
        plugin = self.get(name)
        if not plugin.loaded:
            self._load(plugin)
        plugin.enabled = True
        self._save_enabled()
        self._publish()
        return plugin

    def disable(self, name: str) -> Plugin:
        if self.runtime_started:
            raise PluginError("live plugin changes must be awaited")
        plugin = self.get(name)
        self._unload_sync(plugin)
        plugin.enabled = False
        self._save_enabled()
        self._publish()
        return plugin

    def reload(self, name: str) -> Plugin:
        if self.runtime_started:
            raise PluginError("live plugin changes must be awaited")
        plugin = self.get(name)
        was_enabled = plugin.enabled
        self._unload_sync(plugin)
        if was_enabled:
            self._load(plugin)
            plugin.enabled = True
        self._publish()
        return plugin

    async def enable_async(self, name: str) -> Plugin:
        async with self._lock:
            plugin = self.get(name)
            if not plugin.loaded:
                await self._load_async(plugin)
            plugin.enabled = True
            self._save_enabled()
            self._publish()
            return plugin

    async def disable_async(self, name: str) -> Plugin:
        async with self._lock:
            plugin = self.get(name)
            await self._unload_async(plugin)
            plugin.enabled = False
            self._save_enabled()
            self._publish()
            return plugin

    async def reload_async(self, name: str) -> Plugin:
        async with self._lock:
            plugin = self.get(name)
            was_enabled = plugin.enabled
            await self._unload_async(plugin)
            try:
                if was_enabled:
                    await self._load_async(plugin)
                    plugin.enabled = True
            finally:
                self._publish()
            return plugin

    async def set_order(self, names: List[str]) -> List[dict[str, Any]]:
        async with self._lock:
            if len(names) != len(set(names)) or set(names) != set(self.plugins):
                raise PluginError("plugin order must contain every plugin exactly once")
            for index, name in enumerate(names):
                self.plugins[name].order = index
            self._save_order()
            self._chain_changed()
            self._publish()
            return self.list()

    async def set_auto_reload(self, name: str, enabled: bool) -> Plugin:
        async with self._lock:
            plugin = self.get(name)
            plugin.auto_reload = enabled
            self._save_auto_reload()
            self._publish()
            return plugin

    def mark_runtime_started(self) -> None:
        self.runtime_started = True

    async def start_runtime(self) -> None:
        self.runtime_started = True
        if self._watch_task is None or self._watch_task.done():
            self._watch_task = asyncio.create_task(
                self._watch_for_changes(), name="lanius-plugin-watcher"
            )

    async def stop_runtime(self) -> None:
        self.runtime_started = False
        task = self._watch_task
        self._watch_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _watch_for_changes(self) -> None:
        while True:
            await asyncio.sleep(WATCH_INTERVAL_SECONDS)
            try:
                await self.refresh()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("plugin directory watcher failed")

    def master_stopped(self) -> None:
        """Forget objects after mitmproxy has already delivered ``done``."""

        self.runtime_started = False
        self._watch_task = None
        for plugin in self.plugins.values():
            codegen.unregister_owner(plugin.name)
            self.registry.dispose_owner(plugin.name)
            plugin.meta["contributions"] = self.registry.counts(plugin.name)
            plugin.objects = []
            plugin.loaded = False
            plugin.command_changes.clear()
            plugin.option_changes.clear()
            _purge_modules(plugin.name)
        self.addons = None
