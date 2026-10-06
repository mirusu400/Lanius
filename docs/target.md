# Target

A site map of everything you have visited, grouped by host and path. Lanius
also collapses dynamic paths into endpoints, so `/users/1`, `/users/2` and
`/users/3` become a single `/users/{id}` entry with the parameters it saw.

## Browsing the map

The map first loads site summaries. Opening a site or folder loads up to 200
requests; **Load more requests** fetches the next page. This keeps a long
capture from loading every request into the interface at once. Folder names are
discovered separately, so a folder whose requests are on a later page is
visible immediately. **Load more folders** pages unusually large directories.
**In scope only** applies to the requests and folders inside each site as well
as to the site list. **Expand all** is available for smaller projects; open
sites individually in a large one.

In the site map, Ctrl/⌘-click to select separate sites, folders or requests,
or Shift-click to select a visible range. Right-click a selected row to delete
the selection together after reviewing the confirmation. When a folder has not
been fully loaded, the confirmation does not show an incomplete request count.
Drag the divider between the site tree and request detail to resize either
pane. Endpoint and Scope table columns can also be resized from their header
edges. These sizes are remembered on this machine.

## Endpoints

Click an endpoint to browse every captured request in that group, inspect its
request and response, or right-click it to send it to [Replay](replay.md) or
the [Fuzzer](fuzzer.md). Endpoint counts, status codes and query parameter
names cover the full saved history. Requests within an endpoint load in pages.
The displayed path values and example URLs are samples of captured requests.
The request and response panes have a draggable divider; raw text wraps long
lines and its editor height can be adjusted.

## Scope

Define a **scope** with include and exclude rules to keep your attention on the
application under test. Scope rules persist across restarts, and you can tell
Lanius to stop recording out of scope traffic entirely.

The Scope field accepts full URLs or scheme-free host patterns. A plain domain
matches any host containing that text, on both HTTP and HTTPS. In the default
mode, `*` matches any number of characters and `?` matches one character.
Enable **Regex** to match host names with a regular expression instead; use
`.*` for any number of characters and `?` to make the preceding item optional.
When a scheme is omitted, all ports match unless a port is specified.

In Lockdown settings, the separate scope egress option can prevent
out-of-scope traffic from being sent at all while Lockdown is active; see
[lockdown-mode.md](lockdown-mode.md).
