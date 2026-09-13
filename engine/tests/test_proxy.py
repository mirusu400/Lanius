from __future__ import annotations

import os
from pathlib import Path

import asyncio
import socket

import pytest

from app.config import Settings
from app.db.store import FlowStore
from app.events import EventBroker
from app.proxy import ProxyEngine, ProxyStartError


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def engine(tmp_path, port: int) -> ProxyEngine:
    settings = Settings(
        proxy_port=port,
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "p.sqlite",
        confdir=tmp_path / "mitm",
    )
    return ProxyEngine(settings, FlowStore(settings.db_path), EventBroker())


def _await_exit(pid: int, timeout: float = 15.0) -> bool:
    """Wait for a pid to disappear. Uses the engine's own liveness probe so
    the check works on Windows as well as POSIX."""
    import time as _time

    from app.main import _pid_alive

    deadline = _time.time() + timeout
    while _time.time() < deadline:
        if not _pid_alive(pid):
            return True
        _time.sleep(0.25)
    return False


def _force_kill(pid: int) -> None:
    """Best-effort cleanup of a test child on any platform."""
    import subprocess

    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )
        return
    try:
        os.kill(pid, 9)
    except OSError:
        pass


@pytest.mark.asyncio
async def test_start_binds_and_accepts_connections(tmp_path) -> None:
    port = free_port()
    eng = engine(tmp_path, port)
    await eng.start()
    assert eng.running
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.close()
    await eng.stop()
    assert not eng.running
    eng.store.close()


@pytest.mark.asyncio
async def test_start_raises_when_port_is_taken(tmp_path) -> None:
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    port = blocker.getsockname()[1]
    eng = engine(tmp_path, port)
    try:
        # mitmproxy refuses to bind; start() must fail fast, not silently.
        with pytest.raises(ProxyStartError):
            await eng.start()
    finally:
        blocker.close()
        eng.store.close()


# --- CLI / watchdog -------------------------------------------------------


def test_parse_args_defaults() -> None:
    from app.main import parse_args

    settings, watch = parse_args([])
    assert settings.proxy_port == 8080
    assert settings.api_port == 8081
    assert watch is False


def test_parse_args_overrides() -> None:
    from app.main import parse_args

    settings, watch = parse_args(
        ["--proxy-port", "9090", "--api-port", "9091", "--watch-parent"]
    )
    assert settings.proxy_port == 9090
    assert settings.api_port == 9091
    assert watch is True


def test_watchdog_exits_when_the_parent_dies(tmp_path) -> None:
    """The sidecar must not outlive the desktop shell (verified for real)."""
    import subprocess
    import sys
    import time as _time

    engine_dir = str(Path(__file__).resolve().parents[1])
    child_code = (
        "import os, sys, time\n"
        f"sys.path.insert(0, {engine_dir!r})\n"
        "from app.main import watch_parent\n"
        "watch_parent(os.getppid())\n"
        "time.sleep(30)\n"
    )
    pid_file = tmp_path / "child.pid"
    launcher_code = (
        "import os, subprocess, sys, time\n"
        f"child = subprocess.Popen([sys.executable, '-c', {child_code!r}])\n"
        f"open({str(pid_file)!r}, 'w').write(str(child.pid))\n"
        "time.sleep(1)\n"
        "os._exit(0)\n"  # die hard: no cleanup, like a crashed shell
    )
    subprocess.run([sys.executable, "-c", launcher_code], timeout=30, check=False)
    child_pid = int(pid_file.read_text())

    if _await_exit(child_pid):
        return  # child exited: watchdog worked
    _force_kill(child_pid)
    raise AssertionError("watchdog did not stop the orphaned engine")


def test_pid_alive_detects_a_dead_process() -> None:
    from app.main import _pid_alive

    assert _pid_alive(os.getpid()) is True
    # PID 1 is treated as "no supervisor" and never triggers a shutdown.
    assert _pid_alive(1) is True

    import subprocess
    import sys

    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    # Reap, then a definitely-unused PID must read as dead.
    assert _pid_alive(999_999) is False


def test_watchdog_uses_an_explicit_supervisor_pid(tmp_path) -> None:
    """Regression: PyInstaller's bootloader stays as the direct parent, so
    getppid() never changed and the engine outlived a SIGKILLed shell."""
    import subprocess
    import sys
    import time as _time

    engine_dir = str(Path(__file__).resolve().parents[1])
    pid_file = tmp_path / "child.pid"

    # A supervisor that is NOT the child's direct parent: the launcher spawns
    # a middleman, mirroring the bootloader arrangement.
    child_code = (
        "import os, sys, time\n"
        f"sys.path.insert(0, {engine_dir!r})\n"
        "from app.main import watch_parent\n"
        "watch_parent(int(os.environ['SUPERVISOR']))\n"
        "time.sleep(30)\n"
    )
    launcher_code = (
        "import os, subprocess, sys, time\n"
        "env = dict(os.environ, SUPERVISOR=str(os.getpid()))\n"
        f"child = subprocess.Popen([sys.executable, '-c', {child_code!r}], env=env)\n"
        f"open({str(pid_file)!r}, 'w').write(str(child.pid))\n"
        "time.sleep(1)\n"
        "os._exit(0)\n"
    )
    subprocess.run([sys.executable, "-c", launcher_code], timeout=30, check=False)
    child_pid = int(pid_file.read_text())

    if _await_exit(child_pid):
        return
    _force_kill(child_pid)
    raise AssertionError("watchdog ignored the explicit supervisor pid")


