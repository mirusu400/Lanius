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
