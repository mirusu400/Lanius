"""Adapter between owned SDK contributions and the MCP Python SDK.

Keep protocol types and signature inference out of the public lanius_sdk.
The registry remains the source of truth: removing a contribution immediately
removes it from tools/list and makes cached wrappers refuse execution.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
from typing import TYPE_CHECKING, Any, Callable

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.mcpserver.tools import Tool
from mcp.server.subscriptions import InMemorySubscriptionBus, ToolsListChanged
from mcp.types import Tool as ProtocolTool, ToolAnnotations

from lanius_sdk import PluginApiError

if TYPE_CHECKING:
    from ..plugin_registry import ContributionRegistry


class RegisteredTool:
    def __init__(
        self, registry: ContributionRegistry, name: str,
        callback: Callable[..., Any], description: str | None, read_only: bool,
    ) -> None:
        self.callback = callback
        signature = inspect.signature(callback, eval_str=True)
        for parameter in signature.parameters.values():
            if parameter.kind not in (
                inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY,
            ) or parameter.annotation is inspect.Parameter.empty:
                raise PluginApiError("MCP parameters must be named and type annotated")

        @functools.wraps(callback)
        async def invoke(**arguments: Any) -> Any:
            try:
                return await registry.invoke_mcp_tool(name, self, arguments)
            except PluginApiError as exc:
                raise ToolError(str(exc)) from exc

        # Resolve forward annotations in the plugin's globals before handing
        # an async wrapper from this module to the SDK's schema generator.
        invoke.__signature__ = signature  # type: ignore[attr-defined]
        invoke.__annotations__ = {
            key: parameter.annotation for key, parameter in signature.parameters.items()
        }
        if signature.return_annotation is not inspect.Signature.empty:
            invoke.__annotations__["return"] = signature.return_annotation
        self.tool = Tool.from_function(
            invoke, name=name, description=description,
            annotations=ToolAnnotations(read_only_hint=read_only),
            meta={"lanius/plugin": name.rpartition(".")[0]},
        )
        if self.tool.context_kwarg is not None or self.tool.resolved_params:
            raise PluginApiError("plugin MCP tools do not support protocol context injection")
        # Unknown arguments should be rejected rather than silently ignored.
        model = self.tool.fn_metadata.arg_model
        model.model_config = {**model.model_config, "extra": "forbid"}
        model.model_rebuild(force=True)
        self.tool.parameters = model.model_json_schema(by_alias=True)


class PluginMCPServer(MCPServer):
    def __init__(self, *, engine: Any = None, **kwargs: Any) -> None:
        self._engine = engine
        self._plugin_bus = InMemorySubscriptionBus()
        self._notification_handle: asyncio.Handle | None = None
        self._notification_tasks: set[asyncio.Task[None]] = set()
        self._plugin_subscription = None
        super().__init__(subscriptions=self._plugin_bus, **kwargs)
        if engine is not None:
            self._plugin_subscription = engine.plugins.registry.subscribe_mcp_tools(
                self._tools_changed,
            )

    def plugin_tools(self) -> list[Any]:
        if self._engine is None:
            return []
        return self._engine.plugins.registry.mcp_tools()

    async def list_tools(self) -> list[ProtocolTool]:
        tools = await super().list_tools()
        for item in self.plugin_tools():
            tool = item.handler.tool
            tools.append(ProtocolTool(
                name=tool.name, description=tool.description,
                input_schema=tool.parameters, output_schema=tool.output_schema,
                annotations=tool.annotations, _meta=tool.meta,
            ))
        return sorted(tools, key=lambda tool: tool.name)

    async def call_tool(
        self, name: str, arguments: dict[str, Any], context: Any = None,
    ) -> Any:
        # Core names cannot contain the owner/local separator. No fallback
        # to a cached plugin function is possible once its owner is unloaded.
        if "." in name and self._engine is not None:
            registry = self._engine.plugins.registry
            try:
                item = registry._get("mcp_tools", name)
                registry._require_mcp_tool(name, item.handler)
            except PluginApiError as exc:
                raise ToolError(str(exc)) from exc
            return await item.handler.tool.run(
                # Registry invocation already converts/validates the result
                # inside its owned diagnostics and execution boundary.
                arguments, context or Context(mcp_server=self), convert_result=False,
            )
        return await super().call_tool(name, arguments, context)

    def _tools_changed(self) -> None:
        # Coalesce synchronous activate/rollback/reload changes. Publishing on
        # the next loop turn means clients only observe the finished state.
        if self._notification_handle is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # Startup registration; no connected clients yet.
        self._notification_handle = loop.call_soon(self._publish_tools_changed)

    def _publish_tools_changed(self) -> None:
        self._notification_handle = None
        task = asyncio.create_task(self._plugin_bus.publish(ToolsListChanged()))
        self._notification_tasks.add(task)
        task.add_done_callback(self._notification_tasks.discard)
        if self._engine is not None and self._engine.broker is not None:
            self._engine.broker.publish("mcp.tools_changed", {})

    async def close_plugin_tools(self) -> None:
        if self._plugin_subscription is not None:
            self._plugin_subscription.dispose()
        if self._notification_handle is not None:
            self._notification_handle.cancel()
            self._notification_handle = None
        for task in self._notification_tasks:
            task.cancel()
        if self._notification_tasks:
            await asyncio.gather(*self._notification_tasks, return_exceptions=True)
