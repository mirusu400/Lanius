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
Replay keeps the complete response in HTTP History, while its immediate UI
response is capped at 256 KiB before JSON serialization. This prevents a large
download from freezing the editor or being copied into every autosaved Replay
snapshot.

Responses with a valid `Location` header and status 301, 302, 303, 307, or 308
show **Follow redirect**. Each click sends one more request through the normal
Replay path and keeps both exchanges in the tab's send history. Enable
**Auto-follow redirects** to follow up to 10 hops after a send; loops stop
early. For browser-compatible behavior, 301 and 302 change POST to GET, 303
changes methods other than GET and HEAD to GET, and 307 and 308 preserve the
method and body. Credentials and cookies are not copied to another origin.
The option is saved on this device and is off by default.

**Copy as** reflects your edits, so the generated curl, `fetch` or Python
`requests` code repeats exactly what you are about to send. See
[proxy history](proxy.md) for details.

Use the HTTP version selector beside the target URL to inherit the project
default or choose Auto, forced HTTP/1.0, HTTP/1.1, or HTTP/2. The choice is saved
with each draft and sent exchange, including redirect hops. A forced mode takes
precedence over the request-line version; changing that line alone does not
force HTTP/2 negotiation. Responses show the protocol used toward the server.
Forced HTTP/2 requires HTTPS and fails if the server does not negotiate h2.
