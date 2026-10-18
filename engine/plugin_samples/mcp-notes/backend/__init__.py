"""Project notes exposed as plugin-owned MCP tools; no network access."""

from lanius_sdk import PluginContext


def activate(context: PluginContext) -> None:
    def read_note(key: str = "default") -> dict:
        return {"key": key, "text": context.storage.get(key, "")}

    def write_note(text: str, key: str = "default") -> dict:
        context.storage.set(key, text)
        context.log.info("Saved project note %s", key)
        return {"key": key, "saved": True}

    context.mcp.register_tool(
        "read_note", read_note,
        description="Read a project note saved by the MCP Notes plugin.",
        read_only=True,
    )
    context.mcp.register_tool(
        "write_note", write_note,
        description="Save a project note with the MCP Notes plugin.",
    )
