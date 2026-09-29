# Outbound network policy

Lanius has a Lockdown Mode for sensitive networks. Every new Lanius-owned
outbound connection must be reviewed against it before the connection starts.

- Product features (updates, telemetry, downloads, cloud integrations and
  similar control traffic) must use `LockdownPolicy.require_outbound` in the
  Python engine, or `require_product_egress` in the Tauri shell.
- Keep both a server-side guard and clear UI feedback. A disabled button alone
  does not enforce the policy. HTTP refusals use status 423 with
  `LOCKDOWN_MODE_BLOCKED`; the shared UI client turns that into an error toast.
- Browser traffic, proxy forwarding, upstream connections and explicitly
  requested Repeater/Intruder traffic are user traffic and remain available.
- Plugins are arbitrary Python and can bypass an in-process HTTP wrapper.
  Keep plugin loading and execution suspended while Lockdown Mode is active.
  `PluginManager.suspended` is the one predicate for this; it covers safe mode
  and Lockdown Mode together, and every load path goes through `_load`.
- Guard a download where the bytes arrive, not only at the endpoint. The
  plugin catalogue does both: `PluginCatalogueManager.fetch` refuses, and the
  endpoints refuse first so a blocked install leaves the working plugin
  running.
- Global mode is stored outside projects and overrides project mode. Project
  mode belongs in the project database so exports carry it. Apply both before
  loading plugins or making any product-owned network request.
- When adding an outbound path, account for startup, manual use, in-flight
  requests and both global/project settings. Review the bundled dependencies
  for their own network behavior.
