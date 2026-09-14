# Research: system-wide interception, Proxifier style

Question: can Lanius capture traffic from *every* application on macOS and
Windows, without each app being configured to use the proxy?

Short answer: yes, and most of the work is already sitting in the
dependency we ship. mitmproxy calls it **local capture mode**. This
document records what was verified on this machine, what it costs, and
where it stops working.

## What was actually checked

Everything below was run against the engine's own virtualenv, not read
off a webpage.

| Check | Result |
|---|---|
| `mitmproxy` version we bundle | 12.2.3 |
| `LocalMode` exists in the installed build | yes, documented as "OS-level transparent proxy" |
| `mitmproxy_rs.local.start_local_redirector` docstring | "Start an OS-level proxy to intercept traffic from the current machine. *Availability: Windows, Linux, and macOS*" |
| `LocalRedirector.unavailable_reason()` on this Mac | `None`, i.e. supported here |
| Process filter syntax | `curl`, `!curl`, `curl,firefox`, `pid:1234`, `/usr/bin/curl` all parse |
| Passing `local:curl` through our own `LANIUS_EXTRA_MODES` | engine starts, mode is accepted, server reports `listening: True` |
| Actually capturing an unproxied `curl` | **no**, blocked on user approval (see below) |

## How it works, per platform

**macOS.** A Network Extension built on Apple's *App Proxy Provider* API.
mitmproxy ships a helper app, and on first use it installs itself:
`/Applications/Mitmproxy Redirector.app` appeared during this research,
signed `Developer ID Application: Maximilian Hils (S8XHQB96PW)` and
notarised. The code-signing problem that normally makes this class of
feature painful is therefore already solved by upstream, and not
something Lanius would have to pay for.

**Windows.** A privileged helper process using
[WinDivert](https://reqrypt.org/windivert.html) for packet capture, with
TCP reassembly done in mitmproxy's own userspace stack. Needs to run
elevated; there is no kernel driver of our own to sign.

**Linux.** eBPF, needs root via `sudo` and kernel 6.8+. Out of scope for
the question but relevant if we later ship it.

## The blocker found on this machine

`systemextensionsctl list` reports:

```
org.mitmproxy.macos-redirector.network-extension  [activated waiting for user]
```

and the system log repeats `reached state: activated_waiting_for_user`.
The extension is installed and valid; macOS is waiting for a human to
approve it in System Settings > General > Login Items & Extensions >
Network Extensions. Until then `start_local_redirector` simply never
returns: a direct call timed out after 25s, and an end-to-end test that
ran an unproxied `curl` captured nothing.

This is expected and unavoidable. Any tool that reroutes another
process's traffic needs explicit consent; Proxifier has the same prompt.

## What the engine could not tell you about its own modes

We pass `LANIUS_EXTRA_MODES` straight into mitmproxy's `mode` list, and
we remove the `errorcheck` addon because it calls `sys.exit(1)` and would
kill the host app. Two distinct problems came out of this, and it is
worth being precise about which is which.

**A mode that fails to bind was logged but not exposed.** Measured by
running the engine with `reverse:...@<port>` against a port already in
use, before and after the fix:

| | before | after |
|---|---|---|
| mitmproxy's own error in the log | yes | yes |
| `app.proxy` reports which mode failed | no | yes |
| `modes` in `/api/status` | key absent | `running=false`, with the error |

So the log was never truly silent here; what was missing was any
machine-readable signal. A UI had no way to show that one of several
modes was down.

**A mode that hangs cannot be seen through mitmproxy at all.** This is
the case that matters for local capture. With the macOS extension
awaiting approval, mitmproxy still reports:

```
local:curl     running=True listening=False error=None
```

It considers the mode started because the redirector task was spawned;
it is simply blocked forever waiting for consent, so there is no
exception to report. `listening=False` is not a tell either, since local
capture never binds an address even when healthy.

The state has to come from the OS instead. On macOS
`systemextensionsctl list` reports it, needs no privileges and returns in
about 15ms, so the engine now reads it directly. Starting with a local
mode while the extension is unapproved logs:

```
WARNING app.proxy: local capture is not active yet (activated waiting
for user); traffic will not be intercepted until the system extension is
approved
```

`/api/status` and `/api/dashboard` both carry
`local_capture: {supported, approved, detail}` alongside the per-mode
list, and the Dashboard shows a banner naming the exact place to click:

> **System capture needs approval**
> Approve the Mitmproxy Redirector extension in System Settings >
> General > Login Items & Extensions > Network Extensions. Until then,
> traffic from other apps is not captured.

An extension that is missing entirely reads differently from one waiting
for consent, because those need different actions from the user. Windows
and Linux elevate per run rather than holding a persistent approval, so
they report `approved: true` and no banner appears.

This turned out to be much cheaper than first assumed: the earlier draft
of this note listed it as a prerequisite needing new platform code.

## What it would take to ship

1. ~~**Expose per-mode state.**~~ Done: `/api/status` now reports each
   mode's `running`, `listening` and `error`. Covers modes that fail to
   bind, not modes that hang.
2. **A capture-mode control in Settings**: off / this machine / selected
   apps, mapping to no mode, `local`, `local:<spec>`.
3. **Approval flow on macOS.** Detect `activated waiting for user`, and
   tell the user what to click rather than hanging. This is the main
   design work.
4. **Elevation on Windows.** The redirector needs admin rights; decide
   whether to prompt per session or install a service.
5. **Certificate trust.** Redirecting the bytes is only half of it. An
   app that does not trust our CA will fail TLS rather than be
   intercepted. mitmproxy has groundwork for installing the cert into the
   system store on macOS.
6. **A process picker**, since `local:<name>` takes process names or PIDs
   and users should not have to type them.

## Where it will not work

These are properties of the approach, not gaps in the implementation.

- **Certificate pinning.** Apps that pin (most mobile-derived apps, many
  Electron updaters, anything doing mutual TLS) will refuse the
  connection. This is the single biggest practical limit and no amount
  of redirection fixes it.
- **Inbound connections.** Egress only, on both macOS and Linux.
- **Non-TCP/UDP traffic.** The macOS App Proxy Provider API covers TCP
  and UDP; anything else stays with the OS.
- **QUIC/HTTP3.** Often falls back to TCP when tampered with, but not
  always.
- **Lanius's own traffic**, which would otherwise loop.

## Recommendation

Worth doing, and cheaper than it looks: the interception engine, the
signed macOS extension and the Windows redirector all come from
`mitmproxy_rs`, which we already ship. The work is almost entirely in our
own UX, permission handling, and error reporting.

Suggested order:

1. ~~Expose per-mode state.~~ Done.
2. ~~Detect the macOS approval state.~~ Done: `/api/status` reports
   `local_capture`, and the engine warns when a local mode is started
   unapproved.
3. A Settings toggle for "capture this machine", macOS first. The
   approval banner already exists; what is missing is the control that
   turns the mode on without editing `LANIUS_EXTRA_MODES`.
4. The per-app picker.
5. Then Windows, which additionally needs the elevation story.

Steps 2 onward are a feature in their own right and should be scoped
separately.
