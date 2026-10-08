# Projects

At launch, choose a temporary project or a named project. Each named project
has its own database and data directory under `~/.lanius/projects/`, so captured
traffic, scope, proxy settings and open tabs stay separate. Temporary projects
are removed when closed. Use **Settings > Project > Switch** to return to the
chooser. The previous single-database workspace remains available as
**Previous work**.

Closing the window or quitting Lanius saves pending Replay and Decoder edits
before stopping the engine. A progress circle stays visible while saving and
cleaning up. If saving fails, the window stays open so you can retry or cancel.

## Backups and exports

Work is saved as you go. **Settings > Project > Back up complete database**
downloads a consistent SQLite snapshot with every HTTP body and WebSocket
message.

In the desktop app, both JSON exports and the complete database backup open a
**Save As** dialog. Choose the folder and filename there; cancelling leaves no
export file. Pending tab edits are saved before exporting. A failed download
does not replace an existing backup at the selected path.

The JSON export is intended for sharing smaller projects: it holds at most
100,000 HTTP flows, omits WebSocket messages, and its readable body encoding
cannot preserve arbitrary binary bytes. Projects above that limit receive an
error instead of a silently shortened JSON export. A second JSON button leaves
the capture out when you only want to pass on a scope and a set of requests.

**Import project** accepts JSON exports and `.sqlite`, `.sqlite3`, or `.db`
Lanius backups. SQLite restores the complete capture, including binary bodies,
WebSocket messages, bookmarks, issues and saved payload lists. Older backups
are upgraded on a temporary copy; the selected file is left unchanged.
Lanius checks the backup before stopping capture, then pauses the proxy during
restoration. HTTP History reloads from the restored project.

Importing a project also replaces the open Replay and Decoder tabs. Pending
writes from the previous workspace finish before the import starts, and tabs
absent from the imported project are cleared.

## Cleaning up

The same screen shows which captured targets use space. Select targets to
remove their requests and compact the database, or compact only to reclaim
pages freed earlier. The preview shows request counts and the confirmation
names what will be deleted.
During cleanup, the screen shows the current database step and elapsed time.
The deletion step also shows the share of selected requests processed; search
index optimization and database rebuilding do not have a reliable percentage.

Existing projects build summary and full text indexes once when first opened
after upgrading; a large project can take minutes on that first launch and
requires additional disk space.
HTTP History uses a separate table of small summary rows, so listing requests
does not read large request or response bodies. This table is built once when
an older project is opened or imported.
Request and response bodies larger than 8 MiB remain available in the capture
but are left out of the text search index to keep capture responsive.

## Settings that travel with a project

Scope rules, Match &amp; Replace rules, upstream proxy chains, upstream CA
certificates and the Lockdown project switch are stored in the project
database, so they are included in exports. Appearance, shortcuts and other
machine-level choices are not. See [settings.md](settings.md).
