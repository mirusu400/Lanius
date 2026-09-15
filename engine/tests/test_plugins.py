"""Plugin system tests: plugins really run against real flows."""

from __future__ import annotations

import socket
import textwrap

import pytest
from fastapi.testclient import TestClient
from mitmproxy.test import tflow, tutils

from app.addons.plugins import PluginError, PluginManager
from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowStore

STAMP_PLUGIN = textwrap.dedent(
    '''
    """A plugin that stamps requests."""
    DESCRIPTION = "adds a header"
    VERSION = "9.9.9"
    AUTHOR = "tester"

    class Plugin:
        def __init__(self):
            self.count = 0

        def request(self, flow):
            flow.request.headers["X-Plugin"] = "yes"
            self.count += 1
    '''
)

ADDONS_LIST_PLUGIN = textwrap.dedent(
    """
    class One:
        def response(self, flow):
            flow.comment = "one"

    class Two:
        def request(self, flow):
            pass

    addons = [One(), Two()]
    """
)

BROKEN_PLUGIN = "raise RuntimeError('boom at import time')\n"
NO_ENTRYPOINT_PLUGIN = "x = 1\n"


def write(directory, name: str, source: str):
    path = directory / f"{name}.py"
    path.write_text(source)
    return path


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def real_addon_manager():
    """A genuine mitmproxy AddonManager, which enforces unique addon names."""
    from mitmproxy import addonmanager, master, options

    class _M(master.Master):
        pass

    return addonmanager.AddonManager(_M(options.Options()))


class FakeAddons:
    """Stands in for mitmproxy's AddonManager."""

    def __init__(self) -> None:
        self.items: list[object] = []

    def add(self, obj: object) -> None:
        self.items.append(obj)

    def remove(self, obj: object) -> None:
        self.items.remove(obj)


@pytest.fixture()
def manager(tmp_path):
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    store = FlowStore(tmp_path / "p.sqlite")
    mgr = PluginManager(plugin_dir, store)
    mgr.addons = FakeAddons()
    yield mgr
    store.close()


# --- discovery ------------------------------------------------------------


def test_discover_finds_python_files(manager) -> None:
    write(manager.directory, "alpha", STAMP_PLUGIN)
    write(manager.directory, "beta", STAMP_PLUGIN)
    names = [p.name for p in manager.discover()]
    assert names == ["alpha", "beta"]


def test_discover_skips_private_and_non_python(manager) -> None:
    write(manager.directory, "_hidden", STAMP_PLUGIN)
    (manager.directory / "notes.txt").write_text("hi")
    assert manager.discover() == []


def test_discover_finds_packages(manager) -> None:
    pkg = manager.directory / "mypkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text(STAMP_PLUGIN)
    assert [p.name for p in manager.discover()] == ["mypkg"]


def test_discover_drops_deleted_plugins(manager) -> None:
    path = write(manager.directory, "gone", STAMP_PLUGIN)
    manager.discover()
    path.unlink()
    assert manager.discover() == []


def test_plugins_start_disabled(manager) -> None:
    write(manager.directory, "alpha", STAMP_PLUGIN)
    plugin = manager.discover()[0]
    assert plugin.enabled is False
    assert plugin.loaded is False


# --- enable / disable -----------------------------------------------------


def test_enable_loads_and_registers_the_addon(manager) -> None:
    write(manager.directory, "stamp", STAMP_PLUGIN)
    manager.discover()
    plugin = manager.enable("stamp")
    assert plugin.enabled and plugin.loaded
    assert len(manager.addons.items) == 1
    assert plugin.meta["description"] == "adds a header"
    assert plugin.meta["version"] == "9.9.9"
    assert plugin.meta["hooks"] == ["request"]


def test_enabled_plugin_modifies_real_flows(manager) -> None:
    write(manager.directory, "stamp", STAMP_PLUGIN)
    manager.discover()
    manager.enable("stamp")

    addon = manager.addons.items[0]
    flow = tflow.tflow(req=tutils.treq(), resp=False)
    addon.request(flow)
    assert flow.request.headers["X-Plugin"] == "yes"
    assert addon.count == 1


