# Dashboard

The Dashboard is an overview of the current capture. It shows request, host
and traffic totals, average response time, a recent-seconds window with
in-flight and failed counts, and how long capturing has been running.

**Doctor** checks whether the engine responds, the proxy listener and other
configured modes are running, a proxied browser and CA file are available,
system capture has approval when enabled, and any traffic has been captured.
It offers links to the relevant settings and can rerun the checks. These are
local readiness checks: Doctor does not send a request to an external site or
claim that another browser or device trusts the CA. If the engine is
unreachable, the Dashboard shows the error and a retry button.

It shows the engine and proxy state, whether interception is on and how many
requests are held, responses grouped by status class, methods, and the busiest
hosts. Method and status chips open the matching
[proxy history](proxy.md), and system capture approval or failure states are
surfaced here too. When system capture is waiting for macOS approval, the
Dashboard explains where to approve the network extension.
