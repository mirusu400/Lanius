"""Signed plugin catalogue sources, immutable releases, and package updates."""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import re
import ssl
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

import certifi
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version

from lanius_sdk import API_VERSION

from . import __version__
from .lockdown import LockdownBlocked
from .plugin_packages import MAX_ARCHIVE_BYTES, PluginPackageError, PluginPackageManager
from .plugin_trust import OFFICIAL_CATALOGUE_SOURCE

CATALOGUE_SCHEMA = 1
SOURCES_SCHEMA = 1
MAX_CATALOGUE_BYTES = 5 * 1024 * 1024
NETWORK_TIMEOUT_SECONDS = 15.0

_SOURCE_ID = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_PLUGIN_ID = _SOURCE_ID
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class PluginCatalogueError(ValueError):
    """A catalogue source, index, release, or download is invalid."""


@dataclass(frozen=True, slots=True)
class CatalogueSource:
    id: str
    title: str
    url: str
    public_key: str
    key_id: str | None = None
    enabled: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "url": self.url,
            "public_key": self.public_key,
            "key_id": self.key_id,
            "enabled": self.enabled,
        }


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def _signed_payload(value: dict[str, Any]) -> bytes:
    return _canonical({key: item for key, item in value.items() if key != "signature"})


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PluginCatalogueError(f"{label} must be an object")
    return value


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PluginCatalogueError(f"{label} must be a non-empty string")
    return value


def _is_loopback(host: str | None) -> bool:
    if host in {"localhost", "localhost.localdomain"}:
        return True
    try:
        return ipaddress.ip_address(host or "").is_loopback
    except ValueError:
        return False


def _validate_url(value: Any, label: str) -> str:
    url = _string(value, label)
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.netloc:
        return url
    if parsed.scheme == "http" and parsed.netloc and _is_loopback(parsed.hostname):
        return url
    raise PluginCatalogueError(f"{label} must use HTTPS (HTTP is allowed on loopback)")


def _decode_public_key(value: str, label: str) -> bytes:
    try:
        key = base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise PluginCatalogueError(f"invalid {label}") from exc
    if len(key) != 32:
        raise PluginCatalogueError(f"{label} must be a 32-byte Ed25519 key")
    return key


def parse_source(value: Any) -> CatalogueSource:
    raw = _object(value, "catalogue source")
    source_id = _string(raw.get("id"), "catalogue source id")
    if not _SOURCE_ID.fullmatch(source_id):
        raise PluginCatalogueError("catalogue source id has unsupported characters")
    title = _string(raw.get("title", source_id), "catalogue source title")
    url = _validate_url(raw.get("url"), "catalogue source URL")
    public_key = _string(raw.get("public_key"), "catalogue public key")
    _decode_public_key(public_key, "catalogue public key")
    key_id = raw.get("key_id")
    if key_id is not None and (not isinstance(key_id, str) or not key_id):
        raise PluginCatalogueError("catalogue key_id must be a non-empty string")
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise PluginCatalogueError("catalogue source enabled must be a boolean")
    return CatalogueSource(source_id, title, url, public_key, key_id, enabled)


def _compatible(value: Any, current: str, label: str) -> bool:
    text = _string(value, label)
    try:
        return Version(current) in SpecifierSet(text)
    except (InvalidSpecifier, InvalidVersion) as exc:
        raise PluginCatalogueError(f"invalid {label}: {text!r}") from exc


