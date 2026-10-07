import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

const require = createRequire(import.meta.url)
const vueRuntime = require.resolve('vue/dist/vue.runtime.esm-bundler.js')
const vueServerRenderer = fileURLToPath(import.meta.resolve('vue/server-renderer'))

const repo = 'https://github.com/mirusu400/Lanius'

export default defineConfig({
  title: 'Lanius',
  description: 'A desktop web security testing proxy, built on mitmproxy.',
  head: [
    ['link', { rel: 'icon', href: '/app_icon.png' }],
    ['meta', { property: 'og:title', content: 'Lanius' }],
    ['meta', { property: 'og:description', content: 'A desktop web security testing proxy, built on mitmproxy.' }],
    ['meta', { property: 'og:image', content: 'https://lanius.mir.sh/lanius_social_preview.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  // The wiki is the existing docs/ directory; this website is presentation only.
  srcDir: '../docs',
  srcExclude: ['research/**', 'plugin-platform-status.md'],
  rewrites: {
    'releases/v0.2.0.md': 'releases/v0-2-0.md',
    'releases/v0.3.0.md': 'releases/v0-3-0.md',
  },
  cleanUrls: true,
  sitemap: {
    hostname: 'https://lanius.mir.sh',
  },
  vite: {
    // docs/ lives outside the website root, so bare imports from markdown
    // modules cannot walk up to website/node_modules. Pin vue to this
    // project's copy so the outside-root importers resolve it too.
    // Static assets follow VitePress convention: docs/public/.
    resolve: {
      alias: [
        { find: /^vue$/, replacement: vueRuntime },
        { find: /^vue\/server-renderer$/, replacement: vueServerRenderer },
      ],
    },
    server: {
      fs: {
        allow: ['..'],
      },
    },
  },
  themeConfig: {
    logo: '/lanius_mascot_transparent.png',
    siteTitle: 'Lanius',
    nav: [
      { text: 'Wiki', link: '/features' },
      { text: 'Plugins', link: '/plugins-sdk' },
      { text: 'Releases', link: `${repo}/releases` },
    ],
    sidebar: {
      '/': [
        {
          text: 'Overview',
          items: [{ text: 'Features', link: '/features' }],
        },
        {
          text: 'Proxy',
          items: [
            { text: 'Dashboard', link: '/dashboard' },
            { text: 'Proxy History', link: '/proxy' },
            { text: 'Intercept', link: '/intercept' },
            { text: 'WebSockets', link: '/websockets' },
            { text: 'Target', link: '/target' },
            { text: 'Raw TCP', link: '/raw-tcp' },
            { text: 'Logger', link: '/logger' },
            { text: 'Lockdown Mode', link: '/lockdown-mode' },
          ],
        },
        {
          text: 'Testing',
          items: [
            { text: 'Replay', link: '/replay' },
            { text: 'Fuzzer', link: '/fuzzer' },
            { text: 'Decoder and Diff', link: '/decoder-diff' },
            { text: 'Issues', link: '/issues' },
          ],
        },
        {
          text: 'Platform',
          items: [
            { text: 'Projects', link: '/projects' },
            { text: 'AI Agents', link: '/ai-agents' },
            { text: 'Settings', link: '/settings' },
          ],
        },
        {
          text: 'Plugins',
          items: [
            { text: 'Plugin SDK', link: '/plugins-sdk' },
            { text: 'Plugin Packages', link: '/plugin-packages' },
            { text: 'Plugin Catalogues', link: '/plugin-catalogues' },
            { text: 'Plugin Scanner', link: '/plugin-scanner' },
          ],
        },
        {
          text: 'Notes',
          items: [
            { text: 'Theme Palette Sources', link: '/theme-sources' },
            { text: 'Release 0.3.0', link: '/releases/v0-3-0' },
            { text: 'Release 0.2.0', link: '/releases/v0-2-0' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: repo }],
    outline: 'deep',
  },
})
