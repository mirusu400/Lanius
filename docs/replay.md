# Replay

Send a request again, as many times as you like, tweaking it between attempts.
Open several tabs to compare different variations side by side.

Send the active request with **⌘+Enter** on macOS or **Ctrl+Enter** on Linux
and Windows. Replay also has shortcuts for creating, duplicating, closing, and
moving between request tabs; change, disable, or restore them under
**Settings > Shortcuts**.

The request editor wraps long lines without changing the bytes sent. After a
send, the arrows beside **Send** browse that tab's request and response pairs.
Editing an older request creates a draft, so browsing does not overwrite the
saved exchange. The latest 50 sends per tab are saved with the project.

**Copy as** reflects your edits, so the generated curl, `fetch` or Python
`requests` code repeats exactly what you are about to send. See
[proxy history](proxy.md) for details.
