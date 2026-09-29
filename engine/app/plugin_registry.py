"""Owned plugin contributions and the host side of :mod:`lanius_sdk`."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import tempfile
import threading
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any, List, Literal

from lanius_sdk import (
    ActiveScanContext,
    ActionLocation,
    Disposable,
    PluginApiError,
    PluginContext,
    ScanIssue,
    SettingDefinition,
    SettingScope,
)

from .addons import codecs

ContributionKind = Literal[
    "actions",
    "codecs",
    "payload_generators",
    "payload_processors",
    "settings",
    "passive_scanners",
    "active_scanners",
]

_ID = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_MAX_STORAGE_BYTES = 1024 * 1024
_MAX_GENERATED_PAYLOADS = 100_000
_MAX_RESOURCE_BYTES = 10 * 1024 * 1024
_MAX_ACTION_RESULT_BYTES = 1024 * 1024
_CONTRIBUTION_TIMEOUT_SECONDS = 30.0


async def _invoke_handler(handler: Any, *args: Any) -> Any:
    if inspect.iscoroutinefunction(handler):
        return await handler(*args)
    result = await asyncio.to_thread(handler, *args)
    if inspect.isawaitable(result):
        return await result
    return result


def _collect_payloads(values: Iterable[Any]) -> List[str]:
    result: List[str] = []
    for value in values:
        if len(result) >= _MAX_GENERATED_PAYLOADS:
            raise PluginApiError(
                f"payload generator exceeded {_MAX_GENERATED_PAYLOADS} values"
            )
        result.append(str(value))
    return result


@dataclass(slots=True)
class Contribution:
    owner: str
    local_id: str
    kind: ContributionKind
    metadata: dict[str, Any]
    handler: Any

    @property
    def id(self) -> str:
        return f"{self.owner}.{self.local_id}"

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "plugin": self.owner, **self.metadata}


class UserValueStore:
    """Small atomic JSON store for values that follow the user, not a project."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._lock = threading.RLock()

    def _read(self) -> dict[str, Any]:
        if self.path is None:
            return {}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {}
        return value if isinstance(value, dict) else {}

    def get(self, key: str) -> Any:
        with self._lock:
            return self._read().get(key)

    def set(self, key: str, value: Any) -> None:
        if self.path is None:
            return
        with self._lock:
            data = self._read()
            data[key] = value
            self._write(data)

    def delete(self, key: str) -> None:
        if self.path is None:
            return
        with self._lock:
            data = self._read()
            data.pop(key, None)
            self._write(data)

    def _write(self, data: dict[str, Any]) -> None:
        assert self.path is not None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(
            prefix=f".{self.path.name}.", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2, sort_keys=True)
                stream.write("\n")
            os.replace(temporary, self.path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


class ContributionRegistry:
    """Central registry with deterministic owner cleanup."""

    def __init__(self, store: Any | None, user_values_path: Path | None = None) -> None:
        self.store = store
        self.user_values = UserValueStore(user_values_path)
        self._items: dict[ContributionKind, dict[str, Contribution]] = {
            "actions": {},
            "codecs": {},
            "payload_generators": {},
            "payload_processors": {},
            "settings": {},
            "passive_scanners": {},
            "active_scanners": {},
        }
        self._handles: dict[str, list[Disposable]] = {}
        self._tasks: dict[str, set[asyncio.Future[Any]]] = {}

    def context(self, owner: str, resource_root: Path | None = None) -> PluginContext:
        self._validate_id(owner, "plugin id")
        return PluginContext(owner, PluginHost(self, owner, resource_root))

    @staticmethod
    def _validate_id(value: str, label: str) -> None:
        if not isinstance(value, str) or not _ID.fullmatch(value):
            raise PluginApiError(
                f"{label} must use lowercase letters, digits, dots, dashes or underscores"
            )

    @staticmethod
    def _validate_key(key: str) -> None:
        if not isinstance(key, str) or not _KEY.fullmatch(key):
            raise PluginApiError("storage key contains unsupported characters")

    def _remember(self, owner: str, handle: Disposable) -> Disposable:
        self._handles.setdefault(owner, []).append(handle)
        return handle

    def adopt(self, owner: str, handle: Disposable) -> Disposable:
        """Attach a plugin-returned disposable to the owner's lifecycle."""

        return self._remember(owner, handle)

    def register(
        self,
        owner: str,
        kind: ContributionKind,
        local_id: str,
        metadata: dict[str, Any],
        handler: Any,
        *,
        on_dispose: Callable[[], None] | None = None,
    ) -> Disposable:
        self._validate_id(local_id, f"{kind} id")
        qualified = f"{owner}.{local_id}"
        bucket = self._items[kind]
        if qualified in bucket:
            raise PluginApiError(f"duplicate {kind} contribution: {qualified}")
        item = Contribution(owner, local_id, kind, metadata, handler)
        bucket[qualified] = item

        def remove() -> None:
            if bucket.get(qualified) is item:
                bucket.pop(qualified, None)
                if on_dispose is not None:
                    on_dispose()

        return self._remember(owner, Disposable(remove))

    def list(self, kind: ContributionKind | None = None) -> dict[str, list[dict[str, Any]]]:
        kinds: Sequence[ContributionKind] = (
            (kind,) if kind else tuple(self._items)
        )
        return {
            name: [item.as_dict() for item in self._items[name].values()]
            for name in kinds
        }

    def counts(self, owner: str) -> dict[str, int]:
        return {
            kind: sum(item.owner == owner for item in bucket.values())
            for kind, bucket in self._items.items()
        }

    def _get(self, kind: ContributionKind, qualified_id: str) -> Contribution:
        try:
            return self._items[kind][qualified_id]
        except KeyError as exc:
            raise PluginApiError(f"unknown {kind} contribution: {qualified_id}") from exc

    def scan_handlers(
        self, kind: Literal["passive_scanners", "active_scanners"]
    ) -> List[Contribution]:
        return list(self._items[kind].values())

    async def invoke_action(
        self, qualified_id: str, payload: Mapping[str, Any]
    ) -> Any:
        item = self._get("actions", qualified_id)
        location = payload.get("location")
        locations = item.metadata["locations"]
        if location is not None and location not in locations:
            raise PluginApiError(
                f"action {qualified_id} is not available at {location!r}"
            )
        try:
            result = await asyncio.wait_for(
                _invoke_handler(item.handler, payload),
                timeout=_CONTRIBUTION_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            raise PluginApiError(f"action {qualified_id} timed out") from exc
        try:
            size = len(json.dumps(result, ensure_ascii=False).encode())
        except (TypeError, ValueError) as exc:
            raise PluginApiError("action result must be JSON compatible") from exc
        if size > _MAX_ACTION_RESULT_BYTES:
            raise PluginApiError("action result exceeds 1 MiB")
        return result

    async def generate_payloads(
        self, qualified_id: str, options: Mapping[str, Any]
    ) -> List[str]:
        item = self._get("payload_generators", qualified_id)
        try:
            values = await asyncio.wait_for(
                _invoke_handler(item.handler, options),
                timeout=_CONTRIBUTION_TIMEOUT_SECONDS,
            )
            return await asyncio.wait_for(
                asyncio.to_thread(_collect_payloads, values),
                timeout=_CONTRIBUTION_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            raise PluginApiError(
                f"payload generator {qualified_id} timed out"
            ) from exc

    async def process_payload(
        self, qualified_id: str, value: str, context: Mapping[str, Any]
    ) -> str:
        item = self._get("payload_processors", qualified_id)
        try:
            result = await asyncio.wait_for(
                _invoke_handler(item.handler, value, context),
                timeout=_CONTRIBUTION_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            raise PluginApiError(
                f"payload processor {qualified_id} timed out"
            ) from exc
        if not isinstance(result, str):
            raise PluginApiError("payload processor must return a string")
        return result

    def settings(self, owner: str) -> dict[str, Any]:
        fields = [
            item
            for item in self._items["settings"].values()
            if item.owner == owner
        ]
        definitions = [item.handler for item in fields]
        return {
            "plugin": owner,
            "fields": [asdict(field) for field in definitions],
            "values": {field.key: self.get_setting(owner, field.key) for field in definitions},
        }

    def _setting(self, owner: str, key: str) -> SettingDefinition:
        item = self._get("settings", f"{owner}.{key}")
        return item.handler

    @staticmethod
    def _validate_setting_value(field: SettingDefinition, value: Any) -> Any:
        valid = (
            (field.kind == "string" and isinstance(value, str))
            or (field.kind == "boolean" and isinstance(value, bool))
            or (
                field.kind == "integer"
                and isinstance(value, int)
                and not isinstance(value, bool)
            )
            or (
                field.kind == "number"
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
            )
            or (
                field.kind == "enum"
                and isinstance(value, str)
                and value in field.choices
            )
        )
        if not valid:
            raise PluginApiError(f"invalid value for setting {field.key!r}")
        return value

    def _value_key(self, category: str, owner: str, key: str) -> str:
        return f"plugins.{category}.{owner}.{key}"

    def _read_value(self, key: str, scope: SettingScope) -> Any:
        raw = (
            self.store.get_setting(key) if scope == "project" and self.store else None
        )
        if scope == "user":
            return self.user_values.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return None

    def _write_value(self, key: str, value: Any, scope: SettingScope) -> None:
        try:
            encoded = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            raise PluginApiError("plugin values must be JSON serializable") from exc
        if len(encoded.encode("utf-8")) > _MAX_STORAGE_BYTES:
            raise PluginApiError("plugin value exceeds 1 MiB")
        if scope == "user":
            self.user_values.set(key, value)
        elif self.store is not None:
            self.store.set_setting(key, encoded)

    def _delete_value(self, key: str, scope: SettingScope) -> None:
        if scope == "user":
            self.user_values.delete(key)
        elif self.store is not None:
            self.store.delete_setting(key)

    def get_setting(self, owner: str, key: str) -> Any:
        field = self._setting(owner, key)
        stored = self._read_value(
            self._value_key("settings", owner, key), field.scope
        )
        return field.default if stored is None else stored

    def set_setting(self, owner: str, key: str, value: Any) -> None:
        field = self._setting(owner, key)
        self._write_value(
            self._value_key("settings", owner, key),
            self._validate_setting_value(field, value),
            field.scope,
        )

    def get_storage(
        self, owner: str, key: str, default: Any, scope: SettingScope
    ) -> Any:
        self._validate_key(key)
        value = self._read_value(self._value_key("storage", owner, key), scope)
        return default if value is None else value

    def set_storage(
        self, owner: str, key: str, value: Any, scope: SettingScope
    ) -> None:
        self._validate_key(key)
        self._write_value(self._value_key("storage", owner, key), value, scope)

    def delete_storage(self, owner: str, key: str, scope: SettingScope) -> None:
        self._validate_key(key)
        self._delete_value(self._value_key("storage", owner, key), scope)

    def track_task(self, owner: str, task: asyncio.Future[Any]) -> Disposable:
        tasks = self._tasks.setdefault(owner, set())
        tasks.add(task)
        task.add_done_callback(tasks.discard)

        def cancel() -> None:
            tasks.discard(task)
            if not task.done():
                task.cancel()

        return self._remember(owner, Disposable(cancel))

    def dispose_owner(self, owner: str) -> None:
        for handle in reversed(self._handles.pop(owner, [])):
            handle.dispose()
        for task in self._tasks.pop(owner, set()):
            if not task.done():
                task.cancel()

    async def dispose_owner_async(self, owner: str) -> None:
        tasks = list(self._tasks.get(owner, set()))
        self.dispose_owner(owner)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


class PluginHost:
    """Owner-bound implementation behind the public context services."""

    def __init__(
        self,
        registry: ContributionRegistry,
        owner: str,
        resource_root: Path | None = None,
    ) -> None:
        self.registry = registry
        self.owner = owner
        self.resource_root = resource_root

    def _resource_path(self, value: str, *, allow_empty: bool = False) -> Path:
        if not isinstance(value, str):
            raise PluginApiError("resource path must be a string")
        path = PurePosixPath(value)
        if (
            path.is_absolute()
            or ".." in path.parts
            or "\\" in value
            or (not allow_empty and (not value or value.endswith("/")))
        ):
            raise PluginApiError("resource path must stay inside resources/")
        if self.resource_root is None:
            raise PluginApiError("plugin has no packaged resources")
        root = self.resource_root.resolve()
        candidate = (root / path.as_posix()).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise PluginApiError("resource path must stay inside resources/") from exc
        return candidate

    def list_resources(self, prefix: str) -> Sequence[str]:
        if self.resource_root is None:
            return ()
        root = self.resource_root.resolve()
        if not root.is_dir():
            return ()
        start = self._resource_path(prefix, allow_empty=True) if prefix else root
        if not start.exists():
            return ()
        files = [start] if start.is_file() else start.rglob("*")
        return tuple(
            sorted(
                candidate.relative_to(root).as_posix()
                for candidate in files
                if candidate.is_file()
            )
        )

    def read_resource(self, path: str) -> bytes:
        candidate = self._resource_path(path)
        if not candidate.is_file():
            raise PluginApiError(f"plugin resource not found: {path}")
        size = candidate.stat().st_size
        if size > _MAX_RESOURCE_BYTES:
            raise PluginApiError("plugin resource exceeds 10 MiB")
        value = candidate.read_bytes()
        if len(value) > _MAX_RESOURCE_BYTES:
            raise PluginApiError("plugin resource exceeds 10 MiB")
        return value

    def register_action(
        self,
        action_id: str,
        title: str,
        handler: Callable[[Mapping[str, Any]], Any],
        *,
        locations: Sequence[ActionLocation],
        description: str | None,
    ) -> Disposable:
        if not title.strip() or not callable(handler):
            raise PluginApiError("an action needs a title and callable handler")
        allowed = {
            "global", "history", "flow", "request", "response", "repeater", "intruder"
        }
        if not locations or any(location not in allowed for location in locations):
            raise PluginApiError("action has an unsupported location")
        return self.registry.register(
            self.owner,
            "actions",
            action_id,
            {
                "title": title,
                "description": description,
                "locations": list(dict.fromkeys(locations)),
            },
            handler,
        )

    def register_codec(
        self,
        codec_id: str,
        title: str,
        *,
        encode: Callable[[str], str] | None,
        decode: Callable[[str], str] | None,
    ) -> Disposable:
        if not callable(encode) and not callable(decode):
            raise PluginApiError("a codec needs an encode or decode function")
        qualified = f"{self.owner}.{codec_id}"
        codecs.register_codec(qualified, encode=encode, decode=decode)
        try:
            return self.registry.register(
                self.owner,
                "codecs",
                codec_id,
                {
                    "title": title,
                    "directions": [
                        direction
                        for direction, function in (("encode", encode), ("decode", decode))
                        if callable(function)
                    ],
                },
                {"encode": encode, "decode": decode},
                on_dispose=lambda: codecs.unregister_codec(qualified),
            )
        except Exception:
            codecs.unregister_codec(qualified)
            raise

    def register_payload_generator(
        self,
        generator_id: str,
        title: str,
        generator: Callable[[Mapping[str, Any]], Iterable[str] | Awaitable[Iterable[str]]],
        *,
        description: str | None,
    ) -> Disposable:
        if not callable(generator):
            raise PluginApiError("payload generator must be callable")
        return self.registry.register(
            self.owner,
            "payload_generators",
            generator_id,
            {"title": title, "description": description},
            generator,
        )

    def register_payload_processor(
        self,
        processor_id: str,
        title: str,
        processor: Callable[[str, Mapping[str, Any]], str | Awaitable[str]],
        *,
        description: str | None,
    ) -> Disposable:
        if not callable(processor):
            raise PluginApiError("payload processor must be callable")
        return self.registry.register(
            self.owner,
            "payload_processors",
            processor_id,
            {"title": title, "description": description},
            processor,
        )

    def define_settings(self, fields: Sequence[SettingDefinition]) -> Disposable:
        handles: list[Disposable] = []
        try:
            for field in fields:
                if field.kind == "enum" and not field.choices:
                    raise PluginApiError(f"enum setting {field.key!r} needs choices")
                if field.default is not None:
                    self.registry._validate_setting_value(field, field.default)
                handles.append(
                    self.registry.register(
                        self.owner,
                        "settings",
                        field.key,
                        {
                            "title": field.title,
                            "description": field.description,
                            "kind": field.kind,
                            "scope": field.scope,
                            "choices": list(field.choices),
                        },
                        field,
                    )
                )
        except Exception:
            for handle in reversed(handles):
                handle.dispose()
            raise
        def dispose_fields() -> None:
            for handle in reversed(handles):
                handle.dispose()

        return self.registry._remember(self.owner, Disposable(dispose_fields))

    def get_setting(self, key: str) -> Any:
        return self.registry.get_setting(self.owner, key)

    def set_setting(self, key: str, value: Any) -> None:
        self.registry.set_setting(self.owner, key, value)

    @staticmethod
    def _scope(scope: SettingScope) -> SettingScope:
        if scope not in ("project", "user"):
            raise PluginApiError("scope must be 'project' or 'user'")
        return scope

    def get_storage(self, key: str, default: Any, scope: SettingScope) -> Any:
        return self.registry.get_storage(self.owner, key, default, self._scope(scope))

    def set_storage(self, key: str, value: Any, scope: SettingScope) -> None:
        self.registry.set_storage(self.owner, key, value, self._scope(scope))

    def delete_storage(self, key: str, scope: SettingScope) -> None:
        self.registry.delete_storage(self.owner, key, self._scope(scope))

    def create_task(
        self, awaitable: Awaitable[Any], *, name: str | None
    ) -> Disposable:
        task = asyncio.ensure_future(awaitable)
        if isinstance(task, asyncio.Task):
            task.set_name(name or f"plugin-{self.owner}-task")
        return self.registry.track_task(self.owner, task)

    def register_passive_scan(
        self,
        check_id: str,
        title: str,
        handler: Callable[
            [Mapping[str, Any]],
            ScanIssue
            | Iterable[ScanIssue]
            | Awaitable[ScanIssue | Iterable[ScanIssue] | None]
            | None,
        ],
        *,
        description: str | None,
    ) -> Disposable:
        if not callable(handler):
            raise PluginApiError("passive scanner check must be callable")
        return self.registry.register(
            self.owner,
            "passive_scanners",
            check_id,
            {"title": title, "description": description, "mode": "passive"},
            handler,
        )

    def register_active_scan(
        self,
        check_id: str,
        title: str,
        handler: Callable[
            [ActiveScanContext],
            ScanIssue
            | Iterable[ScanIssue]
            | Awaitable[ScanIssue | Iterable[ScanIssue] | None]
            | None,
        ],
        *,
        description: str | None,
    ) -> Disposable:
        if not callable(handler):
            raise PluginApiError("active scanner check must be callable")
        return self.registry.register(
            self.owner,
            "active_scanners",
            check_id,
            {"title": title, "description": description, "mode": "active"},
            handler,
        )
