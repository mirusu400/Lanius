# Projects

At launch, choose a temporary project or a named project. Each named project
has its own database and data directory under `~/.lanius/projects/`, so captured
traffic, scope, proxy settings and open tabs stay separate. Temporary projects
are removed when closed. Use **Settings > Project > Switch** to return to the
chooser. The previous single-database workspace remains available as
**Previous work**.

## Backups and exports

Work is saved as you go. **Settings > Project > Back up complete database**
downloads a consistent SQLite snapshot with every HTTP body and WebSocket
message.

The JSON export is intended for sharing smaller projects: it holds at most
100,000 HTTP flows, omits WebSocket messages, and its readable body encoding
cannot preserve arbitrary binary bytes. Projects above that limit receive an
error instead of a silently shortened JSON export. A second JSON button leaves
the capture out when you only want to pass on a scope and a set of requests.

## Cleaning up

The same screen shows which captured targets use space. Select targets to
remove their requests and compact the database, or compact only to reclaim
pages freed earlier. The preview shows request counts and the confirmation
names what will be deleted.

Existing projects build summary and full text indexes once when first opened
after upgrading; a large project can take minutes on that first launch and
requires additional disk space.

## Settings that travel with a project

Scope rules, Match &amp; Replace rules, upstream proxy chains, upstream CA
certificates and the Lockdown project switch are stored in the project
database, so they are included in exports. Appearance, shortcuts and other
machine-level choices are not. See [settings.md](settings.md).