def verify_catalogue(value: Any, source: CatalogueSource) -> dict[str, Any]:
    raw = _object(value, "catalogue")
    if raw.get("schema") != CATALOGUE_SCHEMA:
        raise PluginCatalogueError("catalogue schema must be 1")
    signature = _object(raw.get("signature"), "catalogue signature")
    if signature.get("algorithm") != "ed25519":
        raise PluginCatalogueError("catalogue signature algorithm must be ed25519")
    if source.key_id is not None and signature.get("key_id") != source.key_id:
        raise PluginCatalogueError("catalogue signature key_id does not match the source")
    encoded = _string(signature.get("value"), "catalogue signature value")
    try:
        signed = base64.b64decode(encoded, validate=True)
        Ed25519PublicKey.from_public_bytes(
            _decode_public_key(source.public_key, "catalogue public key")
        ).verify(signed, _signed_payload(raw))
    except (ValueError, InvalidSignature) as exc:
        raise PluginCatalogueError("catalogue signature is invalid") from exc

    plugins = raw.get("plugins")
    if not isinstance(plugins, list):
        raise PluginCatalogueError("catalogue plugins must be a list")
    plugin_ids: set[str] = set()
    releases_seen: set[tuple[str, str]] = set()
    for plugin_value in plugins:
        plugin = _object(plugin_value, "catalogue plugin")
        plugin_id = _string(plugin.get("id"), "catalogue plugin id")
        if not _PLUGIN_ID.fullmatch(plugin_id) or plugin_id in plugin_ids:
            raise PluginCatalogueError(f"invalid or duplicate plugin id: {plugin_id!r}")
        plugin_ids.add(plugin_id)
        _string(plugin.get("name"), "catalogue plugin name")
        releases = plugin.get("releases")
        if not isinstance(releases, list) or not releases:
            raise PluginCatalogueError(f"plugin {plugin_id} must contain releases")
        for release_value in releases:
            release = _object(release_value, "catalogue release")
            version = _string(release.get("version"), "catalogue release version")
            try:
                Version(version)
            except InvalidVersion as exc:
                raise PluginCatalogueError(f"invalid release version: {version!r}") from exc
            identity = (plugin_id, version)
            if identity in releases_seen:
                raise PluginCatalogueError(
                    f"duplicate catalogue release: {plugin_id} {version}"
                )
            releases_seen.add(identity)
            _validate_url(
                urljoin(source.url, _string(release.get("url"), "release URL")),
                "release URL",
            )
            digest = _string(release.get("sha256"), "release SHA-256").lower()
            if not _SHA256.fullmatch(digest):
                raise PluginCatalogueError("release SHA-256 must be lowercase hexadecimal")
            _string(release.get("package_key_id"), "release package_key_id")
            compatibility = _object(release.get("compatibility"), "release compatibility")
            _compatible(compatibility.get("lanius"), __version__, "Lanius compatibility")
            _compatible(compatibility.get("sdk"), API_VERSION, "SDK compatibility")

    revoked = raw.get("revoked", [])
    if not isinstance(revoked, list):
        raise PluginCatalogueError("catalogue revoked must be a list")
    for entry_value in revoked:
        entry = _object(entry_value, "catalogue revocation")
        plugin_id = _string(entry.get("plugin"), "revoked plugin id")
        version = _string(entry.get("version"), "revoked plugin version")
        if plugin_id not in plugin_ids:
            raise PluginCatalogueError(f"revocation references unknown plugin: {plugin_id}")
        try:
            Version(version)
        except InvalidVersion as exc:
            raise PluginCatalogueError(f"invalid revoked version: {version!r}") from exc
        if (plugin_id, version) not in releases_seen:
            raise PluginCatalogueError(
                f"revocation references unknown release: {plugin_id} {version}"
            )
    return dict(raw)


