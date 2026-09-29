"""Stable plugin SDK and owned contribution tests."""

from __future__ import annotations

import asyncio
import socket
import textwrap

import pytest

from app.addons import codecs
from app.addons.plugins import PluginError, PluginManager
from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowStore
from app.plugin_registry import ContributionRegistry
from fastapi.testclient import TestClient
from lanius_sdk import PluginApiError


class FakeAddons:
    def __init__(self) -> None:
        self.items: list[object] = []

    def add(self, obj: object) -> None:
        self.items.append(obj)

    def remove(self, obj: object) -> None:
        self.items.remove(obj)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


SDK_PLUGIN = textwrap.dedent(
    '''
    from lanius_sdk import SettingDefinition

    DESCRIPTION = "SDK contributions"

    def activate(context):
        context.actions.register(
            "inspect", "Inspect", lambda payload: {"seen": payload.get("flow_id")},
            locations=("flow", "history"),
        )
        context.codecs.register(
            "brackets", "Brackets",
            encode=lambda value: f"[{value}]",
            decode=lambda value: value.removeprefix("[").removesuffix("]"),
        )
        context.payloads.register_generator(
            "sequence", "Sequence",
            lambda options: (str(index) for index in range(options.get("count", 2))),
        )
        context.payloads.register_processor(
            "prefix", "Prefix",
            lambda value, options: options.get("prefix", "") + value,
        )
        context.settings.define(
            SettingDefinition("enabled", "Enabled", kind="boolean", default=True),
            SettingDefinition(
                "tone", "Tone", kind="enum", default="quiet",
                choices=("quiet", "loud"), scope="user",
            ),
        )
        context.storage.set("activation_count", context.storage.get("activation_count", 0) + 1)
    '''
)


@pytest.fixture()
def sdk_manager(tmp_path):
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    (plugin_dir / "sdk.py").write_text(SDK_PLUGIN)
    store = FlowStore(tmp_path / "project.sqlite")
    manager = PluginManager(
        plugin_dir,
        store,
        addons=FakeAddons(),
        user_values_path=tmp_path / "user-values.json",
    )
    manager.discover()
    yield manager
    manager.disable("sdk") if manager.get("sdk").loaded else None
    store.close()


@pytest.mark.asyncio
async def test_sdk_plugin_registers_and_invokes_contributions(sdk_manager) -> None:
    plugin = sdk_manager.enable("sdk")

    assert plugin.loaded is True
    assert plugin.objects == []
    assert plugin.as_dict()["sdk_api_version"] == "1.1"
    assert plugin.as_dict()["contributions"] == {
        "actions": 1,
        "codecs": 1,
        "payload_generators": 1,
        "payload_processors": 1,
        "settings": 2,
        "passive_scanners": 0,
        "active_scanners": 0,
    }
    assert await sdk_manager.registry.invoke_action(
        "sdk.inspect", {"location": "flow", "flow_id": "f-1"}
    ) == {"seen": "f-1"}
    assert await sdk_manager.registry.generate_payloads(
        "sdk.sequence", {"count": 3}
    ) == ["0", "1", "2"]
    assert await sdk_manager.registry.process_payload(
        "sdk.prefix", "value", {"prefix": "pre-"}
    ) == "pre-value"
    assert codecs.transform("value", "sdk.brackets", "encode") == "[value]"


def test_sdk_settings_and_storage_persist_across_reload(sdk_manager) -> None:
    sdk_manager.enable("sdk")
    registry = sdk_manager.registry
    assert registry.settings("sdk")["values"] == {
        "enabled": True,
        "tone": "quiet",
    }
    registry.set_setting("sdk", "enabled", False)
    registry.set_setting("sdk", "tone", "loud")
    with pytest.raises(PluginApiError, match="invalid value"):
        registry.set_setting("sdk", "tone", "invalid")

    sdk_manager.reload("sdk")
    assert registry.settings("sdk")["values"] == {
        "enabled": False,
        "tone": "loud",
    }
    context = registry.context("sdk")
    assert context.storage.get("activation_count") == 2


def test_disabling_sdk_plugin_removes_every_contribution(sdk_manager) -> None:
    sdk_manager.enable("sdk")
    sdk_manager.disable("sdk")

    assert all(not values for values in sdk_manager.registry.list().values())
    with pytest.raises(codecs.CodecError, match="unknown codec"):
        codecs.transform("value", "sdk.brackets", "encode")


def test_sdk_resources_are_read_only_and_path_bounded(tmp_path) -> None:
    resources = tmp_path / "resources"
    (resources / "payloads").mkdir(parents=True)
    (resources / "payloads" / "names.txt").write_text("admin\nroot\n")
    context = ContributionRegistry(None).context("sdk", resources)

    assert context.resources.list() == ("payloads/names.txt",)
    assert context.resources.list("payloads") == ("payloads/names.txt",)
    assert context.resources.read_text("payloads/names.txt") == "admin\nroot\n"
    with pytest.raises(PluginApiError, match="stay inside"):
        context.resources.read_text("../secret")


def test_failed_activation_rolls_back_partial_contributions(tmp_path) -> None:
    (tmp_path / "broken.py").write_text(
        textwrap.dedent(
            '''
            def activate(context):
                context.actions.register("partial", "Partial", lambda payload: None)
                raise RuntimeError("activation failed")
            '''
        )
    )
    manager = PluginManager(tmp_path, addons=FakeAddons())
    manager.discover()

    with pytest.raises(PluginError, match="activation failed"):
        manager.enable("broken")
    assert all(not values for values in manager.registry.list().values())


@pytest.mark.asyncio
async def test_plugin_tasks_are_cancelled_on_disable(tmp_path) -> None:
    (tmp_path / "worker.py").write_text(
        textwrap.dedent(
            '''
            import asyncio

            async def worker():
                await asyncio.Event().wait()

            def activate(context):
                context.tasks.create(worker(), name="sdk-worker")
            '''
        )
    )
    manager = PluginManager(tmp_path, addons=FakeAddons())
    manager.discover()
    await manager.enable_async("worker")
    task = next(task for task in asyncio.all_tasks() if task.get_name() == "sdk-worker")

    await manager.disable_async("worker")

    assert task.cancelled()


def test_sdk_contributions_are_available_through_the_api(tmp_path) -> None:
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    (plugin_dir / "sdk.py").write_text(SDK_PLUGIN)
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "api.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=plugin_dir,
    )

    with TestClient(create_app(settings)) as client:
        assert client.post("/api/plugins/sdk/enable").status_code == 200
        catalogue = client.get("/api/plugin-contributions").json()
        assert catalogue["actions"][0]["id"] == "sdk.inspect"

        invoked = client.post(
            "/api/plugin-actions/sdk.inspect/invoke",
            json={"context": {"location": "flow", "flow_id": "flow-9"}},
        )
        assert invoked.json() == {"result": {"seen": "flow-9"}}

        generated = client.post(
            "/api/plugin-payload-generators/sdk.sequence/generate",
            json={"options": {"count": 3}},
        )
        assert generated.json() == {"values": ["0", "1", "2"], "count": 3}

        updated = client.patch(
            "/api/plugins/sdk/settings", json={"values": {"enabled": False}}
        )
        assert updated.json()["values"]["enabled"] is False
