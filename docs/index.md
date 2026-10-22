---
layout: home
sidebar: false

hero:
  name: Lanius
  text: A desktop web security testing proxy
  tagline: >
    Built on mitmproxy. See every request, stop it mid flight, change it,
    and send it again.
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
