/** Docs tab. */
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from '../App';
import { DocsTab, resetDocsPage } from './DocsTab';
import { docPages } from '../docs/pages';
import { renderWithI18n as render, t, tk, TEST_LOCALE } from '../test-utils';
import { LOCALES } from '../i18n';

beforeEach(resetDocsPage);
afterEach(cleanup);

/** Open the capture page: these assertions are about its content, and it
 * is no longer the page the tab opens on. */
async function openCapturePage() {
  const title = TEST_LOCALE === 'ko' ? '시스템 캡처' : 'System capture';
  // The nav button's accessible name includes the summary, so match a prefix.
  await userEvent.click(
    screen.getByRole('button', { name: new RegExp(`^${title}`) }),
  );
}

describe('DocsTab', () => {
  it('opens on the first page', async () => {
    render(<DocsTab />);
    const first = docPages(TEST_LOCALE)[0];
    expect(await screen.findByRole('heading', { level: 2 })).toBeTruthy();
    expect(screen.getByText(first.sections[0].heading)).toBeTruthy();
  });

  it('switches pages', async () => {
    render(<DocsTab />);
    const pages = docPages(TEST_LOCALE);
    const tls = pages.find((p) => p.id === 'tls')!;

    await userEvent.click(screen.getByRole('button', { name: new RegExp(tls.title) }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(tls.title);
  });

  it('renders code samples verbatim', async () => {
    render(<DocsTab />);
    await openCapturePage();
    // The capture page documents the rule syntax; it must be copyable.
    // The samples are literal, so they read the same in every locale.
    const code = document.querySelector('.docs-code')?.textContent ?? '';
    expect(code).toContain('/Applications/');
    expect(code).toContain('pid:');
  });

  it('documents the approval step, which is the usual sticking point', async () => {
    render(<DocsTab />);
    await openCapturePage();
    const body = document.querySelector('.docs-body')!.textContent ?? '';
    // macOS localises the pane name, so the docs do too.
    const expected = TEST_LOCALE === 'ko' ? '네트워크 확장' : 'Network Extensions';
    expect(body).toContain(expected);
    expect(body).toContain('Mitmproxy Redirector');
  });

  it('explains binding beyond this machine, and the risk', () => {
    // The listener page is what a user reaches for when a phone cannot
    // use the proxy, so it has to cover the address and say what it costs.
    render(<DocsTab />);
    const body = document.querySelector('.docs-body')!.textContent ?? '';
    expect(body).toContain('0.0.0.0');
    expect(body).toContain('127.0.0.1');
    const risk = TEST_LOCALE === 'ko' ? '트래픽을 보낼 수 있습니다' : 'send traffic through your proxy';
    expect(body).toContain(risk);
  });

  it('states the pinning limitation rather than overselling', async () => {
    render(<DocsTab />);
    await openCapturePage();
    const body = document.querySelector('.docs-body')!.textContent ?? '';
    const expected = TEST_LOCALE === 'ko' ? '피닝' : 'pin';
    expect(body.toLowerCase()).toContain(expected);
  });
});

describe('reading position', () => {
  it('keeps your place when the tab is unmounted and shown again', async () => {
    // Switching to Proxy and back unmounts this component; losing your
    // place mid-article makes in-app docs annoying to use.
    const pages = docPages(TEST_LOCALE);
    const target = pages[pages.length - 1];

    const view = render(<DocsTab />);
    await userEvent.click(
      screen.getByRole('button', { name: new RegExp(target.title) }),
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(target.title);

    view.unmount();
    render(<DocsTab />);

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(target.title);
  });
});

describe('documentation content', () => {
  it('covers the same pages in every locale', () => {
    const ids = LOCALES.map((locale) => docPages(locale).map((p) => p.id));
    for (const list of ids) expect(list).toEqual(ids[0]);
  });

  it('has no empty sections', () => {
    for (const locale of LOCALES) {
      for (const page of docPages(locale)) {
        expect(page.summary.trim()).not.toBe('');
        expect(page.sections.length).toBeGreaterThan(0);
        for (const section of page.sections) {
          expect(section.heading.trim()).not.toBe('');
          expect(section.blocks.length).toBeGreaterThan(0);
          for (const block of section.blocks) expect(block.body.trim()).not.toBe('');
        }
      }
    }
  });

  it('is actually translated, not copied', () => {
    // A Korean page that still reads in English would be a silent
    // regression, since nothing else checks these strings.
    const en = docPages('en');
    const ko = docPages('ko');
    for (let i = 0; i < en.length; i += 1) {
      expect(ko[i].title).not.toBe(en[i].title);
      expect(ko[i].summary).not.toBe(en[i].summary);
    }
  });

  it('uses no dashes, matching the rest of the project', () => {
    for (const locale of LOCALES) {
      const text = JSON.stringify(docPages(locale));
      expect(text).not.toMatch(/[\u2014\u2013]/);
    }
  });
});

describe('tab wiring', () => {
  it('is reachable from the title bar', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: t('docs.title') }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      docPages(TEST_LOCALE)[0].title,
    );
  });

  it('follows the interface language', async () => {
    render(<DocsTab />, { locale: 'ko' });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      docPages('ko')[0].title,
    );
    expect(tk('ko')('docs.title')).toBe('문서');
  });
});