def test_disable_unregisters_the_addon(manager) -> None:
    write(manager.directory, "stamp", STAMP_PLUGIN)
    manager.discover()
    manager.enable("stamp")
    plugin = manager.disable("stamp")
    assert plugin.enabled is False and plugin.loaded is False
    assert manager.addons.items == []


def test_addons_list_entrypoint(manager) -> None:
    write(manager.directory, "multi", ADDONS_LIST_PLUGIN)
    manager.discover()
    plugin = manager.enable("multi")
    assert len(manager.addons.items) == 2
    assert set(plugin.meta["hooks"]) == {"request", "response"}


def test_broken_plugin_reports_the_error_without_crashing(manager) -> None:
    write(manager.directory, "broken", BROKEN_PLUGIN)
    manager.discover()
    with pytest.raises(PluginError) as exc:
        manager.enable("broken")
    assert "boom at import time" in str(exc.value)
    assert manager.get("broken").error
    assert manager.addons.items == []


def test_plugin_without_entrypoint_is_rejected(manager) -> None:
    write(manager.directory, "empty", NO_ENTRYPOINT_PLUGIN)
    manager.discover()
    with pytest.raises(PluginError):
        manager.enable("empty")


def test_unknown_plugin_raises(manager) -> None:
    with pytest.raises(PluginError):
        manager.enable("ghost")


def test_reload_picks_up_edits(manager) -> None:
    path = write(manager.directory, "stamp", STAMP_PLUGIN)
    manager.discover()
    manager.enable("stamp")
    path.write_text(STAMP_PLUGIN.replace('"yes"', '"edited"'))
    manager.reload("stamp")

    flow = tflow.tflow(req=tutils.treq(), resp=False)
    manager.addons.items[0].request(flow)
    assert flow.request.headers["X-Plugin"] == "edited"


def test_enabled_state_is_persisted(tmp_path) -> None:
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    write(plugin_dir, "stamp", STAMP_PLUGIN)

    store = FlowStore(tmp_path / "s.sqlite")
    first = PluginManager(plugin_dir, store)
    first.addons = FakeAddons()
    first.discover()
    first.enable("stamp")
    store.close()

    reopened = FlowStore(tmp_path / "s.sqlite")
    second = PluginManager(plugin_dir, reopened)
    second.addons = FakeAddons()
    second.load_enabled()
    assert second.get("stamp").enabled is True
    assert second.get("stamp").loaded is True
    assert len(second.addons.items) == 1
    reopened.close()


def test_load_enabled_tolerates_broken_plugins(tmp_path) -> None:
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    write(plugin_dir, "ok", STAMP_PLUGIN)
    write(plugin_dir, "bad", BROKEN_PLUGIN)

    store = FlowStore(tmp_path / "s.sqlite")
    store.set_setting("plugins.enabled", '["ok", "bad"]')
    manager = PluginManager(plugin_dir, store)
    manager.addons = FakeAddons()
    manager.load_enabled()  # must not raise

    assert manager.get("ok").loaded is True
    assert manager.get("bad").loaded is False
    assert manager.get("bad").error
    store.close()


def test_manager_publishes_changes(tmp_path) -> None:
    from app.events import EventBroker

    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    write(plugin_dir, "stamp", STAMP_PLUGIN)
    store = FlowStore(tmp_path / "b.sqlite")
    broker = EventBroker()
    queue = broker.subscribe()
    manager = PluginManager(plugin_dir, store, broker)
    manager.addons = FakeAddons()
    manager.discover()
    manager.enable("stamp")
    assert queue.get_nowait()["type"] == "plugins.changed"
    store.close()


# --- API ------------------------------------------------------------------


@pytest.fixture()
def client(tmp_path):
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    write(plugin_dir, "stamp", STAMP_PLUGIN)
    write(plugin_dir, "broken", BROKEN_PLUGIN)
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "api.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=plugin_dir,
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_api_lists_discovered_plugins(client) -> None:
    data = client.get("/api/plugins").json()
    names = {p["name"] for p in data["items"]}
    assert {"stamp", "broken"} <= names
    assert data["directory"].endswith("plugins")


