"""Per-plugin stdout, stderr, logging, and host-error diagnostics."""

from __future__ import annotations

import asyncio
import logging
import textwrap

import pytest

from app.addons.plugins import PluginManager


class FakeAddons:
    def __init__(self) -> None:
        self.items: list[object] = []

    def add(self, obj: object) -> None:
        self.items.append(obj)

    def remove(self, obj: object) -> None:
        self.items.remove(obj)


OUTPUT_PLUGIN = textwrap.dedent(
    r'''
    import logging
    import sys

    logger = logging.getLogger(__name__)
    print("imported on stdout")
    logger.warning("imported through logging")

    class Plugin:
        def request(self, _flow):
            sys.stdout.write("partial")
            sys.stdout.write(" line\n")
            print("한글 출력 ✓")
            print("problem", file=sys.stderr)
            logger.info("request through logging")
    '''
)


def write_plugin(directory, name: str, source: str = OUTPUT_PLUGIN) -> None:
    (directory / f"{name}.py").write_text(source, encoding="utf-8")


def manager_for(tmp_path) -> PluginManager:
    manager = PluginManager(tmp_path, addons=FakeAddons())
    manager.discover()
    return manager


def test_captures_stdout_stderr_and_standard_logging(tmp_path) -> None:
    write_plugin(tmp_path, "output")
    manager = manager_for(tmp_path)
    manager.enable("output")
    manager.addons.items[0].request(None)

    logs = manager.registry.logs("output")["items"]
    assert [(item["source"], item["message"]) for item in logs] == [
        ("stdout", "imported on stdout"),
        ("logging", "imported through logging"),
        ("stdout", "partial line"),
        ("stdout", "한글 출력 ✓"),
        ("stderr", "problem"),
        ("logging", "request through logging"),
    ]
    assert [item["sequence"] for item in logs] == [1, 2, 3, 4, 5, 6]
    assert all(item["plugin"] == "output" for item in logs)
    assert next(item for item in logs if item["source"] == "stderr")["level"] == "error"


def test_output_is_isolated_between_plugins(tmp_path) -> None:
    write_plugin(tmp_path, "alpha", OUTPUT_PLUGIN.replace("partial", "alpha"))
    write_plugin(tmp_path, "beta", OUTPUT_PLUGIN.replace("partial", "beta"))
    manager = manager_for(tmp_path)
    manager.enable("alpha")
    manager.enable("beta")
    for addon in manager.addons.items:
        addon.request(None)

    alpha = [item["message"] for item in manager.registry.logs("alpha")["items"]]
    beta = [item["message"] for item in manager.registry.logs("beta")["items"]]
    assert "alpha line" in alpha and "beta line" not in alpha
    assert "beta line" in beta and "alpha line" not in beta


def test_log_buffer_is_bounded_and_reports_dropped_entries(tmp_path) -> None:
    write_plugin(
        tmp_path,
        "spam",
        "class Plugin:\n    def request(self, _flow):\n"
        "        for index in range(501): print(f'line {index}')\n",
    )
    manager = manager_for(tmp_path)
    manager.enable("spam")
    manager.addons.items[0].request(None)

    page = manager.registry.logs("spam")
    assert page["count"] == 500
    assert page["dropped"] == 1
    assert page["items"][0]["message"] == "line 1"
    assert page["items"][-1]["sequence"] == 501
    tail = manager.registry.logs("spam", after=499, limit=10)
    assert [item["message"] for item in tail["items"]] == ["line 499", "line 500"]

    first_page = manager.registry.logs("spam", after=0, limit=2)
    second_page = manager.registry.logs(
        "spam", after=first_page["next_sequence"], limit=2
    )
    assert [item["sequence"] for item in first_page["items"]] == [2, 3]
    assert [item["sequence"] for item in second_page["items"]] == [4, 5]


def test_long_partial_output_is_split_without_exceeding_message_limit(tmp_path) -> None:
    write_plugin(
        tmp_path,
        "long_output",
        "import sys\nclass Plugin:\n"
        "    def request(self, _flow): sys.stdout.write('x' * 20000)\n",
    )
    manager = manager_for(tmp_path)
    manager.enable("long_output")
    manager.addons.items[0].request(None)

    messages = [item["message"] for item in manager.registry.logs("long_output")["items"]]
    assert "".join(messages) == "x" * 20000
    assert max(map(len, messages)) == 16 * 1024


def test_disabling_detaches_module_logger_and_reload_does_not_duplicate(tmp_path) -> None:
    write_plugin(tmp_path, "reloadable")
    manager = manager_for(tmp_path)
    manager.enable("reloadable")
    module_name = manager.addons.items[0].__class__.__module__
    manager.reload("reloadable")
    before = len(manager.registry.logs("reloadable")["items"])
    logging.getLogger(module_name).warning("one live handler")
    after_reload = len(manager.registry.logs("reloadable")["items"])
    assert after_reload == before + 1

    manager.disable("reloadable")
    logging.getLogger(module_name).warning("after disable")
    assert len(manager.registry.logs("reloadable")["items"]) == after_reload


def test_hook_exception_is_logged_and_preserves_exception_semantics(tmp_path) -> None:
    write_plugin(
        tmp_path,
        "broken_hook",
        "class Plugin:\n"
        "    def request(self, _flow):\n"
        "        print('before failure')\n"
        "        raise RuntimeError('hook exploded')\n",
    )
    manager = manager_for(tmp_path)
    manager.enable("broken_hook")

    with pytest.raises(RuntimeError, match="hook exploded"):
        manager.addons.items[0].request(None)
    logs = manager.registry.logs("broken_hook")["items"]
    assert any(item["source"] == "stdout" and item["message"] == "before failure" for item in logs)
    assert any(item["source"] == "host" and "hook request" in item["message"] for item in logs)


def test_clear_logs_does_not_reuse_sequence_numbers(tmp_path) -> None:
    write_plugin(tmp_path, "clearable")
    manager = manager_for(tmp_path)
    manager.enable("clearable")
    last = manager.registry.logs("clearable")["next_sequence"]

    cleared = manager.registry.clear_logs("clearable")
    assert cleared["items"] == [] and cleared["next_sequence"] == last
    manager.addons.items[0].request(None)
    assert manager.registry.logs("clearable", after=last)["items"][0]["sequence"] > last


@pytest.mark.asyncio
async def test_managed_tasks_get_fresh_output_context_without_stale_leaks(tmp_path) -> None:
    manager = manager_for(tmp_path)
    completed = asyncio.Event()

    async def managed() -> None:
        await asyncio.sleep(0)
        print("managed output")
        completed.set()

    # Task creation commonly happens during activate(), inside another plugin
    # execution context. The task must own a fresh target after activation ends.
    with manager.registry.execution("tasker"):
        context = manager.registry.context("tasker")
        context.tasks.create(managed(), name="managed-output")
    await asyncio.wait_for(completed.wait(), 1)
    assert any(
        item["source"] == "stdout" and item["message"] == "managed output"
        for item in manager.registry.logs("tasker")["items"]
    )

    release = asyncio.Event()

    async def unmanaged() -> None:
        await release.wait()
        print("must not leak")

    with manager.registry.execution("tasker"):
        stale = asyncio.create_task(unmanaged())
    before = manager.registry.logs("tasker")["count"]
    release.set()
    await stale
    assert manager.registry.logs("tasker")["count"] == before
    await manager.registry.dispose_owner_async("tasker")
