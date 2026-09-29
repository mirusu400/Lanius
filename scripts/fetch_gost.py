"""Fetch the pinned GOST binary used for upstream proxy chains.

Run before PyInstaller. The release archives are verified against hashes from
the upstream v3.3.0 release and never committed to the repository.
"""

from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import platform
import tarfile
import urllib.request
import zipfile

VERSION = "3.3.0"
ARCHIVES = {
    ("Darwin", "arm64"): ("darwin_arm64.tar.gz", "f170226106844b50ab3435147f35d4300da773efca256b50cb2f8c7d3a151101"),
    ("Darwin", "x86_64"): ("darwin_amd64.tar.gz", "9be5b30354bbe59b6b160af01c66b209c93335db29b272b67bd73feca4abe4ec"),
    ("Linux", "x86_64"): ("linux_amd64.tar.gz", "676fb7f78d267b6ae73df719c0c7f2b565dde7147da935cfafbc1e1da558b6d5"),
    ("Linux", "aarch64"): ("linux_arm64.tar.gz", "d03699e3f385d4ff5dad68046712adfcc7515325a064d2ab046e0bece30f8f8f"),
    ("Windows", "AMD64"): ("windows_amd64.zip", "cc8ac946f86994a3aed47ef1f838cfb6b7649d9245c91fcb9899654b33d61170"),
    ("Windows", "ARM64"): ("windows_arm64.zip", "f423e10b0e5fac02ca1d2294e008bab16480938055e7620af27aba319979ccac"),
}


def main() -> None:
    try:
        suffix, expected = ARCHIVES[(platform.system(), platform.machine())]
    except KeyError as exc:
        raise SystemExit(f"unsupported GOST platform: {exc}") from exc
    target = Path(__file__).resolve().parents[1] / "engine" / "vendor" / "gost"
    target.mkdir(parents=True, exist_ok=True)
    executable = target / ("gost.exe" if os.name == "nt" else "gost")
    archive_name = f"gost_{VERSION}_{suffix}"
    url = f"https://github.com/go-gost/gost/releases/download/v{VERSION}/{archive_name}"
    with urllib.request.urlopen(url, timeout=60) as response:
        content = response.read()
    actual = hashlib.sha256(content).hexdigest()
    if actual != expected:
        raise SystemExit(f"GOST archive hash mismatch: {actual}")
    if suffix.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            data = archive.read("gost.exe")
    else:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
            entry = next((entry for entry in archive if Path(entry.name).name == "gost"), None)
            if entry is None:
                raise SystemExit("GOST executable missing from archive")
            member = archive.extractfile(entry)
            if member is None:
                raise SystemExit("GOST executable cannot be read")
            data = member.read()
    executable.write_bytes(data)
    executable.chmod(0o755)
    print(f"Downloaded GOST v{VERSION} to {executable}")


if __name__ == "__main__":
    main()
