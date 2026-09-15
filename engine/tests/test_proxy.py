from __future__ import annotations

import os
from pathlib import Path

import asyncio
import socket
from unittest import mock

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
    # The pid to watch is passed in rather than read with getppid(): on a
    # slow machine the launcher can die before the child reaches this line,
    # and getppid() would then report the reaper instead of the launcher.
    # That is the shell's real arrangement, which passes its own pid.
    child_code = (
        "import os, sys, time\n"
        f"sys.path.insert(0, {engine_dir!r})\n"
        "from app.main import watch_parent\n"
        "watch_parent(int(sys.argv[1]))\n"
        "time.sleep(30)\n"
    )
    pid_file = tmp_path / "child.pid"
    launcher_code = (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen(\n"
        f"    [sys.executable, '-c', {child_code!r}, str(os.getpid())]\n"
        ")\n"
        f"open({str(pid_file)!r}, 'w').write(str(child.pid))\n"
        "time.sleep(1)\n"
        "os._exit(0)\n"  # die hard: no cleanup, like a crashed shell
    )
    subprocess.run([sys.executable, "-c", launcher_code], timeout=30, check=False)
    child_pid = int(pid_file.read_text())

    if _await_exit(child_pid):
        return  # child exited: watchdog worked
    _force_kill(child_pid)
    raise AssertionError(
        f"watchdog did not stop the orphaned engine (pid {child_pid} still "
        "alive after 15s)"
    )


def test_supervisor_pid_treats_a_reparented_engine_as_orphaned() -> None:
    """An engine that has already lost its parent must not watch the reaper.

    Without this, getppid() returns 1 after reparenting, _pid_alive treats
    pid 1 as "no supervisor" and answers True forever, and the watchdog
    sleeps while the proxy keeps holding its ports.
    """
    from app.main import _supervisor_pid

    with mock.patch.dict(os.environ, {}, clear=True):
        with mock.patch("os.getppid", return_value=1):
            assert _supervisor_pid() is None
        with mock.patch("os.getppid", return_value=4242):
            assert _supervisor_pid() == 4242

    with mock.patch.dict(os.environ, {"LANIUS_SUPERVISOR_PID": "99"}):
        assert _supervisor_pid() == 99

    # A malformed value must not crash the engine on startup.
    with mock.patch.dict(os.environ, {"LANIUS_SUPERVISOR_PID": "nonsense"}):
        with mock.patch("os.getppid", return_value=7):
            assert _supervisor_pid() == 7


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


# --- mode status -------------------------------------------------------------


@pytest.mark.asyncio
async def test_mode_status_reports_the_regular_proxy(tmp_path) -> None:
    port = free_port()
    eng = engine(tmp_path, port)
    await eng.start()
    try:
        modes = eng.mode_status()
        # The port is named on the mode so the list stays switchable.
        assert [m["spec"] for m in modes] == [f"regular@{port}"]
        assert modes[0]["running"] is True
        assert modes[0]["listening"] is True, "a regular proxy binds an address"
        assert modes[0]["error"] is None
    finally:
        await eng.stop()


def test_mode_status_is_empty_before_start(tmp_path) -> None:
    """The API reads this during startup, so it must not blow up."""
    assert engine(tmp_path, free_port()).mode_status() == []


@pytest.mark.asyncio
async def test_failed_modes_are_logged_and_published(tmp_path, caplog) -> None:
    """mitmproxy keeps running when one mode fails, and we removed its
    errorcheck addon, so a failure would otherwise be invisible."""
    port = free_port()
    eng = engine(tmp_path, port)
    await eng.start()
    try:
        published: list[tuple[str, object]] = []
        eng.broker.publish = lambda topic, data: published.append((topic, data))

        eng.mode_status = lambda: [  # type: ignore[method-assign]
            {"spec": "regular", "running": True, "listening": True, "error": None},
            {
                "spec": "local:curl",
                "running": False,
                "listening": False,
                "error": "boom",
            },
        ]
        with caplog.at_level("ERROR"):
            eng._report_mode_failures()

        assert "local:curl" in caplog.text
        assert "boom" in caplog.text
        # The local mode also raises the approval warning, which is a
        # separate signal; this test is about the failure being reported.
        failures = [d for t, d in published if t == "engine.mode_failed"]
        assert [f["spec"] for f in failures] == ["local:curl"]  # type: ignore[index]
    finally:
        await eng.stop()


def test_mode_status_cannot_detect_a_hung_mode(tmp_path) -> None:
    """Documents a real limitation rather than asserting a feature.

    mitmproxy marks a mode as running once its task is spawned. Local
    capture on macOS then blocks forever waiting for the user to approve
    the system extension, so it reports running with no error, and it
    never binds an address even when healthy. Nothing in mode_status can
    distinguish that from success; detecting it needs the platform's own
    extension state.
    """
    eng = engine(tmp_path, free_port())
    eng.master = _FakeMaster(
        [("local:curl", True, (), None)],
    )
    (mode,) = eng.mode_status()
    assert mode["running"] is True
    assert mode["error"] is None
    assert mode["listening"] is False  # also true of a healthy local mode


class _FakeSpec:
    def __init__(self, spec: str) -> None:
        self.full_spec = spec


class _FakeInstance:
    def __init__(self, running: bool, addrs: tuple, error: object) -> None:
        self.is_running = running
        self.listen_addrs = addrs
        self.last_exception = error


class _FakeServers:
    def __init__(self, rows: list) -> None:
        self._instances = {
            _FakeSpec(spec): _FakeInstance(running, addrs, error)
            for spec, running, addrs, error in rows
        }


class _FakeMaster:
    """Stands in for DumpMaster so mode combinations can be exercised
    without starting a real proxy for each one."""

    def __init__(self, rows: list) -> None:
        self._servers = _FakeServers(rows)
        self.addons = self

    def get(self, name: str):
        if name != "proxyserver":
            return None
        return self

    @property
    def servers(self):
        return self._servers


def test_mode_status_surfaces_a_bind_failure(tmp_path) -> None:
    """The case the API change does cover: a mode that failed to listen."""
    eng = engine(tmp_path, free_port())
    eng.master = _FakeMaster(
        [
            ("regular", True, (("127.0.0.1", 8080),), None),
            ("reverse:http://x@9", False, (), OSError("address already in use")),
        ]
    )
    regular, reverse = eng.mode_status()
    assert regular["running"] is True and regular["listening"] is True
    assert reverse["running"] is False
    assert "address already in use" in str(reverse["error"])


# --- local capture readiness -------------------------------------------------


def test_local_capture_state_reads_the_extension_state(monkeypatch) -> None:
    """On macOS the redirector only works once approved, and mitmproxy
    cannot tell us, so the state is read from the OS."""
    from app import proxy as proxy_module

    def fake_run(*_args, **_kwargs):
        class R:
            stdout = (
                "--- com.apple.system_extension.network_extension\n"
                "\t*\tS8XHQB96PW\torg.mitmproxy.macos-redirector.network-extension"
                " (2.0/1)\tnetwork-extension\t[activated waiting for user]\n"
            )

        return R()

    monkeypatch.setattr(proxy_module.sys, "platform", "darwin")
    monkeypatch.setattr(proxy_module.subprocess, "run", fake_run)

    state = proxy_module.local_capture_state()
    assert state["supported"] is True
    assert state["approved"] is False
    assert state["detail"] == "activated waiting for user"


def test_local_capture_state_reports_an_approved_extension(monkeypatch) -> None:
    from app import proxy as proxy_module

    def fake_run(*_args, **_kwargs):
        class R:
            stdout = (
                "\t*\t*\tS8XHQB96PW\torg.mitmproxy.macos-redirector"
                ".network-extension (2.0/1)\tnet\t[activated enabled]\n"
            )

        return R()

    monkeypatch.setattr(proxy_module.sys, "platform", "darwin")
    monkeypatch.setattr(proxy_module.subprocess, "run", fake_run)
    assert proxy_module.local_capture_state()["approved"] is True


def test_local_capture_state_when_the_extension_is_absent(monkeypatch) -> None:
    from app import proxy as proxy_module

    def fake_run(*_args, **_kwargs):
        class R:
            stdout = "0 extension(s)\n"

        return R()

    monkeypatch.setattr(proxy_module.sys, "platform", "darwin")
    monkeypatch.setattr(proxy_module.subprocess, "run", fake_run)
    state = proxy_module.local_capture_state()
    assert state["approved"] is False
    assert state["detail"] == "not installed"


def test_local_capture_state_survives_a_missing_tool(monkeypatch) -> None:
    """systemextensionsctl is standard, but the engine must not fall over
    if the call fails."""
    from app import proxy as proxy_module

    def boom(*_args, **_kwargs):
        raise OSError("no such tool")

    monkeypatch.setattr(proxy_module.sys, "platform", "darwin")
    monkeypatch.setattr(proxy_module.subprocess, "run", boom)
    state = proxy_module.local_capture_state()
    assert state["approved"] is False
    assert "no such tool" in str(state["detail"])


def test_local_capture_needs_no_approval_off_macos(monkeypatch) -> None:
    """Windows elevates per run and Linux uses sudo, so there is no
    persistent approval state to read."""
    from app import proxy as proxy_module

    monkeypatch.setattr(proxy_module.sys, "platform", "win32")
    assert proxy_module.local_capture_state() == {
        "supported": True,
        "approved": True,
        "detail": None,
    }


@pytest.mark.asyncio
async def test_blocked_local_capture_is_warned_about(tmp_path, caplog) -> None:
    """The case mode_status cannot see: local mode claims to be running
    while the extension waits for approval."""
    eng = engine(tmp_path, free_port())
    await eng.start()
    try:
        published: list[tuple[str, object]] = []
        eng.broker.publish = lambda topic, data: published.append((topic, data))
        eng.mode_status = lambda: [  # type: ignore[method-assign]
            {"spec": "local:curl", "running": True, "listening": False, "error": None}
        ]
        import app.proxy as proxy_module

        original = proxy_module.local_capture_state
        proxy_module.local_capture_state = lambda: {  # type: ignore[assignment]
            "supported": True,
            "approved": False,
            "detail": "activated waiting for user",
        }
        try:
            with caplog.at_level("WARNING"):
                eng._report_mode_failures()
        finally:
            proxy_module.local_capture_state = original  # type: ignore[assignment]

        assert "not active yet" in caplog.text
        assert "activated waiting for user" in caplog.text
        assert [t for t, _ in published] == ["engine.local_capture_blocked"]
    finally:
        await eng.stop()


@pytest.mark.asyncio
async def test_no_local_capture_warning_without_a_local_mode(tmp_path, caplog) -> None:
    """A regular proxy must not produce an approval warning."""
    eng = engine(tmp_path, free_port())
    await eng.start()
    try:
        with caplog.at_level("WARNING"):
            eng._report_mode_failures()
        assert "not active yet" not in caplog.text
    finally:
        await eng.stop()


# --- capture setting survives a restart --------------------------------------


def _reopen(tmp_path, port: int) -> ProxyEngine:
    """A fresh engine over the same database, as a restart would be."""
    settings = Settings(
        proxy_port=port,
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "p.sqlite",
        confdir=tmp_path / "mitm",
    )
    return ProxyEngine(settings, FlowStore(settings.db_path), EventBroker())


@pytest.mark.asyncio
async def test_a_filter_is_restored_after_a_restart(tmp_path) -> None:
    port = free_port()
    eng = engine(tmp_path, port)
    await eng.set_local_capture("curl")

    restarted = _reopen(tmp_path, port)
    assert restarted.local_capture_spec() == "curl"
    assert restarted._modes() == [f"regular@{port}", "local:curl"]


@pytest.mark.asyncio
async def test_capture_everything_is_restored_as_everything(tmp_path) -> None:
    """The empty spec must not come back as None, which would silently
    switch the feature off."""
    port = free_port()
    eng = engine(tmp_path, port)
    await eng.set_local_capture("")

    restarted = _reopen(tmp_path, port)
    assert restarted.local_capture_spec() == ""
    assert restarted._modes() == [f"regular@{port}", "local"]


@pytest.mark.asyncio
async def test_switching_off_is_restored_as_off(tmp_path) -> None:
    port = free_port()
    eng = engine(tmp_path, port)
    await eng.set_local_capture("curl")
    await eng.set_local_capture(None)

    restarted = _reopen(tmp_path, port)
    assert restarted.local_capture_spec() is None
    assert restarted._modes() == [f"regular@{port}"]


@pytest.mark.asyncio
async def test_an_invalid_spec_is_not_stored(tmp_path) -> None:
    """A spec mitmproxy rejects must not be persisted, or the engine would
    fail to start on every subsequent launch.

    Note that process names are free-form, so almost anything parses;
    an empty list entry is one of the few things that does not.
    """
    eng = engine(tmp_path, free_port())
    with pytest.raises(ValueError):
        await eng.set_local_capture(",,,")
    assert eng.local_capture_spec() is None, "a rejected spec must not persist"


async def test_listener_moves_to_a_new_port(tmp_path) -> None:
    """Changing the port is the way out when another tool holds the old one."""
    first, second = free_port(), free_port()
    proxy = engine(tmp_path, first)
    await proxy.start()
    try:
        assert proxy.listener_state()["port"] == first

        state = await proxy.set_listener("127.0.0.1", second)
        assert state["port"] == second
        assert state["running"] is True

        # The proxy really is on the new port, and off the old one.
        with socket.socket() as probe:
            probe.settimeout(2)
            assert probe.connect_ex(("127.0.0.1", second)) == 0
        with socket.socket() as probe:
            probe.settimeout(2)
            assert probe.connect_ex(("127.0.0.1", first)) != 0
    finally:
        await proxy.stop()


async def test_a_rejected_port_leaves_the_proxy_where_it_was(tmp_path) -> None:
    """A typo must not cost the user their running proxy."""
    port = free_port()
    proxy = engine(tmp_path, port)
    await proxy.start()
    try:
        with pytest.raises(ProxyStartError):
            await proxy.set_listener("127.0.0.1", 70000)  # out of range
        assert proxy.running
        assert proxy.settings.proxy_port == port

        # Same when the address itself cannot be bound.
        with pytest.raises(ProxyStartError):
            await proxy.set_listener("203.0.113.1", free_port())
        assert proxy.running
        assert proxy.settings.proxy_port == port
    finally:
        await proxy.stop()


async def test_a_busy_port_is_refused_and_the_old_one_kept(tmp_path) -> None:
    port, taken = free_port(), free_port()
    blocker = socket.socket()
    # No SO_REUSEADDR: on Windows it would let the engine bind this port
    # too, and the test would pass while the feature was broken.
    blocker.bind(("127.0.0.1", taken))
    blocker.listen(1)
    proxy = engine(tmp_path, port)
    await proxy.start()
    try:
        with pytest.raises(ProxyStartError):
            await proxy.set_listener("127.0.0.1", taken)
        assert proxy.running
        assert proxy.settings.proxy_port == port
    finally:
        await proxy.stop()
        blocker.close()


async def test_the_listener_choice_survives_a_restart(tmp_path) -> None:
    """A port chosen in the UI must still be there next launch, otherwise
    the app returns to the port that was blocked."""
    first, second = free_port(), free_port()
    proxy = engine(tmp_path, first)
    await proxy.start()
    try:
        await proxy.set_listener("127.0.0.1", second)
    finally:
        await proxy.stop()

    # A fresh engine over the same database, as a relaunch would build.
    settings = Settings(
        proxy_port=first,  # the default, which the saved choice must beat
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "p.sqlite",
        confdir=tmp_path / "mitm",
    )
    revived = ProxyEngine(settings, FlowStore(settings.db_path), EventBroker())
    assert revived.settings.proxy_port == second


def test_binding_beyond_loopback_is_reported_as_exposed(tmp_path) -> None:
    """The UI warns on this, so the engine has to be honest about it."""
    proxy = engine(tmp_path, free_port())
    assert proxy.listener_state()["exposed"] is False

    proxy.settings.proxy_host = "0.0.0.0"  # noqa: S104 - the case under test
    assert proxy.listener_state()["exposed"] is True

    addresses = [entry["host"] for entry in proxy.listener_state()["addresses"]]
    assert "127.0.0.1" in addresses
    assert "0.0.0.0" in addresses  # noqa: S104


async def test_stop_releases_the_listening_port(tmp_path) -> None:
    """Master.shutdown() does not close the servers, so a stopped proxy used
    to keep accepting connections on its old port."""
    port = free_port()
    proxy = engine(tmp_path, port)
    await proxy.start()
    await proxy.stop()

    with socket.socket() as probe:
        probe.settimeout(2)
        assert probe.connect_ex(("127.0.0.1", port)) != 0, (
            "the port is still accepting after stop()"
        )

    # And the port can be taken by someone else, which is the practical test.
    with socket.socket() as rebind:
        rebind.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        rebind.bind(("127.0.0.1", port))


async def test_repeater_works_with_local_capture_configured(tmp_path) -> None:
    """Repeater reported 'proxy engine is not running' forever whenever a
    local-capture mode was set.

    mitmproxy only runs the `running` hook once the whole addon chain has
    started, and with that mode present it never fired. The port was open
    and traffic flowed, so nothing looked wrong until Repeater or Intruder
    was used.
    """
    proxy = engine(tmp_path, free_port())
    proxy.store.set_setting(ProxyEngine.CAPTURE_SETTING, "")
    await proxy.start()
    try:
        assert proxy.repeater.options is not None, (
            "Repeater never received its options, so it refuses to send"
        )
        # And it survives the listener moving.
        await proxy.set_listener("127.0.0.1", free_port())
        assert proxy.repeater.options is not None
    finally:
        await proxy.stop()
