# Raw TCP

Traffic that is not HTTP is relayed at the byte level and shown as a hex dump,
so you can still see what is on the wire.

While [Lockdown Mode](lockdown-mode.md) is active with the project scope
egress option enabled, raw TCP and UDP are refused outright because they do
not have an HTTP URL that can be checked against the scope.
