---
layout: home
sidebar: false

hero:
  name: Lanius
  text: The local-first web security workspace
  tagline: >
    Built on mitmproxy for humans and AI agents. Capture in a proxy-ready
    browser, keep every test in a persistent project, and lock down outbound
    access when the network matters.
  image:
    src: /lanius_mascot_transparent.png
    alt: Lanius mascot
  actions:
    - theme: brand
      text: Download
      link: https://github.com/mirusu400/Lanius/releases/latest
    - theme: alt
      text: See it in action
      link: /showcase
    - theme: alt
      text: Getting Started
      link: https://github.com/mirusu400/Lanius#getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/mirusu400/Lanius

features:
  - title: Battle-tested engine
    details: >
      Lanius embeds mitmproxy, so TLS interception, HTTP/2 and WebSocket
      handling are proven in the field.
  - title: Live intercept and editing
    details: >
      Stop any request or response mid flight, edit it in a native editor
      with diffs and version history, and let it continue.
  - title: Replay and fuzzing
    details: >
      Re-send captured requests with modifications, or fuzz parameters with
      payload sets straight from the proxy history.
  - title: Plugins
    details: >
      Extend Lanius with signed plugin packages from catalogues, or write
      your own against the stable lanius_sdk boundary.
  - title: Native MCP tools
    details: >
      Built-in MCP tools let AI agents drive captures, replays and scans
      alongside you.
  - title: Lockdown Mode
    details: >
      Separate global and project switches block Lanius-owned external
      requests on sensitive networks while your proxy traffic keeps working.
---

<section class="home-showcase" aria-labelledby="home-showcase-title">
  <div class="home-showcase__heading">
    <p class="showcase-eyebrow">Inside the workspace</p>
    <h2 id="home-showcase-title">Capture, understand, and test</h2>
    <p>Follow a request from the proxied browser to the site map, then take it into Replay or Fuzzer without leaving the project.</p>
    <a class="showcase-link" href="/showcase">Explore the complete product tour →</a>
  </div>
  <div class="showcase-grid showcase-grid--featured">
    <a class="showcase-card" href="/proxy">
      <span class="showcase-card__media"><img src="/showcase/03-proxy-history.png" alt="HTTP history with request and response details"></span>
      <span class="showcase-card__body"><strong>See every request</strong><span>Capture browser traffic live and inspect both sides of the exchange.</span></span>
    </a>
    <a class="showcase-card" href="/target">
      <span class="showcase-card__media"><img src="/showcase/04-target-site-map.png" alt="Target site map of captured hosts and paths"></span>
      <span class="showcase-card__body"><strong>Map the attack surface</strong><span>Organise hosts, paths, methods, status codes, and scope in one tree.</span></span>
    </a>
    <a class="showcase-card" href="/replay">
      <span class="showcase-card__media"><img src="/showcase/06-replay-redacted.png" alt="Replay request editor, response viewer, and Inspector"></span>
      <span class="showcase-card__body"><strong>Change it and send again</strong><span>Edit a captured request, compare responses, and inspect encoded values.</span></span>
    </a>
    <a class="showcase-card" href="/fuzzer">
      <span class="showcase-card__media"><img src="/showcase/07-fuzzer-run.png" alt="Fuzzer payload configuration and live result table"></span>
      <span class="showcase-card__body"><strong>Scale up the test</strong><span>Run payload sets through marked positions and surface response outliers.</span></span>
    </a>
  </div>
</section>

