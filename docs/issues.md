# Issues

Plugin-supplied passive and active checks create deduplicated project findings
in the **Issues** tab. Passive checks run over captured traffic; active checks
can be run against a captured flow by ID, with configurable concurrency and
rate, and scan jobs can be followed and stopped from the tab.

Filter findings by status (open, resolved, false positive), severity or free
text. The detail pane shows the finding, the parameter it concerns and the
check's evidence. Check limits and SDK contracts are documented in
[plugin-scanner.md](plugin-scanner.md).
