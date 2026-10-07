/** The website and the app read the same Markdown under docs/. Vite bundles
 * these files, so the wiki still works when Lanius is offline. */

const markdownFiles = {
  ...import.meta.glob('../../../docs/*.md', { eager: true, query: '?raw', import: 'default' }),
  ...import.meta.glob('../../../docs/releases/*.md', { eager: true, query: '?raw', import: 'default' }),
} as Record<string, string>;

const contentById = new Map(
  Object.entries(markdownFiles).map(([path, content]) => [
    path.split('/docs/')[1].replace(/\.md$/, ''),
    content,
  ]),
);

export interface WikiPage {
  id: string;
  title: string;
  content: string;
}

export interface WikiGroup {
  title: string;
  pages: WikiPage[];
}

function page(id: string, title: string): WikiPage {
  const content = contentById.get(id);
  if (!content) throw new Error(`Missing wiki page: ${id}`);
  return { id, title, content };
}

/** features.md is also the website's feature index, so it defines the
 * in-app feature navigation without another hand-maintained page list. */
function featureGroups(): WikiGroup[] {
  const groups: WikiGroup[] = [{ title: 'Overview', pages: [page('features', 'Features')] }];
  const index = contentById.get('features') ?? '';
  for (const line of index.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      groups.push({ title: heading[1], pages: [] });
      continue;
    }
    const link = /^- \[([^\]]+)\]\(([^)]+)\.md\)/.exec(line);
    if (link) groups.at(-1)!.pages.push(page(link[2], link[1]));
  }
  return groups;
}

export const wikiGroups: WikiGroup[] = [
  ...featureGroups(),
  {
    title: 'Notes',
    pages: [
      page('theme-sources', 'Theme palette sources'),
      page('releases/v0.3.0', 'Release 0.3.0'),
      page('releases/v0.2.0', 'Release 0.2.0'),
    ],
  },
];

const wikiPageIds = new Set(wikiGroups.flatMap((group) => group.pages.map((item) => item.id)));

export function wikiPage(id: string): WikiPage | undefined {
  return wikiGroups.flatMap((group) => group.pages).find((item) => item.id === id);
}

/** Resolve a relative Markdown link to a bundled page rather than the web. */
export function linkedWikiPage(currentId: string, href?: string): string | null {
  if (!href) return null;
  const base = `https://lanius.invalid/${currentId}.md`;
  const url = new URL(href, base);
  if (url.origin !== 'https://lanius.invalid' || !url.pathname.endsWith('.md')) return null;
  const id = url.pathname.slice(1, -3);
  return wikiPageIds.has(id) ? id : null;
}
