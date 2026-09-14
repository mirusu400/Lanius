import { useMemo, useState } from 'react';

import { docPages, type DocBlock } from '../docs/pages';
import { useI18n } from '../i18n';

/** The page you were reading, kept outside the component: React unmounts
 *  this tab when you switch away, and losing your place mid-article is
 *  the sort of thing that makes in-app docs annoying to use. */
let lastPageId = '';

/** Test helper: the remembered page deliberately outlives the component. */
export function resetDocsPage(): void {
  lastPageId = '';
}

export function DocsTab() {
  const { t, locale } = useI18n();
  const pages = useMemo(() => docPages(locale), [locale]);
  const [activeId, setActiveId] = useState(() => lastPageId || (pages[0]?.id ?? ''));

  const selectPage = (id: string) => {
    lastPageId = id;
    setActiveId(id);
  };

  // The locale can change while this tab is open, and ids are stable
  // across locales, so the selection survives.
  const active = pages.find((page) => page.id === activeId) ?? pages[0];

  if (!active) return <div className="docs-tab" />;

  return (
    <div className="docs-tab">
      <nav className="docs-nav" aria-label={t('docs.contents')}>
        {pages.map((page) => (
          <button
            key={page.id}
            className={page.id === active.id ? 'active' : undefined}
            onClick={() => selectPage(page.id)}
          >
            <strong>{page.title}</strong>
            <span>{page.summary}</span>
          </button>
        ))}
      </nav>

      <article className="docs-body">
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
      </article>
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