# --- cross-platform helpers -----------------------------------------------


def test_request_shutdown_picks_the_right_signal(monkeypatch) -> None:
    """Windows cannot deliver SIGTERM to itself, so SIGINT is used there."""
    import signal as signal_module

    from app import main as main_module

    sent: list[int] = []
    monkeypatch.setattr(main_module.os, "kill", lambda _pid, sig: sent.append(sig))

    monkeypatch.setattr(main_module.os, "name", "posix")
    main_module._request_shutdown()
    assert sent == [signal_module.SIGTERM]

    sent.clear()
    monkeypatch.setattr(main_module.os, "name", "nt")
    main_module._request_shutdown()
    assert sent == [signal_module.SIGINT]


def test_request_shutdown_survives_a_failing_kill(monkeypatch) -> None:
    from app import main as main_module

    def boom(_pid, _sig):
        raise OSError("not permitted")

    monkeypatch.setattr(main_module.os, "kill", boom)
    main_module._request_shutdown()  # must not raise


def test_pid_alive_uses_the_windows_probe(monkeypatch) -> None:
    """On Windows os.kill(pid, 0) is unreliable, so a different path is taken."""
    from app import main as main_module

    called: list[int] = []
    monkeypatch.setattr(main_module.os, "name", "nt")
    monkeypatch.setattr(
        main_module, "_pid_alive_windows", lambda pid: called.append(pid) or True
    )
    assert main_module._pid_alive(4321) is True
    assert called == [4321]


def test_pid_alive_still_short_circuits_on_windows(monkeypatch) -> None:
    from app import main as main_module

    monkeypatch.setattr(main_module.os, "name", "nt")
    monkeypatch.setattr(
        main_module,
        "_pid_alive_windows",
        lambda _pid: pytest.fail("should not probe pid 1"),
    )
    assert main_module._pid_alive(1) is True


def test_windows_probe_reports_a_running_process(monkeypatch) -> None:
    """The Win32 branch never runs on CI's POSIX hosts, so drive it with a
    stand-in kernel32 to prove the logic and the declared signatures."""
    import ctypes

    from app import main as main_module

    closed: list[int] = []

    class FakeKernel32:
        def __init__(self) -> None:
            self.OpenProcess = _Fn(lambda _access, _inherit, pid: 0x1234 if pid == 42 else 0)
            self.GetExitCodeProcess = _Fn(self._exit_code)
            self.CloseHandle = _Fn(lambda handle: closed.append(handle) or 1)

        @staticmethod
        def _exit_code(_handle, out) -> int:
            out._obj.value = 259  # STILL_ACTIVE
            return 1

    monkeypatch.setattr(main_module, "_kernel32", FakeKernel32)

    assert main_module._pid_alive_windows(42) is True
    assert closed == [0x1234], "the handle must be released"

    # OpenProcess returning NULL means the pid is gone.
    assert main_module._pid_alive_windows(99) is False

    del ctypes


class _Fn:
    """Mimics a ctypes foreign function, which carries restype/argtypes."""

    def __init__(self, impl) -> None:
        self._impl = impl
        self.restype = None
        self.argtypes = None

    def __call__(self, *args):
        return self._impl(*args)


def test_windows_probe_treats_an_exited_process_as_dead(monkeypatch) -> None:
    """A pid whose handle still opens but has an exit code is not alive.
    This is the case os.kill(pid, 0) gets wrong on Windows."""
    from app import main as main_module

    class FakeKernel32:
        def __init__(self) -> None:
            self.OpenProcess = _Fn(lambda *_: 0x1234)
            self.GetExitCodeProcess = _Fn(self._exit_code)
            self.CloseHandle = _Fn(lambda _handle: 1)

        @staticmethod
        def _exit_code(_handle, out) -> int:
            out._obj.value = 0  # exited normally
            return 1

    monkeypatch.setattr(main_module, "_kernel32", FakeKernel32)
    assert main_module._pid_alive_windows(42) is False


def test_windows_probe_declares_pointer_sized_handles(monkeypatch) -> None:
    """ctypes defaults return values to c_int, which truncates a 64-bit
    HANDLE and makes CloseHandle close the wrong thing."""
    import ctypes

    from app import main as main_module

    fake = type(
        "K",
        (),
        {
            "OpenProcess": _Fn(lambda *_: 0),
            "GetExitCodeProcess": _Fn(lambda *_: 1),
            "CloseHandle": _Fn(lambda *_: 1),
        },
    )
    instance = fake()
    monkeypatch.setattr(main_module, "_kernel32", lambda: instance)

    main_module._pid_alive_windows(1)

    assert instance.OpenProcess.restype is ctypes.c_void_p
    assert instance.CloseHandle.argtypes == [ctypes.c_void_p]
