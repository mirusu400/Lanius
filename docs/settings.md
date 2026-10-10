# Settings

Settings covers the proxy listener, upstream proxy, TLS fingerprint, system
capture, appearance, language, keyboard shortcuts, updates and Lockdown Mode.
Appearance, shortcuts and other machine-level choices are not part of a
[project export](projects.md).

## Finding a setting

Use the search box at the top of Settings to search across every tab, including
ones you have not opened. English and Korean names, option labels and related
keywords are searchable. Select a result to open its tab, scroll to the section
and briefly highlight it. Use the arrow keys and Enter to choose a result, or
Escape to dismiss results. With reduced motion enabled, the destination gets
a steady highlight instead of a pulse.

## Doctor certificate checks

On Windows, Doctor compares the current proxy CA with the local Windows
Trusted Root Certification Authorities store for HTTPS use. Installing an old
CA with the same name is not enough. If it is missing, install the certificate
from `mitm.it` into that store for the current user or local computer and run
Doctor again. Store inspection failures are shown as **Not verified**, rather
than as a certificate error. Browsers with separate certificate stores and
other devices still need their own trust setup. The check makes no test
connection and does not change TLS verification.

## Proxy listener and API port

Port 8080 is a popular default and another tool may already have it. Open
**Settings > Proxy listener** and pick a free port. If the port was taken at
launch, Lanius says so there and keeps running so you can change it; the rest
of the app works meanwhile.

The same section sets the bind address. By default the proxy accepts
connections from this machine only. Choose **All interfaces** or a specific
address to let a phone or a virtual machine point at it, then set their proxy
to this machine's address and the port shown. Anyone who can reach that
address can send traffic through your proxy, so prefer a specific address over
all interfaces on a network you do not control.

The API and MCP port is described in [ai-agents.md](ai-agents.md).

## Upstream proxy

To send browser traffic through other proxies, open **Settings > Proxy >
Upstream proxy**, choose **Use upstream proxy**, and enter HTTP, HTTPS, or
SOCKS5 proxy URLs such as `http://127.0.0.1:8081` and
`socks5://127.0.0.1:1080`. Add and reorder hops to choose the path from Lanius
to the destination. The browser still connects to Lanius. The chain is saved
with the project and takes effect when applied.

HTTPS proxy certificates are verified. Proxy authentication is not supported
yet. SOCKS5 routing covers TCP connections; UDP relay is not part of the
browser listener. Multi-hop and SOCKS5 routing use a bundled GOST bridge on a
loopback port.

## Looking like a browser

Lanius terminates TLS, so the server fingerprints the proxy rather than your
client. **Settings > TLS fingerprint** reshapes the handshake to resemble
Chrome, Firefox or Safari, or forces TLS 1.2, and accepts a custom OpenSSL
cipher string. This covers the cipher list and TLS version, not a full JA3 or
JA4 match.

On macOS, HTTPS server certificates are verified automatically using Keychain
trust settings, including trusted VPN and private CAs. A CA already trusted
for SSL in Keychain does not need to be registered again in Lanius. Hostname
and leaf validity checks remain enabled, and verification does not download
intermediates or revocation responses.

**Settings > Proxy > Upstream CA certificates** lets a project add other VPN
or private CAs when needed. Choose a PEM file or paste its public CA
certificates, then apply. These supplement macOS trust; other platforms extend
the default public CA list. Server certificate verification stays enabled.
Applying or removing it restarts proxy connections and cancels active
Replay/Fuzzer requests. CA certificates are saved in the project database, but
importing a project keeps the current CA trust: new trust anchors must be
registered explicitly. Private keys, leaf certificates and expired CAs are
rejected.

## Media body storage

**Settings > Project > Media body storage** skips storing HTTP image, audio and
video bodies at or above a configurable size. The default is 5 MB
(5 × 1,024 × 1,024 bytes); set 0 for unlimited storage. The limit applies to
the actual captured body bytes, including uploads and modified request
snapshots. Content-Type identifies media; missing or generic binary types
also use common media filename extensions. HTML, JSON, other non-media
downloads and raw TCP streams retain their bodies.

