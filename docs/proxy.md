# Proxy History

Every request and response, live. Filter by host, method, status or free text,
pause the stream while you read, and inspect headers and bodies. Sensitive
headers such as `Authorization` and `Cookie` are masked by default; reveal them
with one click when you need to.

Bodies carrying `Content-Encoding: gzip`, `deflate`, `br`, or `zstd` are
decompressed for display by default in History, Intercept, Replay and Fuzzer.
The original bytes stay in the capture and edited requests are encoded again
before sending. This can be disabled under **Settings > Proxy > HTTP body
display**. The original bytes of a captured body are available from
`GET /api/flows/{id}/body/request` and `/response`.

## Modified requests

History has a **Modified** column. When Match & Replace, Intercept, or a plugin
changes a request, its detail pane keeps **Original**, **Auto-modified**, and
**Modified request** tabs so every stage can be compared.

## Paging and search

History shows 200 requests per page; **Older**, **Newer**, and the page number
field move through the whole project. Search checks host, path, query, headers,
decoded request and response bodies, comments, and request versions throughout
the capture. The trigram index accelerates searches containing at least three
consecutive characters; shorter searches can still scan the index.

Pages use a snapshot anchor so new captures do not shift older pages, and
sequential **Older** navigation uses a cursor so deleting an earlier row does
not skip surviving records. A direct page-number jump still uses an offset,
which can move after deletions. The scope filter applies before paging, so a
rare old in-scope request remains reachable. API and MCP clients can pass the
returned `anchor` and `next_cursor` on later flow pages.

## Layout

Drag a table column header's right edge to resize it in History and other
headed data tables; column widths are remembered on this machine. Drag the
divider between side-by-side panes to resize them in Proxy, WebSockets, Replay,
Fuzzer, Logger, Diff, Docs, and editor dialogs. Each pane position is
remembered independently.

## Context menus

Right-click a request to send it to [Replay](replay.md) or the
[Fuzzer](fuzzer.md), add it to the [scope](target.md), or copy it as a URL.
The site map, Replay tabs and Fuzzer results have their own menus.

## Taking a request elsewhere

**Copy as** turns the request you are looking at into something you can run
somewhere else: curl, `fetch`, or Python `requests`. It is built from the
request the proxy actually saw, headers and body included, so the code repeats
it rather than approximating it. Available in Replay and Fuzzer too, where it
reflects your edits.

**CSRF proof of concept** builds a page that makes a browser send the request
by itself. Lanius opens it through the proxy, so the forged request appears in
the history next to the real one. When a request cannot be forged from another
site, because it needs a custom header or a JSON body or a method a form cannot
send, Lanius says so instead of producing a page that sends something else.

The example plugin `copy_as_python_redacted` adds **Python requests
(redacted)**, which replaces cookies, tokens and passwords with `[redacted]`
so a request can go into a report without the credentials going with it.
