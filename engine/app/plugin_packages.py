"""Install and validate ``.lanius-plugin`` package archives."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version

from lanius_sdk import API_VERSION

from . import __version__

MANIFEST_NAME = "plugin.json"
INSTALL_RECORD = ".lanius-install.json"
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_EXTRACTED_BYTES = 100 * 1024 * 1024
MAX_FILES = 2_000

_PLUGIN_ID = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class PluginPackageError(ValueError):
    """A package is malformed, incompatible, or cannot be installed."""


@dataclass(frozen=True, slots=True)
class PluginManifest:
    raw: dict[str, Any]
    id: str
    name: str
    version: str
    description: str | None
    author: str | dict[str, Any] | None
    backend_entrypoint: str
    ui: dict[str, Any] | None
    permissions: tuple[str, ...]
    integrity: dict[str, str]
    signature: dict[str, Any] | None

    def metadata(self, root: Path) -> dict[str, Any]:
        author = self.author
        if isinstance(author, dict):
            author = author.get("name")
        views = []
        if self.ui:
            for view in self.ui.get("views", []):
                views.append(
                    {
                        "id": view["id"],
                        "title": view["title"],
                        "entrypoint": view["entrypoint"],
                    }
                )
        try:
            installed = json.loads((root / INSTALL_RECORD).read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            installed = {}
        if not isinstance(installed, dict):
            installed = {}
        return {
            "description": self.description,
            "version": self.version,
            "author": author,
            "hooks": [],
            "package": {
                "schema": self.raw["schema"],
                "id": self.id,
                "name": self.name,
                "permissions": list(self.permissions),
                "signature_present": self.signature is not None,
                "trust": "development" if root.is_symlink() else installed.get("trust", "unmanaged"),
                "development": root.is_symlink(),
            },
            "ui": {"views": views} if views else None,
        }


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PluginPackageError(f"{label} must be an object")
    return value


def _nonempty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PluginPackageError(f"{label} must be a non-empty string")
    return value


def _safe_relative(value: Any, label: str) -> str:
    text = _nonempty_string(value, label)
    path = PurePosixPath(text)
    if path.is_absolute() or ".." in path.parts or "\\" in text:
        raise PluginPackageError(f"{label} must stay inside the package")
    return path.as_posix()


def _compatible(specifier: Any, current: str, label: str) -> None:
    text = _nonempty_string(specifier, label)
    try:
        spec = SpecifierSet(text)
        version = Version(current)
    except (InvalidSpecifier, InvalidVersion) as exc:
        raise PluginPackageError(f"invalid {label}: {text!r}") from exc
    if version not in spec:
        raise PluginPackageError(
            f"{label} {text!r} does not include current version {current}"
        )


def parse_manifest(value: Any) -> PluginManifest:
    raw = _object(value, "manifest")
    if raw.get("schema") != 1:
        raise PluginPackageError("manifest schema must be 1")
    plugin_id = _nonempty_string(raw.get("id"), "id")
    if not _PLUGIN_ID.fullmatch(plugin_id):
        raise PluginPackageError("id has unsupported characters")
    name = _nonempty_string(raw.get("name"), "name")
    version = _nonempty_string(raw.get("version"), "version")
    try:
        Version(version)
    except InvalidVersion as exc:
        raise PluginPackageError(f"invalid plugin version: {version!r}") from exc

    compatibility = _object(raw.get("compatibility"), "compatibility")
    _compatible(compatibility.get("lanius"), __version__, "Lanius compatibility")
    _compatible(compatibility.get("sdk"), API_VERSION, "SDK compatibility")

    backend = _object(raw.get("backend"), "backend")
    if backend.get("runtime", "trusted") != "trusted":
        raise PluginPackageError("schema 1 supports the trusted backend runtime")
    backend_entrypoint = _safe_relative(
        backend.get("entrypoint"), "backend.entrypoint"
    )
    if not backend_entrypoint.endswith(".py"):
        raise PluginPackageError("backend.entrypoint must be a Python file")

    permissions_value = raw.get("permissions", [])
    if not isinstance(permissions_value, list) or not all(
        isinstance(permission, str) and permission for permission in permissions_value
    ):
        raise PluginPackageError("permissions must be a list of strings")

    ui_value = raw.get("ui")
    ui = _object(ui_value, "ui") if ui_value is not None else None
    if ui is not None:
        views = ui.get("views")
        if not isinstance(views, list) or not views:
            raise PluginPackageError("ui.views must be a non-empty list")
        seen_views: set[str] = set()
        for view_value in views:
            view = _object(view_value, "ui view")
            view_id = _nonempty_string(view.get("id"), "ui view id")
            if not _PLUGIN_ID.fullmatch(view_id) or view_id in seen_views:
                raise PluginPackageError(f"invalid or duplicate UI view id: {view_id!r}")
            seen_views.add(view_id)
            _nonempty_string(view.get("title"), "ui view title")
            entrypoint = _safe_relative(
                view.get("entrypoint"), "ui view entrypoint"
            )
            if not entrypoint.startswith("ui/") or not entrypoint.endswith(".html"):
                raise PluginPackageError("UI entrypoints must be HTML files under ui/")

    integrity_value = _object(raw.get("integrity"), "integrity")
    files_value = _object(integrity_value.get("files"), "integrity.files")
    integrity: dict[str, str] = {}
    for path_value, digest_value in files_value.items():
        path = _safe_relative(path_value, "integrity path")
        if path in {MANIFEST_NAME, INSTALL_RECORD}:
            raise PluginPackageError(f"integrity cannot include {path}")
        if not isinstance(digest_value, str) or not _HEX_SHA256.fullmatch(
            digest_value.lower()
        ):
            raise PluginPackageError(f"invalid SHA-256 for {path}")
        integrity[path] = digest_value.lower()
    if backend_entrypoint not in integrity:
        raise PluginPackageError("backend entrypoint is missing from integrity.files")
    if ui:
        for view in ui["views"]:
            if view["entrypoint"] not in integrity:
                raise PluginPackageError(
                    f"UI entrypoint {view['entrypoint']!r} is missing from integrity.files"
                )

    signature_value = raw.get("signature")
    signature = (
        _object(signature_value, "signature")
        if signature_value is not None
        else None
    )
    return PluginManifest(
        raw=dict(raw),
        id=plugin_id,
        name=name,
        version=version,
        description=raw.get("description") if isinstance(raw.get("description"), str) else None,
        author=raw.get("author") if isinstance(raw.get("author"), (str, dict)) else None,
        backend_entrypoint=backend_entrypoint,
        ui=ui,
        permissions=tuple(dict.fromkeys(permissions_value)),
        integrity=integrity,
        signature=signature,
    )


def load_manifest(root: Path) -> PluginManifest:
    try:
        value = json.loads((root / MANIFEST_NAME).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PluginPackageError(f"package is missing {MANIFEST_NAME}") from exc
    except (OSError, ValueError, UnicodeError) as exc:
        raise PluginPackageError(f"cannot read {MANIFEST_NAME}: {exc}") from exc
    manifest = parse_manifest(value)
    if not (root / manifest.backend_entrypoint).is_file():
        raise PluginPackageError("backend entrypoint does not exist")
    if manifest.ui:
        for view in manifest.ui["views"]:
            if not (root / view["entrypoint"]).is_file():
                raise PluginPackageError(
                    f"UI entrypoint does not exist: {view['entrypoint']}"
                )
    return manifest


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_integrity(root: Path, manifest: PluginManifest) -> None:
    actual = {
        path.relative_to(root).as_posix(): file_sha256(path)
        for path in root.rglob("*")
        if path.is_file()
        and path.name != MANIFEST_NAME
        and path.name != INSTALL_RECORD
    }
    expected = manifest.integrity
    if actual.keys() != expected.keys():
        missing = sorted(expected.keys() - actual.keys())
        extra = sorted(actual.keys() - expected.keys())
        raise PluginPackageError(
            f"integrity file list differs (missing={missing}, extra={extra})"
        )
    for path, digest in expected.items():
        if actual[path] != digest:
            raise PluginPackageError(f"SHA-256 mismatch for {path}")


def _signature_payload(manifest: PluginManifest) -> bytes:
    value = {key: item for key, item in manifest.raw.items() if key != "signature"}
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def load_trusted_keys(path: Path | None) -> dict[str, bytes]:
    if path is None or not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise PluginPackageError(f"cannot read trusted keys: {exc}") from exc
    if not isinstance(value, dict):
        raise PluginPackageError("trusted keys must be a JSON object")
    keys: dict[str, bytes] = {}
    for key_id, encoded in value.items():
        try:
            keys[str(key_id)] = base64.b64decode(str(encoded), validate=True)
        except ValueError as exc:
            raise PluginPackageError(f"invalid public key {key_id!r}") from exc
    return keys


def verify_signature(
    manifest: PluginManifest, trusted_keys: dict[str, bytes]
) -> str:
    if manifest.signature is None:
        return "unsigned"
    algorithm = manifest.signature.get("algorithm")
    key_id = manifest.signature.get("key_id")
    encoded = manifest.signature.get("value")
    if algorithm != "ed25519" or not isinstance(key_id, str) or not isinstance(encoded, str):
        raise PluginPackageError("signature must contain ed25519, key_id, and value")
    key = trusted_keys.get(key_id)
    if key is None:
        raise PluginPackageError(f"signature key is not trusted: {key_id}")
    try:
        signature = base64.b64decode(encoded, validate=True)
        Ed25519PublicKey.from_public_bytes(key).verify(
            signature, _signature_payload(manifest)
        )
    except (ValueError, InvalidSignature) as exc:
        raise PluginPackageError("package signature is invalid") from exc
    return "trusted"


class PluginPackageManager:
    def __init__(
        self,
        directory: Path,
        *,
        trusted_keys_path: Path | None = None,
        development_mode: bool = False,
    ) -> None:
        self.directory = Path(directory)
        self.trusted_keys_path = trusted_keys_path
        self.development_mode = development_mode

    def inspect(self, root: Path) -> tuple[PluginManifest, str]:
        """Validate an installed package again before it can execute."""

        manifest = load_manifest(root)
        if root.is_symlink():
            if not self.development_mode:
                raise PluginPackageError("development package found while dev mode is disabled")
            return manifest, "development"
        verify_integrity(root, manifest)
        trust = verify_signature(manifest, load_trusted_keys(self.trusted_keys_path))
        return manifest, trust

    def _validate_archive_entry(self, item: zipfile.ZipInfo) -> str:
        path = _safe_relative(item.filename, "archive path")
        mode = item.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise PluginPackageError(f"archive contains a symbolic link: {path}")
        return path

    def install(
        self,
        archive: bytes,
        *,
        allow_unsigned: bool = True,
        replace: bool = False,
    ) -> dict[str, Any]:
        if len(archive) > MAX_ARCHIVE_BYTES:
            raise PluginPackageError("package archive exceeds 50 MiB")
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix=".install-", dir=self.directory))
        try:
            archive_path = temporary / "package.zip"
            archive_path.write_bytes(archive)
            extract_root = temporary / "contents"
            extract_root.mkdir()
            try:
                with zipfile.ZipFile(archive_path) as package:
                    files = [item for item in package.infolist() if not item.is_dir()]
                    if len(files) > MAX_FILES:
                        raise PluginPackageError("package contains too many files")
                    if sum(item.file_size for item in files) > MAX_EXTRACTED_BYTES:
                        raise PluginPackageError("expanded package exceeds 100 MiB")
                    seen: set[str] = set()
                    for item in files:
                        relative = self._validate_archive_entry(item)
                        if relative in seen:
                            raise PluginPackageError(
                                f"package contains a duplicate path: {relative}"
                            )
                        seen.add(relative)
                        target = extract_root / relative
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with package.open(item) as source, target.open("wb") as output:
                            shutil.copyfileobj(source, output)
            except (zipfile.BadZipFile, OSError) as exc:
                raise PluginPackageError(f"invalid package archive: {exc}") from exc

            manifest = load_manifest(extract_root)
            verify_integrity(extract_root, manifest)
            trust = verify_signature(manifest, load_trusted_keys(self.trusted_keys_path))
            if trust == "unsigned" and not allow_unsigned:
                raise PluginPackageError("unsigned packages are not allowed")

            target = self.directory / manifest.id
            if target.exists() or target.is_symlink():
                if not replace:
                    raise PluginPackageError(f"plugin is already installed: {manifest.id}")
                backup = temporary / "previous"
                os.replace(target, backup)
            else:
                backup = None
            try:
                (extract_root / INSTALL_RECORD).write_text(
                    json.dumps(
                        {
                            "source": "archive",
                            "trust": trust,
                            "version": manifest.version,
                        },
                        sort_keys=True,
                    ),
                    encoding="utf-8",
                )
                os.replace(extract_root, target)
            except Exception:
                if backup is not None and backup.exists():
                    os.replace(backup, target)
                raise
            return {
                "id": manifest.id,
                "name": manifest.name,
                "version": manifest.version,
                "trust": trust,
                "development": False,
            }
        finally:
            shutil.rmtree(temporary, ignore_errors=True)

    def install_development(self, source: Path) -> dict[str, Any]:
        if not self.development_mode:
            raise PluginPackageError("plugin development mode is disabled")
        source = source.expanduser().resolve(strict=True)
        manifest = load_manifest(source)
        target = self.directory / manifest.id
        self.directory.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            raise PluginPackageError(f"plugin is already installed: {manifest.id}")
        target.symlink_to(source, target_is_directory=True)
        return {
            "id": manifest.id,
            "name": manifest.name,
            "version": manifest.version,
            "trust": "development",
            "development": True,
        }

    def uninstall(self, plugin_id: str) -> dict[str, Any]:
        if not _PLUGIN_ID.fullmatch(plugin_id):
            raise PluginPackageError("invalid plugin id")
        target = self.directory / plugin_id
        if target.is_symlink():
            target.unlink()
        elif target.is_dir() and (target / MANIFEST_NAME).is_file():
            shutil.rmtree(target)
        else:
            raise PluginPackageError(f"installed package not found: {plugin_id}")
        return {"id": plugin_id, "uninstalled": True}

    def installed_record(self, root: Path) -> dict[str, Any] | None:
        try:
            value = json.loads((root / INSTALL_RECORD).read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return None
        return value if isinstance(value, dict) else None
