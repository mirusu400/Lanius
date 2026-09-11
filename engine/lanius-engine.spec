# PyInstaller spec: standalone Lanius engine for the desktop bundle.
from PyInstaller.utils.hooks import collect_all, collect_submodules

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
