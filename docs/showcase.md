---
aside: false
---

# Lanius in action

Lanius keeps capture, investigation, and active testing inside one project.
This tour follows the workflow from choosing a workspace to cleaning up its
saved traffic.

::: tip Public demo
The screenshots use public-site traffic. Potentially sensitive request content
in the Replay view is deliberately redacted.
:::

<div class="showcase-grid">
  <a class="showcase-card" href="/projects">
    <span class="showcase-card__media"><img src="/showcase/01-project-picker.png" alt="Project picker with temporary and named project options"></span>
    <span class="showcase-card__body"><strong>1. Choose a workspace</strong><span>Start a disposable session, create a named project, or reopen saved work. Global Lockdown Mode and the local API port are available before the engine starts.</span><em>Projects →</em></span>
  </a>
  <a class="showcase-card" href="/dashboard">
    <span class="showcase-card__media"><img src="/showcase/02-dashboard-doctor.png" alt="Dashboard showing proxy and browser readiness checks"></span>
    <span class="showcase-card__body"><strong>2. Verify the setup</strong><span>Doctor checks the engine, listener, proxied browser, HTTPS certificate, and capture activity, then points directly to the setting that needs attention.</span><em>Dashboard →</em></span>
  </a>
  <a class="showcase-card" href="/proxy">
    <span class="showcase-card__media"><img src="/showcase/03-proxy-history.png" alt="HTTP history beside a proxied browser with request and response details"></span>
    <span class="showcase-card__body"><strong>3. Capture live traffic</strong><span>Use the separate proxied browser profile and watch requests arrive in HTTP history. Select any row to inspect the complete request and response.</span><em>Proxy History →</em></span>
  </a>
  <a class="showcase-card" href="/target">
    <span class="showcase-card__media"><img src="/showcase/04-target-site-map.png" alt="Target site map grouping captured hosts and paths"></span>
    <span class="showcase-card__body"><strong>4. Map the attack surface</strong><span>Captured hosts and paths become a navigable site map with methods, status codes, endpoint groups, and scope-aware filtering.</span><em>Target →</em></span>
  </a>
  <a class="showcase-card" href="/plugin-catalogues">
    <span class="showcase-card__media"><img src="/showcase/05-plugin-catalogue.png" alt="Plugin catalogue with analysis and workflow extensions"></span>
    <span class="showcase-card__body"><strong>5. Extend the workflow</strong><span>Browse signed catalogue releases and add focused analysis, automation, reporting, or testing capabilities to the desktop app.</span><em>Plugin Catalogues →</em></span>
  </a>
  <a class="showcase-card" href="/replay">
    <span class="showcase-card__media"><img src="/showcase/06-replay-redacted.png" alt="Replay editor with redacted request content, response, and Inspector"></span>
    <span class="showcase-card__body"><strong>6. Replay with changes</strong><span>Edit a captured request, resend it, step through prior exchanges, follow redirects, and decode selected values beside the response.</span><em>Replay →</em></span>
  </a>
  <a class="showcase-card" href="/fuzzer">
    <span class="showcase-card__media"><img src="/showcase/07-fuzzer-run.png" alt="Fuzzer running a payload set and displaying live results"></span>
    <span class="showcase-card__body"><strong>7. Run payload sets</strong><span>Mark insertion points, choose a run strategy, and compare status, length, and timing while results stream into the table.</span><em>Fuzzer →</em></span>
  </a>
  <a class="showcase-card" href="/projects">
    <span class="showcase-card__media"><img src="/showcase/08-project-storage.png" alt="Project storage screen for reviewing targets and compacting the database"></span>
    <span class="showcase-card__body"><strong>8. Keep the project lean</strong><span>Review storage by captured target, remove traffic that no longer matters, and compact the database without losing scope, settings, or saved tabs.</span><em>Projects →</em></span>
  </a>
</div>

Ready to try the workflow? [Download the latest release](https://github.com/mirusu400/Lanius/releases/latest)
or follow [Getting started](https://github.com/mirusu400/Lanius#getting-started).
