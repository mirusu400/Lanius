# Lockdown Mode

Lockdown Mode blocks Lanius-owned external connections while leaving the
traffic under test available. It is not an operating-system firewall or an
offline mode for the browser. A browser can still make background requests,
and a proxy client can still reach the targets it asks for.

Projects can additionally enable **Block out-of-scope proxy traffic**. While
Lockdown Mode is effective, Lanius then permits only HTTP/HTTPS requests that
match the active project scope. This includes ordinary proxy clients, local
capture, WebSocket handshakes, Replay and Fuzzer. Raw TCP and UDP are refused
outright because they do not have an HTTP URL that can be checked against the
scope. Traffic that bypasses Lanius is outside this application's control.

The scope egress switch is stored in the project database and included in
exports. It follows the existing scope meaning: exclude rules win, and with no
enabled include rule everything remains in scope. Enabling it has no effect
until global or project Lockdown is active.

The global checkbox is stored in `~/.lanius/desktop.json` and applies to every
project. `LANIUS_LOCKDOWN=1` forces it on before the project picker appears.
The project checkbox is stored in that project's SQLite settings and is
included in project exports. The effective value is global OR project.
Importing a project applies its saved setting immediately and restarts the
desktop engine when project Lockdown is enabled. An import can turn project
Lockdown on but never off; only the project checkbox can disable it.

Blocked product operations include GitHub update checks and installation,
remote SecLists downloads, plugin catalogue refreshes and installs, and user
plugins. Plugins are suspended rather than disabled: their enabled flags stay
on disk, so turning Lockdown Mode off loads the same set again. The Python engine guards its
outbound paths; the desktop shell independently guards its updater and fails
closed when it cannot confirm the active project policy. A blocked API request
returns HTTP 423 and the UI displays an error toast.

Turning on project mode cancels in-flight engine update checks and wordlist
downloads. In the desktop app it also restarts the engine, ending background
work that arbitrary plugin code may have started. The desktop updater checks
the policy throughout its own check and download, so a mode change interrupts
it. Turning on global mode restarts the engine with the new policy before the
setting change finishes.

Strict scope egress uses mitmproxy's lazy connection strategy so the exact URL
can be checked before DNS lookup, TCP connection or an upstream TLS handshake.
Enabling the option, importing an active protected project, or changing scope
rules while it is active closes current proxy, Replay and Fuzzer connections.
Blocked proxy requests are dropped and reported in the UI. If the proxy cannot
restart, the guard remains enabled and the listener stays down rather than
reopening unrestricted traffic.

New Lanius-owned network operations must pass the guard before opening a
socket. Dependencies and arbitrary plugin code require separate review:
application-level checks cannot prevent a malicious native library from
opening its own socket. Enabling Lockdown Mode after a request has already
started cannot recall packets already sent.
