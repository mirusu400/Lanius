# Intercept

Hold a request before it reaches the server, edit it as raw HTTP, then forward
or drop it. You can intercept responses too, and limit interception to a single
host so the rest of your browsing is unaffected.

## Held request list

The list appears beside the editor as soon as one request is held. Drag its
divider (or use the arrow keys while focused on it) to resize the list; its
width is remembered. Search and **Filter** use the same choices as HTTP
history, including method, status, host, scope, extensions, bookmarks and
highlights. These filters only change which held requests are shown. Hidden
requests remain paused, and **Forward all** still sends every held request.

## Match &amp; Replace

**Match & Replace** opens from this screen and from **Settings > Proxy**. Rules
can rewrite request URLs, headers and bodies, an entire raw request, or an
entire raw response. Paste a sample HTTP message into **Replace Preview** to
see the enabled rules' result before saving them.

Plain text and regular expressions are supported, rules can be toggled without
deleting them, and the saved rules travel with a project export. Body rules run
against decompressed content while preserving the message's wire encoding.

Edits made to a held request are kept as versions, so the
[proxy history](proxy.md) can show the original, automatically modified and
final request side by side.
