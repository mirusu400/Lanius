"""Public API for Lanius plugins.

Plugins should import from this package instead of importing engine internals.
The API is intentionally small and versioned so the host can evolve without
forcing every plugin to follow its internal module layout.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

API_VERSION = "1.1"

ActionLocation = Literal[
    "global", "history", "flow", "request", "response", "replay", "fuzzer"
]
SettingScope = Literal["project", "user"]
SettingKind = Literal["string", "boolean", "integer", "number", "enum"]
IssueSeverity = Literal["info", "low", "medium", "high", "critical"]
IssueConfidence = Literal["tentative", "firm", "certain"]
InsertionPointKind = Literal["query", "header", "path", "form", "json", "body"]


class PluginApiError(ValueError):
    """A plugin attempted to register or use an invalid contribution."""


class Disposable:
    """A registration that can be removed before the plugin is unloaded."""

    def __init__(self, callback: Callable[[], None]) -> None:
        self._callback: Callable[[], None] | None = callback

    @property
    def disposed(self) -> bool:
        return self._callback is None

    def dispose(self) -> None:
        callback, self._callback = self._callback, None
        if callback is not None:
            callback()

    def __enter__(self) -> "Disposable":
        return self

    def __exit__(self, *_args: object) -> None:
        self.dispose()


@dataclass(frozen=True, slots=True)
class SettingDefinition:
    """One field rendered in the plugin settings UI."""

    key: str
    title: str
    kind: SettingKind = "string"
    default: str | bool | int | float | None = None
    description: str | None = None
    scope: SettingScope = "project"
    choices: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ScanIssue:
    """A finding returned by a passive or active scanner check."""

    title: str
    severity: IssueSeverity
    detail: str
    confidence: IssueConfidence = "firm"
    remediation: str | None = None
    parameter: str | None = None
    evidence: Mapping[str, Any] | None = None
    fingerprint: str | None = None


@dataclass(frozen=True, slots=True)
class InsertionPoint:
    """One request value an active check can replace with a payload."""

    id: str
    kind: InsertionPointKind
    name: str
    base_value: str


class ActiveScanContext:
    """A rate-limited request sender scoped to one insertion point."""

    def __init__(
        self,
        request: Mapping[str, Any],
        insertion_point: InsertionPoint,
        send: Callable[[str], Awaitable[Mapping[str, Any]]],
    ) -> None:
        self.request = request
        self.insertion_point = insertion_point
        self._send = send

    async def send(self, payload: str) -> Mapping[str, Any]:
        return await self._send(payload)


class _Host(Protocol):
    def register_action(
        self,
        action_id: str,
        title: str,
        handler: Callable[[Mapping[str, Any]], Any],
        *,
        locations: Sequence[ActionLocation],
        description: str | None,
    ) -> Disposable: ...

    def register_codec(
        self,
        codec_id: str,
        title: str,
        *,
        encode: Callable[[str], str] | None,
        decode: Callable[[str], str] | None,
    ) -> Disposable: ...

    def register_payload_generator(
        self,
        generator_id: str,
        title: str,
        generator: Callable[[Mapping[str, Any]], Iterable[str] | Awaitable[Iterable[str]]],
        *,
        description: str | None,
    ) -> Disposable: ...

    def register_payload_processor(
        self,
        processor_id: str,
        title: str,
        processor: Callable[[str, Mapping[str, Any]], str | Awaitable[str]],
        *,
        description: str | None,
    ) -> Disposable: ...

    def define_settings(self, fields: Sequence[SettingDefinition]) -> Disposable: ...
    def get_setting(self, key: str) -> Any: ...
    def set_setting(self, key: str, value: Any) -> None: ...
    def get_storage(self, key: str, default: Any, scope: SettingScope) -> Any: ...
    def set_storage(self, key: str, value: Any, scope: SettingScope) -> None: ...
    def delete_storage(self, key: str, scope: SettingScope) -> None: ...
    def list_resources(self, prefix: str) -> Sequence[str]: ...
    def read_resource(self, path: str) -> bytes: ...
    def create_task(
        self, awaitable: Awaitable[Any], *, name: str | None
    ) -> Disposable: ...

    def register_passive_scan(
        self,
        check_id: str,
        title: str,
        handler: Callable[
            [Mapping[str, Any]],
            ScanIssue | Iterable[ScanIssue] | Awaitable[ScanIssue | Iterable[ScanIssue] | None] | None,
        ],
        *,
        description: str | None,
    ) -> Disposable: ...

    def register_active_scan(
        self,
        check_id: str,
        title: str,
        handler: Callable[
            [ActiveScanContext],
            ScanIssue | Iterable[ScanIssue] | Awaitable[ScanIssue | Iterable[ScanIssue] | None] | None,
        ],
        *,
        description: str | None,
    ) -> Disposable: ...


class Actions:
    def __init__(self, host: _Host) -> None:
        self._host = host

    def register(
        self,
        action_id: str,
        title: str,
        handler: Callable[[Mapping[str, Any]], Any],
        *,
        locations: Sequence[ActionLocation] = ("global",),
        description: str | None = None,
    ) -> Disposable:
        return self._host.register_action(
            action_id,
            title,
            handler,
            locations=locations,
            description=description,
        )


class Codecs:
    def __init__(self, host: _Host) -> None:
        self._host = host

    def register(
        self,
        codec_id: str,
        title: str,
        *,
        encode: Callable[[str], str] | None = None,
        decode: Callable[[str], str] | None = None,
    ) -> Disposable:
        return self._host.register_codec(
            codec_id, title, encode=encode, decode=decode
        )


class Payloads:
    def __init__(self, host: _Host) -> None:
        self._host = host

    def register_generator(
        self,
        generator_id: str,
        title: str,
        generator: Callable[[Mapping[str, Any]], Iterable[str] | Awaitable[Iterable[str]]],
        *,
        description: str | None = None,
    ) -> Disposable:
        return self._host.register_payload_generator(
            generator_id, title, generator, description=description
        )

    def register_processor(
        self,
        processor_id: str,
        title: str,
        processor: Callable[[str, Mapping[str, Any]], str | Awaitable[str]],
        *,
        description: str | None = None,
    ) -> Disposable:
        return self._host.register_payload_processor(
            processor_id, title, processor, description=description
        )


class PluginSettings:
    def __init__(self, host: _Host) -> None:
        self._host = host

    def define(self, *fields: SettingDefinition) -> Disposable:
        return self._host.define_settings(fields)

    def get(self, key: str) -> Any:
        return self._host.get_setting(key)

    def set(self, key: str, value: Any) -> None:
        self._host.set_setting(key, value)


class PluginStorage:
    def __init__(self, host: _Host) -> None:
        self._host = host

    def get(
        self, key: str, default: Any = None, *, scope: SettingScope = "project"
    ) -> Any:
        return self._host.get_storage(key, default, scope)

    def set(
        self, key: str, value: Any, *, scope: SettingScope = "project"
    ) -> None:
        self._host.set_storage(key, value, scope)

    def delete(self, key: str, *, scope: SettingScope = "project") -> None:
        self._host.delete_storage(key, scope)


class PluginTasks:
    def __init__(self, host: _Host) -> None:
        self._host = host

    def create(
        self, awaitable: Awaitable[Any], *, name: str | None = None
    ) -> Disposable:
        return self._host.create_task(awaitable, name=name)


class PluginResources:
    """Read integrity-listed package data from the plugin's resources folder."""

    def __init__(self, host: _Host) -> None:
        self._host = host

    def list(self, prefix: str = "") -> tuple[str, ...]:
        return tuple(self._host.list_resources(prefix))

    def read_bytes(self, path: str) -> bytes:
        return self._host.read_resource(path)

    def read_text(self, path: str, *, encoding: str = "utf-8") -> str:
        return self.read_bytes(path).decode(encoding)


