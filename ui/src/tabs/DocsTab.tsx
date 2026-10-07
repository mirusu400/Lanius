import { useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { docPages, type DocBlock } from '../docs/pages';
import { linkedWikiPage, wikiGroups, wikiPage } from '../docs/wiki';
import { useI18n } from '../i18n';
import { Split } from '../components/Split';

/** Keep the selected page when the workspace itself is remounted. Ordinary
 *  tab switches retain this component, including its scroll position. */
let lastPageId = '';

/** Test helper: the remembered page deliberately outlives the component. */
export function resetDocsPage(): void {
  lastPageId = '';
}

export function DocsTab() {
  const { t, locale } = useI18n();
  const pages = useMemo(() => docPages(locale), [locale]);
  const [activeId, setActiveId] = useState(() => lastPageId || 'wiki:features');
  const bodyRef = useRef<HTMLElement>(null);

  const selectPage = (id: string) => {
    lastPageId = id;
    setActiveId(id);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  // The locale can change while this tab is open, and ids are stable
  // across locales, so the selection survives.
  const activeWiki = activeId.startsWith('wiki:') ? wikiPage(activeId.slice(5)) : undefined;
  const active = pages.find((page) => `guide:${page.id}` === activeId);

  if (!activeWiki && !active) return <div className="docs-tab" />;

  return (
    <div className="docs-tab">
      <Split
        direction="horizontal"
        storageKey="lanius.split.docs"
        initial={0.26}
        className="docs-split"
        first={<nav className="docs-nav" aria-label={t('docs.contents')}>
          <h2 className="docs-nav-heading">{t('docs.wiki')}</h2>
          {wikiGroups.map((group) => (
            <div className="docs-nav-group" key={group.title}>
              <h3>{group.title}</h3>
              {group.pages.map((page) => (
                <button
                  key={page.id}
                  className={activeId === `wiki:${page.id}` ? 'active' : undefined}
                  onClick={() => selectPage(`wiki:${page.id}`)}
                >
                  <strong>{page.title}</strong>
                </button>
              ))}
            </div>
          ))}
          <h2 className="docs-nav-heading">{t('docs.quickGuides')}</h2>
          {pages.map((page) => (
            <button
              key={page.id}
              className={activeId === `guide:${page.id}` ? 'active' : undefined}
              onClick={() => selectPage(`guide:${page.id}`)}
            >
              <strong>{page.title}</strong>
              <span>{page.summary}</span>
            </button>
          ))}
      </nav>}

        second={<article className="docs-body" ref={bodyRef}>
        {activeWiki ? (
          <div className="docs-wiki">
            <p className="docs-wiki-language">{t('docs.wikiEnglish')}</p>
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                a({ href, children }) {
                  const target = linkedWikiPage(activeWiki.id, href);
                  return target ? (
                    <a href={`#wiki:${target}`} onClick={(event) => {
                      event.preventDefault();
                      selectPage(`wiki:${target}`);
                    }}>{children}</a>
                  ) : (
                    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                  );
                },
              }}
            >
              {activeWiki.content}
            </Markdown>
          </div>
        ) : active && (
          <>
            <h2>{active.title}</h2>
            <p className="docs-summary">{active.summary}</p>
            {active.sections.map((section) => (
              <section key={section.heading}>
                <h3>{section.heading}</h3>
                {section.blocks.map((block, index) => (
                  <Block key={index} block={block} />
                ))}
              </section>
            ))}
          </>
        )}
      </article>}
      />
    </div>
  );
}

function Block({ block }: { block: DocBlock }) {
  if (block.kind === 'code') {
    return <pre className="mono docs-code">{block.body}</pre>;
  }
  if (block.kind === 'note') {
    return <p className="docs-note">{block.body}</p>;
  }
  // Blank lines separate paragraphs; a single newline is a line break, so
  // short lists read as lists rather than one run-on sentence.
  return (
    <p>
      {block.body.split('\n').map((line, index) => (
        <span key={index}>
          {line}
          <br />
        </span>
      ))}
    </p>
  );
}