Headers, status, timing and original sizes remain in History, with a notice
when the body was omitted. Omitted bodies are excluded from body search and
previews. Proxy forwarding remains complete. The setting is saved with the
project and takes effect on new captures immediately. Existing captures and
imported backups are not trimmed automatically.

## System capture

Some applications never look at the system proxy. Lanius can capture them at
the operating system level instead, so they do not need to be configured at
all. This is experimental.

Open the **Settings** tab, find **System capture**, and choose whether to
capture every application or only the ones you name. Selected applications
gives you a list: add a rule and type part of a name, or pick from what is
running and have its path filled in. Each rule matches part of the executable
path, so a fragment is enough:

```
chrome            Google Chrome, and anything with chrome in its path
/Applications/    everything installed there
pid:4123          one process
```

Set a rule to exclude to leave something out, or untick it to switch it off
without deleting it.

On macOS this installs a network extension the first time, and macOS will ask
you to approve it in **System Settings > General > Login Items & Extensions >
Network Extensions**. Lanius tells you when it is waiting. On Windows the
helper needs to run with administrator rights.

The system redirector cannot be reconfigured while it is running, so changing
the setting after capture has already started takes effect on the next launch.
Lanius says so when that happens.

Applications that pin their certificates will refuse the connection rather
than be intercepted. That is a property of pinning, not something Lanius can
work around.

## Appearance and language

**Settings > Appearance** offers Steel as the default dark palette, the
original dark palette as Classic Dark, Light, Copper, Sage, Paper, and six
editor palette adaptations: Monokai Classic, Gruvbox Dark, Dracula, Tokyo
Night, Catppuccin Mocha, and Solarized Dark. Their sources are credited in
[theme-sources.md](theme-sources.md). It follows the system by default.

The interface font and the editor font are set separately, with their own
sizes, since one is for labels and the other for raw HTTP where a monospace
font keeps columns lined up. A preview shows the result as you change it.

The interface is available in English and Korean. Switch in **Settings**; the
choice is remembered. Settings and Docs use the available window width when
you resize the app.

## Keyboard shortcuts

Switch between Lanius screens with **⌘+Option+0–9** on macOS or
**Ctrl+Alt+0–9** on Linux and Windows (Dashboard is 0, Proxy is 1, and the
remaining screens follow the tab bar). Use **⌘+Option+D** or **Ctrl+Alt+D**
for Docs. Send the selected request to Replay with **⌘+R** on macOS or
**Ctrl+R** on Linux and Windows, or to Fuzzer with **⌘+I** / **Ctrl+I**.
These work in Proxy history, Intercept and Target. In Replay, Send to Fuzzer
carries the current edited request; in Fuzzer, Send to Replay opens the
selected result. An open context menu uses its right-clicked request.
**Settings > Shortcuts** lists these actions alongside every screen and Replay
action, and lets you record, disable, or reset each shortcut. These choices
are saved on this machine.

## Updates

Settings, About says which commit a build came from and checks whether a newer
one has been published. Nightlies are compared by commit and stable releases
by version. The desktop app can install what it finds, in one press; nothing
downloads on its own, and the check itself can be turned off for a network
where nothing should leave the machine.

Signed builds can install themselves: **Install and restart** downloads the
new bundle from the selected stable or nightly channel, verifies its signature,
replaces the app and comes back up. Windows MSI and NSIS installs each receive
their matching installer. Linux AppImage installs support this;
`.deb` installs use the download link for upgrades. The
[README](https://github.com/mirusu400/Lanius#releasing-with-the-in-app-updater)
describes the signing setup.

## Lockdown Mode

For sensitive networks, **Settings > Lockdown Mode** has separate global and
project switches. They block Lanius-owned external requests while browser and
proxy traffic remain available by default. A project option can additionally
drop out-of-scope HTTP/HTTPS proxy traffic and all raw TCP/UDP while Lockdown
is active. The global switch can also be forced before launch with
`LANIUS_LOCKDOWN=1`. See [lockdown-mode.md](lockdown-mode.md) for the exact
scope.
