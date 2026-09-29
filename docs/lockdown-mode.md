# Lockdown Mode

Lockdown Mode blocks Lanius-owned external connections while leaving the
traffic under test available. It is not an operating-system firewall or an
offline mode for the browser. A browser can still make background requests,
and a proxy client can still reach the targets it asks for.

The global checkbox is stored in `~/.lanius/desktop.json` and applies to every
project. `LANIUS_LOCKDOWN=1` forces it on before the project picker appears.
The project checkbox is stored in that project's SQLite settings and is
included in project exports. The effective value is global OR project.
Importing a project applies its saved setting immediately and restarts the
desktop engine when project Lockdown is enabled. An import can turn project
Lockdown on but never off; only the project checkbox can disable it.

Blocked product operations include GitHub update checks and installation,
remote SecLists downloads and user plugins. The Python engine guards its
outbound paths; the desktop shell independently guards its updater and fails
closed when it cannot confirm the active project policy. A blocked API request
returns HTTP 423 and the UI displays an error toast.

Turning on project mode cancels in-flight engine update checks and wordlist
downloads. In the desktop app it also restarts the engine, ending background
work that arbitrary plugin code may have started. The desktop updater checks
the policy throughout its own check and download, so a mode change interrupts
it. Turning on global mode restarts the engine with the new policy before the
setting change finishes.

New Lanius-owned network operations must pass the guard before opening a
socket. Dependencies and arbitrary plugin code require separate review:
application-level checks cannot prevent a malicious native library from
opening its own socket. Enabling Lockdown Mode after a request has already
started cannot recall packets already sent.