class Scanner:
    def __init__(self, host: _Host) -> None:
        self._host = host

    def register_passive(
        self,
        check_id: str,
        title: str,
        handler: Callable[
            [Mapping[str, Any]],
            ScanIssue | Iterable[ScanIssue] | Awaitable[ScanIssue | Iterable[ScanIssue] | None] | None,
        ],
        *,
        description: str | None = None,
    ) -> Disposable:
        return self._host.register_passive_scan(
            check_id, title, handler, description=description
        )

    def register_active(
        self,
        check_id: str,
        title: str,
        handler: Callable[
            [ActiveScanContext],
            ScanIssue | Iterable[ScanIssue] | Awaitable[ScanIssue | Iterable[ScanIssue] | None] | None,
        ],
        *,
        description: str | None = None,
    ) -> Disposable:
        return self._host.register_active_scan(
            check_id, title, handler, description=description
        )


class PluginContext:
    """Capabilities given to a plugin's ``activate`` function."""

    def __init__(self, plugin_id: str, host: _Host) -> None:
        self.plugin_id = plugin_id
        self.api_version = API_VERSION
        self.actions = Actions(host)
        self.codecs = Codecs(host)
        self.payloads = Payloads(host)
        self.settings = PluginSettings(host)
        self.storage = PluginStorage(host)
        self.resources = PluginResources(host)
        self.tasks = PluginTasks(host)
        self.scanner = Scanner(host)
        self.log = logging.getLogger(f"lanius.plugin.{plugin_id}")


__all__ = [
    "API_VERSION",
    "ActionLocation",
    "ActiveScanContext",
    "Disposable",
    "InsertionPoint",
    "InsertionPointKind",
    "IssueConfidence",
    "IssueSeverity",
    "PluginApiError",
    "PluginContext",
    "PluginResources",
    "ScanIssue",
    "SettingDefinition",
    "SettingKind",
    "SettingScope",
]