def _release_index(catalogue: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {
        (plugin["id"], release["version"]): release
        for plugin in catalogue["plugins"]
        for release in plugin["releases"]
    }


def ensure_immutable(previous: dict[str, Any], current: dict[str, Any]) -> None:
    before = _release_index(previous)
    after = _release_index(current)
    removed = before.keys() - after.keys()
    if removed:
        plugin_id, version = sorted(removed)[0]
        raise PluginCatalogueError(
            f"published release was removed: {plugin_id} {version}"
        )
    for identity in before.keys() & after.keys():
        if _canonical(before[identity]) != _canonical(after[identity]):
            plugin_id, version = identity
            raise PluginCatalogueError(
                f"published release metadata changed: {plugin_id} {version}"
            )


def _default_fetch(url: str, limit: int) -> bytes:
    _validate_url(url, "download URL")
    request = Request(url, headers={"User-Agent": "Lanius-Plugin-Catalogue/1"})
    try:
        # A frozen Python may not have the build machine's OpenSSL CA path.
        # Keep any available system roots and add the bundle shipped with us.
        tls = ssl.create_default_context()
        tls.load_verify_locations(cafile=certifi.where())
        with urlopen(request, timeout=NETWORK_TIMEOUT_SECONDS, context=tls) as response:
            _validate_url(response.geturl(), "redirected download URL")
            declared = response.headers.get("Content-Length")
            if declared is not None and int(declared) > limit:
                raise PluginCatalogueError("download exceeds the size limit")
            chunks: list[bytes] = []
            size = 0
            while True:
                chunk = response.read(min(1024 * 1024, limit + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise PluginCatalogueError("download exceeds the size limit")
                chunks.append(chunk)
            return b"".join(chunks)
    except PluginCatalogueError:
        raise
    except (OSError, ValueError) as exc:
        raise PluginCatalogueError(f"download failed: {exc}") from exc


class PluginCatalogueManager:
    def __init__(
        self,
        sources_path: Path,
        cache_directory: Path,
        revocations_path: Path,
        packages: PluginPackageManager,
        *,
        fetch: Callable[[str, int], bytes] | None = None,
        lockdown_enabled: Callable[[], bool] | None = None,
    ) -> None:
        self.sources_path = Path(sources_path)
        self.cache_directory = Path(cache_directory)
        self.revocations_path = Path(revocations_path)
        self.packages = packages
        self._fetch = fetch or _default_fetch
        self.lockdown_enabled = lockdown_enabled or (lambda: False)

    def fetch(self, url: str, limit: int) -> bytes:
        """Every catalogue byte arrives through here, so guard it here.

        Refreshing a catalogue and installing a release are Lanius-owned
        downloads: Lockdown Mode refuses them even when a caller forgets to
        check first.
        """
        if self.lockdown_enabled():
            raise LockdownBlocked("plugin catalogue download")
        return self._fetch(url, limit)

    def sources(self) -> list[CatalogueSource]:
        try:
            value = json.loads(self.sources_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return [parse_source(OFFICIAL_CATALOGUE_SOURCE)]
        except (OSError, ValueError, UnicodeError) as exc:
            raise PluginCatalogueError(f"cannot read catalogue sources: {exc}") from exc
        if not isinstance(value, dict) or value.get("schema") != SOURCES_SCHEMA:
            raise PluginCatalogueError("catalogue sources schema must be 1")
        items = value.get("sources")
        if not isinstance(items, list):
            raise PluginCatalogueError("catalogue sources must be a list")
        parsed = [parse_source(item) for item in items]
        if len({item.id for item in parsed}) != len(parsed):
            raise PluginCatalogueError("catalogue source ids must be unique")
        return parsed

    def save_sources(self, values: list[dict[str, Any]]) -> list[dict[str, Any]]:
        sources = [parse_source(value) for value in values]
        if len({item.id for item in sources}) != len(sources):
            raise PluginCatalogueError("catalogue source ids must be unique")
        self.sources_path.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_json(
            self.sources_path,
            {"schema": SOURCES_SCHEMA, "sources": [item.as_dict() for item in sources]},
        )
        self._write_revocations()
        return [item.as_dict() for item in sources]

    def _cache_path(self, source: CatalogueSource) -> Path:
        return self.cache_directory / f"{source.id}.json"

    def _read_cache(self, source: CatalogueSource) -> dict[str, Any]:
        try:
            value = json.loads(self._cache_path(source).read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise PluginCatalogueError(f"catalogue has not been refreshed: {source.id}") from exc
        except (OSError, ValueError, UnicodeError) as exc:
            raise PluginCatalogueError(f"cannot read catalogue cache {source.id}: {exc}") from exc
        return verify_catalogue(value, source)

    def refresh(self) -> dict[str, str]:
        errors: dict[str, str] = {}
        self.cache_directory.mkdir(parents=True, exist_ok=True)
        for source in self.sources():
            if not source.enabled:
                continue
            try:
                payload = self.fetch(source.url, MAX_CATALOGUE_BYTES)
                value = json.loads(payload.decode("utf-8"))
                current = verify_catalogue(value, source)
                # A cache that no longer verifies (typically because the
                # source's signing key was rotated) cannot vouch for what was
                # released before, so it is replaced rather than blocking
                # every refresh until someone deletes it by hand.
                try:
                    previous = self._read_cache(source)
                except PluginCatalogueError:
                    pass
                else:
                    ensure_immutable(previous, current)
                self._atomic_json(self._cache_path(source), current)
            except (PluginCatalogueError, ValueError, UnicodeError) as exc:
                errors[source.id] = str(exc)
        self._write_revocations()
        return errors

    @staticmethod
    def _atomic_json(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(value, stream, ensure_ascii=False, sort_keys=True)
            os.replace(name, path)
        except Exception:
            try:
                os.unlink(name)
            except OSError:
                pass
            raise

    def _cached_catalogues(
        self, *, include_disabled: bool = False
    ) -> tuple[list[tuple[CatalogueSource, dict[str, Any]]], dict[str, str]]:
        catalogues: list[tuple[CatalogueSource, dict[str, Any]]] = []
        errors: dict[str, str] = {}
        for source in self.sources():
            if not source.enabled and not include_disabled:
                continue
            try:
                catalogues.append((source, self._read_cache(source)))
            except PluginCatalogueError as exc:
                errors[source.id] = str(exc)
        return catalogues, errors

    def _write_revocations(self) -> None:
        entries: list[dict[str, Any]] = []
        catalogues, _errors = self._cached_catalogues(include_disabled=True)
        for source, catalogue in catalogues:
            for item in catalogue.get("revoked", []):
                entries.append(
                    {
                        "source": source.id,
                        "plugin": item["plugin"],
                        "version": item["version"],
                        "reason": item.get("reason"),
                    }
                )
        self._atomic_json(
            self.revocations_path,
            {"schema": 1, "entries": entries},
        )

    @staticmethod
    def _revoked_versions(catalogue: dict[str, Any]) -> dict[tuple[str, str], str | None]:
        return {
            (entry["plugin"], entry["version"]): entry.get("reason")
            for entry in catalogue.get("revoked", [])
        }

    def _installed(self) -> dict[str, str]:
        result: dict[str, str] = {}
        if not self.packages.directory.is_dir():
            return result
        for candidate in self.packages.directory.iterdir():
            if candidate.name.startswith(".") or not candidate.is_dir():
                continue
            try:
                from .plugin_packages import load_manifest

                manifest = load_manifest(candidate)
                result[manifest.id] = manifest.version
            except PluginPackageError:
                continue
        return result

    def catalogue(self, *, refresh: bool = False) -> dict[str, Any]:
        refresh_errors = self.refresh() if refresh else {}
        catalogues, cache_errors = self._cached_catalogues()
        installed = self._installed()
        items: list[dict[str, Any]] = []
        for source, catalogue in catalogues:
            revoked = self._revoked_versions(catalogue)
            for plugin in catalogue["plugins"]:
                releases: list[dict[str, Any]] = []
                for raw_release in plugin["releases"]:
                    compatibility = raw_release["compatibility"]
                    compatible = _compatible(
                        compatibility["lanius"], __version__, "Lanius compatibility"
                    ) and _compatible(
                        compatibility["sdk"], API_VERSION, "SDK compatibility"
                    )
                    release = {
                        **raw_release,
                        "compatible": compatible,
                        "revoked": (plugin["id"], raw_release["version"]) in revoked,
                        "revocation_reason": revoked.get(
                            (plugin["id"], raw_release["version"])
                        ),
                    }
                    releases.append(release)
                releases.sort(key=lambda item: Version(item["version"]), reverse=True)
                available = [
                    item
                    for item in releases
                    if item["compatible"]
                    and not item["revoked"]
                    and not item.get("yanked", False)
                ]
                latest = available[0]["version"] if available else None
                current = installed.get(plugin["id"])
                update_available = False
                if latest is not None and current is not None:
                    try:
                        update_available = Version(latest) > Version(current)
                    except InvalidVersion:
                        pass
                items.append(
                    {
                        **{key: value for key, value in plugin.items() if key != "releases"},
                        "source": source.id,
                        "source_title": source.title,
                        "releases": releases,
                        "latest_version": latest,
                        "installed_version": current,
                        "update_available": update_available,
                        "rollback_versions": self.packages.rollback_versions(plugin["id"]),
                    }
                )
        errors = {**cache_errors, **refresh_errors}
        return {
            "sources": [source.as_dict() for source in self.sources()],
            "items": items,
            "errors": errors,
            "refreshed": refresh,
        }

    def _release(
        self, source_id: str, plugin_id: str, version: str | None
    ) -> tuple[CatalogueSource, dict[str, Any], dict[str, Any]]:
        source = next(
            (item for item in self.sources() if item.id == source_id and item.enabled),
            None,
        )
        if source is None:
            raise PluginCatalogueError(f"catalogue source not found: {source_id}")
        catalogue = self._read_cache(source)
        plugin = next(
            (item for item in catalogue["plugins"] if item["id"] == plugin_id),
            None,
        )
        if plugin is None:
            raise PluginCatalogueError(f"catalogue plugin not found: {plugin_id}")
        revoked = self._revoked_versions(catalogue)
        candidates: list[dict[str, Any]] = []
        for release in plugin["releases"]:
            compatible = _compatible(
                release["compatibility"]["lanius"], __version__, "Lanius compatibility"
            ) and _compatible(
                release["compatibility"]["sdk"], API_VERSION, "SDK compatibility"
            )
            if version is not None and release["version"] != version:
                continue
            if not compatible:
                continue
            if (plugin_id, release["version"]) in revoked or release.get("yanked", False):
                continue
            candidates.append(release)
        if not candidates:
            requested = version or "a compatible release"
            raise PluginCatalogueError(
                f"catalogue release is unavailable: {plugin_id} {requested}"
            )
        candidates.sort(key=lambda item: Version(item["version"]), reverse=True)
        return source, plugin, candidates[0]

    def install(
        self, source_id: str, plugin_id: str, version: str | None = None
    ) -> dict[str, Any]:
        source, _plugin, release = self._release(source_id, plugin_id, version)
        target = self.packages.directory / plugin_id
        if target.is_dir():
            from .plugin_packages import load_manifest

            current = load_manifest(target)
            if current.version == release["version"]:
                raise PluginCatalogueError(
                    f"plugin version is already installed: {plugin_id} {current.version}"
                )
        url = _validate_url(urljoin(source.url, release["url"]), "release URL")
        archive = self.fetch(url, MAX_ARCHIVE_BYTES)
        digest = hashlib.sha256(archive).hexdigest()
        if digest != release["sha256"]:
            raise PluginCatalogueError("downloaded package SHA-256 does not match the catalogue")
        try:
            return self.packages.install(
                archive,
                allow_unsigned=False,
                replace=target.exists(),
                keep_backup=target.exists(),
                expected_id=plugin_id,
                expected_version=release["version"],
                expected_key_id=release["package_key_id"],
                install_record={
                    "source": "catalogue",
                    "catalog_source": source.id,
                    "catalogue_url": source.url,
                    "release_url": url,
                    "archive_sha256": digest,
                },
            )
        except PluginPackageError as exc:
            raise PluginCatalogueError(str(exc)) from exc
