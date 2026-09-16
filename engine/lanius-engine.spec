# PyInstaller spec: standalone Lanius engine for the desktop bundle.
import os
import subprocess
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


def _stamp_build_info():
    """Freeze the commit and release into the binary.

    A frozen binary has no repository to ask at runtime, and reading an
    environment variable then would describe whoever launched it rather
    than whoever built it. The values are written to a module that the
    build includes, and deleted again afterwards so a checkout is not
    left with a generated file in it.
    """

    def git(*args):
        try:
            out = subprocess.run(
                ["git", *args], capture_output=True, text=True, timeout=5, check=False
            )
        except (OSError, subprocess.SubprocessError):
            return None
        return out.stdout.strip() or None if out.returncode == 0 else None

    commit = os.environ.get("LANIUS_BUILD_COMMIT") or git("rev-parse", "HEAD")
    release = os.environ.get("LANIUS_BUILD_RELEASE") or git(
        "describe", "--tags", "--exact-match"
    )
    date = os.environ.get("LANIUS_BUILD_DATE")
    dirty = bool(git("status", "--porcelain")) if not os.environ.get(
        "LANIUS_BUILD_COMMIT"
    ) else False

    target = Path("app/_build_stamp.py")
    target.write_text(
        '"""Written by the build. Not checked in."""\n\n'
        f"COMMIT = {commit!r}\n"
        f"RELEASE = {release!r}\n"
        f"BUILT_AT = {date!r}\n"
        f"DIRTY = {dirty!r}\n",
        encoding="utf-8",
    )
    return target


_stamp = _stamp_build_info()

datas, binaries, hiddenimports = [], [], []
for package in ("mitmproxy", "mcp"):
    # mcp.cli needs typer/rich, which we do not ship: skip that subpackage.
    d, b, h = collect_all(package, filter_submodules=lambda n: "mcp.cli" not in n)
    datas += d
    binaries += b
    hiddenimports += h
hiddenimports += collect_submodules("app")
hiddenimports += ["uvicorn.logging", "uvicorn.protocols", "uvicorn.lifespan"]
excludes = ["mcp.cli", "typer", "tkinter", "matplotlib", "PyInstaller"]

a = Analysis(
    ["engine_main.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="lanius-engine",
    console=True,
    strip=False,
    upx=False,
)

# The stamp exists only for the duration of the build.
_stamp.unlink(missing_ok=True)