def test_api_enable_and_disable(client) -> None:
    enabled = client.post("/api/plugins/stamp/enable").json()
    assert enabled["enabled"] is True
    assert enabled["loaded"] is True
    assert enabled["hooks"] == ["request"]

    disabled = client.post("/api/plugins/stamp/disable").json()
    assert disabled["enabled"] is False


def test_api_enabled_plugin_affects_proxied_traffic(client) -> None:
    """The loaded plugin must be in the live addon chain, not just a list."""
    client.post("/api/plugins/stamp/enable")
    master = client.app.state.engine.master
    assert master is not None

    flow = tflow.tflow(req=tutils.treq(), resp=False)
    stamps = [
        a for a in master.addons.chain if a.__class__.__name__ == "Plugin"
    ]
    assert stamps, "plugin was not added to the mitmproxy addon chain"
    stamps[0].request(flow)
    assert flow.request.headers["X-Plugin"] == "yes"


def test_api_broken_plugin_returns_400(client) -> None:
    res = client.post("/api/plugins/broken/enable")
    assert res.status_code == 400
    assert "boom" in res.json()["detail"]


def test_api_unknown_plugin_404(client) -> None:
    assert client.post("/api/plugins/ghost/enable").status_code == 404
    assert client.post("/api/plugins/ghost/disable").status_code == 404


def test_api_reload(client) -> None:
    client.post("/api/plugins/stamp/enable")
    assert client.post("/api/plugins/stamp/reload").json()["loaded"] is True


# --- shipped examples -----------------------------------------------------


def test_shipped_example_plugins_load(tmp_path) -> None:
    """The plugins/ directory in the repo must actually work."""
    from pathlib import Path

    repo_plugins = Path(__file__).resolve().parents[2] / "plugins"
    store = FlowStore(tmp_path / "e.sqlite")
    manager = PluginManager(repo_plugins, store)
    manager.addons = FakeAddons()
    manager.discover()

    names = {p.name for p in manager.plugins.values()}
    assert {"header_tagger", "request_stamp"} <= names

    manager.enable("header_tagger")
    manager.enable("request_stamp")

    # request_stamp adds its header
    flow = tflow.tflow(req=tutils.treq(), resp=False)
    for addon in manager.addons.items:
        if hasattr(addon, "request"):
            addon.request(flow)
    assert flow.request.headers["X-Lanius"] == "1"

    # header_tagger comments on a response missing security headers
    flow2 = tflow.tflow(req=tutils.treq(), resp=tutils.tresp())
    for addon in manager.addons.items:
        if hasattr(addon, "response"):
            addon.response(flow2)
    assert "missing" in (flow2.comment or "")
    store.close()


@pytest.mark.asyncio
async def test_two_plugins_named_Plugin_can_coexist(tmp_path) -> None:
    """Regression: mitmproxy names addons after their class, so two plugins
    both defining `class Plugin` collided with 'addon already exists'."""
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    write(plugin_dir, "first", STAMP_PLUGIN)
    write(plugin_dir, "second", STAMP_PLUGIN)

    store = FlowStore(tmp_path / "n.sqlite")
    manager = PluginManager(plugin_dir, store)
    manager.addons = real_addon_manager()
    manager.discover()

    manager.enable("first")
    manager.enable("second")  # must not raise

    names = {a.name for a in manager.addons.chain}
    assert {"first", "second"} <= names
    store.close()


@pytest.mark.asyncio
async def test_addons_list_objects_get_unique_names(tmp_path) -> None:
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    write(plugin_dir, "multi", ADDONS_LIST_PLUGIN)
    store = FlowStore(tmp_path / "u.sqlite")
    manager = PluginManager(plugin_dir, store)
    manager.addons = real_addon_manager()
    manager.discover()
    manager.enable("multi")
    assert {"multi_0", "multi_1"} <= {a.name for a in manager.addons.chain}
    store.close()