<section id="comparison" class="home-comparison" aria-labelledby="comparison-title">
  <div class="home-comparison__heading">
    <p class="showcase-eyebrow">Why Lanius</p>
    <h2 id="comparison-title">The workflow you expect. The controls the others bolt on.</h2>
    <p>Lanius covers the everyday proxy toolkit, then adds native agent access, project-local data, and a real boundary for sensitive networks.</p>
  </div>

  <div class="rival-grid" aria-label="How Lanius compares with similar tools">
    <article class="rival-card">
      <span>vs mitmproxy</span>
      <strong>Same proven engine.</strong>
      <p>Far less assembly required.</p>
    </article>
    <article class="rival-card">
      <span>vs Burp Community</span>
      <strong>Keep the whole project.</strong>
      <p>Persistent workspaces and unrestricted payload fuzzing—without upgrading to Pro.</p>
    </article>
    <article class="rival-card">
      <span>vs OWASP ZAP</span>
      <strong>Stay focused on the test.</strong>
      <p>A manual testing workspace built for human–agent collaboration.</p>
    </article>
    <article class="rival-card">
      <span>vs Caido Basic</span>
      <strong>Local means local.</strong>
      <p>Native MCP. No account required. Lockdown built for sensitive networks.</p>
    </article>
  </div>

  <div class="comparison-legend" aria-label="Comparison legend">
    <span><i class="comparison-mark comparison-mark--yes" aria-hidden="true">✓</i> Included</span>
    <span><i class="comparison-mark comparison-mark--partial" aria-hidden="true">△</i> Limited or conditional</span>
    <span><i class="comparison-mark comparison-mark--no" aria-hidden="true">✕</i> Not available</span>
  </div>

  <div class="comparison-table-wrap" tabindex="0" aria-label="Scrollable product comparison">
    <table class="comparison-table">
      <thead>
        <tr>
          <th scope="col">Capability</th>
          <th scope="col" class="is-lanius">Lanius</th>
          <th scope="col">mitmproxy</th>
          <th scope="col">Burp Community</th>
          <th scope="col">OWASP ZAP</th>
          <th scope="col">Caido Basic</th>
        </tr>
      </thead>
      <tbody>
        <tr class="comparison-group comparison-group--priority"><th colspan="6" scope="colgroup">Access</th></tr>
        <tr class="comparison-priority">
          <th scope="row">Free</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: Community edition">△</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: account and Basic plan limits">△</span></td>
        </tr>
        <tr class="comparison-priority">
          <th scope="row">Open source</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not available">✕</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not available">✕</span></td>
        </tr>
        <tr class="comparison-group"><th colspan="6" scope="colgroup">Everyday workflow</th></tr>
        <tr>
          <th scope="row">One-click proxy-ready browser</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
        </tr>
        <tr>
          <th scope="row">Request / response intercept</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
        </tr>
        <tr>
          <th scope="row">Scope and site map UI</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: flow filters">△</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
        </tr>
        <tr>
          <th scope="row">Request replay</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
        </tr>
        <tr>
          <th scope="row">Unrestricted GUI fuzzing</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: Intruder demo">△</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
        </tr>
        <tr>
          <th scope="row">WebSocket intercept and resend</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: scripting required">△</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
        </tr>
        <tr>
          <th scope="row">GUI Match &amp; Replace</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: options or add-ons">△</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: Replacer add-on">△</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
        </tr>
        <tr>
          <th scope="row">Decoder and response diff</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: content views">△</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: encoding tools without integrated diff">△</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: conversion tools without integrated diff">△</span></td>
        </tr>
        <tr>
          <th scope="row">Persistent projects</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: saved flow files">△</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: Professional edition">△</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
        </tr>
        <tr>
          <th scope="row">Extension system</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
        </tr>
        <tr class="comparison-group"><th colspan="6" scope="colgroup">Where Lanius stands apart</th></tr>
        <tr>
          <th scope="row">Native desktop MCP</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: DAST product only">△</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: MCP Integration add-on">△</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: unofficial community bridge">△</span></td>
        </tr>
        <tr>
          <th scope="row">Plugin-owned MCP tools via first-party SDK</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: Extender scripts through add-on">△</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
        </tr>
        <tr>
          <th scope="row">Sensitive-header redaction for agent tools</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
        </tr>
        <tr>
          <th scope="row">Sensitive-network Lockdown Mode</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
        </tr>
        <tr>
          <th scope="row">GUI per-app or PID system capture</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: CLI Local Capture">△</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
        </tr>
        <tr>
          <th scope="row">Full integration Doctor</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: browser health check only">△</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
        </tr>
        <tr>
          <th scope="row">Unlimited persistent projects at entry level</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: Professional edition">△</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--partial" aria-label="Limited: paid plan">△</span></td>
        </tr>
        <tr>
          <th scope="row">No account required</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
        </tr>
        <tr>
          <th scope="row">Direct Burp settings import</th>
          <td class="is-lanius"><span class="comparison-mark comparison-mark--yes" aria-label="Included">✓</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
          <td><span class="comparison-mark comparison-mark--no" aria-label="Not included">✕</span></td>
        </tr>
      </tbody>
    </table>
  </div>

  <p class="comparison-note">
    Compared using publicly documented desktop capabilities and entry-level editions on 2026-11-02.
    ✓ means included as a first-party feature. △ means limited or conditional: an account,
    different edition, add-on, CLI, manual setup, or third-party component may be required.
    ✕ means unavailable.
    Check the current official documentation for
    <a href="https://docs.mitmproxy.org/stable/">mitmproxy</a>,
    <a href="https://portswigger.net/burp/documentation/desktop">Burp Suite</a>,
    <a href="https://www.zaproxy.org/docs/">OWASP ZAP</a>, and
    <a href="https://docs.caido.io/">Caido</a>.
  </p>

  <div class="comparison-cta">
    <div>
      <strong>Keep the capture local. Bring your own agent.</strong>
      <span>Start with a temporary project or keep the complete investigation in a workspace of its own.</span>
    </div>
    <a href="https://github.com/mirusu400/Lanius/releases/latest">Download Lanius</a>
  </div>
</section>
