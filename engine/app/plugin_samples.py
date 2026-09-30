"""Discovery and packaging for examples shipped with the engine."""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path
from typing import Any

from .plugin_packages import load_manifest, verify_integrity


def samples_directory() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "plugin-samples"  # type: ignore[attr-defined]
    return Path(__file__).resolve().parents[1] / "plugin_samples"


def bundled_samples() -> list[dict[str, Any]]:
    root = samples_directory()
    if not root.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for package_root in sorted(root.iterdir()):
        if not package_root.is_dir() or not (package_root / "plugin.json").is_file():
            continue
        manifest = load_manifest(package_root)
        verify_integrity(package_root, manifest)
        author = manifest.author
        if isinstance(author, dict):
            author = author.get("name")
        items.append(
            {
                "id": manifest.id,
                "name": manifest.name,
                "version": manifest.version,
                "description": manifest.description,
                "author": author,
            }
        )
    return items


def bundled_sample_archive(plugin_id: str) -> bytes:
    matches = [item for item in bundled_samples() if item["id"] == plugin_id]
    if not matches:
        raise KeyError(plugin_id)
    root = samples_directory()
    package_root = next(
        candidate
        for candidate in root.iterdir()
        if candidate.is_dir() and load_manifest(candidate).id == plugin_id
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(package_root.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                archive.write(path, path.relative_to(package_root).as_posix())
    return output.getvalue()