def test_registration_failure_rolls_back(tmp_path) -> None:
    """A plugin that cannot register must leave no partial state behind."""
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    write(plugin_dir, "stamp", STAMP_PLUGIN)
    store = FlowStore(tmp_path / "r.sqlite")
    manager = PluginManager(plugin_dir, store)

    class Rejecting:
        def add(self, obj: object) -> None:
            raise RuntimeError("nope")

        def remove(self, obj: object) -> None:
            pass

    manager.addons = Rejecting()
    manager.discover()
    with pytest.raises(PluginError):
        manager.enable("stamp")
    assert manager.get("stamp").loaded is False
    assert manager.get("stamp").objects == []
    store.close()


def test_capture_stays_last_so_plugin_edits_are_recorded(tmp_path) -> None:
    """Regression: capture ran before plugins, so a plugin's response edits
    (e.g. setting flow.comment) were never persisted."""
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    write(
        plugin_dir,
        "commenter",
        textwrap.dedent(
            """
            class Plugin:
                def response(self, flow):
                    flow.comment = "tagged-by-plugin"
            """
        ),
    )
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "order.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=plugin_dir,
    )
    with TestClient(create_app(settings)) as c:
        c.post("/api/plugins/commenter/enable")
        engine = c.app.state.engine
        chain = engine.master.addons.chain
        assert chain[-1] is engine.capture, "capture must run last"

        flow = tflow.tflow(req=tutils.treq(host="ordered.test"), resp=tutils.tresp())
        for addon in chain:
            if hasattr(addon, "response"):
                addon.response(flow)

        stored = c.get("/api/flows").json()["items"]
        assert stored[0]["comment"] == "tagged-by-plugin"


# --- plugins that add code formats ----------------------------------------

FORMAT_PLUGIN = '''
from app.codegen import RequestSpec

def shout(spec: RequestSpec) -> str:
    return spec.url.upper()

class Plugin:
    codegen_formats = {"shout": ("Shout", shout)}
'''


def test_a_plugin_can_add_a_code_format(tmp_path) -> None:
    """A plugin reaches the copy-as menus without shipping any UI."""
    from app import codegen

    (tmp_path / "shouter.py").write_text(FORMAT_PLUGIN)
    manager = PluginManager(tmp_path)
    manager.discover()
    manager.enable("shouter")
    try:
        assert codegen.generate("shout", codegen.RequestSpec("GET", "https://x.test/"))
        assert any(f["kind"] == "shout" for f in codegen.available_formats())
    finally:
        manager.disable("shouter")


def test_disabling_the_plugin_removes_its_format(tmp_path) -> None:
    """Otherwise the menu keeps offering something that no longer exists."""
    from app import codegen

    (tmp_path / "shouter.py").write_text(FORMAT_PLUGIN)
    manager = PluginManager(tmp_path)
    manager.discover()
    manager.enable("shouter")
    manager.disable("shouter")
    assert not any(f["kind"] == "shout" for f in codegen.available_formats())


def test_a_plugin_with_an_unusable_format_still_loads(tmp_path) -> None:
    """One bad entry should not stop the rest of the plugin working."""
    from app import codegen

    (tmp_path / "broken.py").write_text(
        'class Plugin:\n    codegen_formats = {"bad": "not a pair"}\n'
    )
    manager = PluginManager(tmp_path)
    manager.discover()
    manager.enable("broken")
    try:
        assert manager.get("broken").loaded is True
        assert not any(f["kind"] == "bad" for f in codegen.available_formats())
    finally:
        manager.disable("broken")


def test_the_shipped_redaction_plugin_works(tmp_path) -> None:
    """The example in plugins/ is the one users are told to copy."""
    from pathlib import Path
    from app import codegen

    source = Path(__file__).resolve().parents[2] / "plugins"
    manager = PluginManager(source)
    manager.discover()
    manager.enable("copy_as_python_redacted")
    try:
        spec = codegen.RequestSpec(
            "GET", "https://x.test/", [("Authorization", "Bearer abc")]
        )
        text = codegen.generate("python-redacted", spec)
        assert "[redacted]" in text
        assert "abc" not in text
    finally:
        manager.disable("copy_as_python_redacted")
