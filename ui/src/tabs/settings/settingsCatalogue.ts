/** The same section catalogue drives Settings layout and search destinations. */
import { CATALOGUES, type TranslationKey } from '../../i18n/catalogue';

export const SETTINGS_GROUPS = [
  'proxy', 'shortcuts', 'browser', 'appearance', 'integrations', 'security', 'project', 'about',
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

interface SectionEntry {
  id: string;
  group: SettingsGroup;
  title: TranslationKey;
  prefixes?: readonly string[];
  keys?: readonly TranslationKey[];
  aliases?: string;
}

export const SETTINGS_SECTIONS = [
  { id: 'listener', group: 'proxy', title: 'listener.section', prefixes: ['listener.'], aliases: 'port bind address 포트 바인딩 주소 리스너' },
  { id: 'upstream', group: 'proxy', title: 'upstream.section', prefixes: ['upstream.'], aliases: 'SOCKS5 HTTP HTTPS chain hops 상위 프록시 체인 경유' },
  { id: 'tls-trust', group: 'proxy', title: 'tlsTrust.section', prefixes: ['tlsTrust.'], aliases: 'certificate cert CA VPN PEM Keychain 인증서 신뢰 키체인' },
  { id: 'body-display', group: 'proxy', title: 'bodyDisplay.section', prefixes: ['bodyDisplay.'], aliases: 'gzip deflate Brotli Zstandard 압축 해제' },
  { id: 'match-replace', group: 'proxy', title: 'matchReplace.title', prefixes: ['matchReplace.'], aliases: 'regex rewrite replace 정규식 치환 변경 규칙' },
  { id: 'engine', group: 'proxy', title: 'settings.proxySection', keys: ['settings.projectDb', 'settings.capturedFlows', 'settings.engineUnreachable', 'common.status', 'common.version', 'common.address'], aliases: 'engine status database sqlite 엔진 상태 버전 주소 데이터베이스' },
  { id: 'capture', group: 'proxy', title: 'capture.section', prefixes: ['capture.'], aliases: 'system capture app process redirector 시스템 캡처 앱 프로세스' },
  { id: 'tls', group: 'proxy', title: 'tls.section', prefixes: ['tls.'], aliases: 'TLS fingerprint cipher Chrome Firefox Safari 지문 암호' },
  { id: 'shortcuts', group: 'shortcuts', title: 'shortcuts.section', prefixes: ['shortcuts.'], aliases: 'keyboard hotkey 키보드 단축키' },
  { id: 'browser', group: 'browser', title: 'browser.section', prefixes: ['browser.'], aliases: 'Chromium cookies profile cache 브라우저 쿠키 프로필 캐시' },
  { id: 'ca', group: 'browser', title: 'settings.caSection', keys: ['settings.caHelp', 'settings.caDownload', 'settings.caMitmit'], aliases: 'certificate trust HTTPS mitm.it PEM CER P12 인증서 신뢰 설치 다운로드' },
  { id: 'browser-help', group: 'browser', title: 'settings.browserSection', keys: ['settings.browserHelp'], aliases: 'manual browser proxy setup 브라우저 수동 프록시 설정' },
  { id: 'appearance', group: 'appearance', title: 'appearance.section', prefixes: ['appearance.'], aliases: 'font theme dark light size source IP 폰트 글꼴 테마 화면 크기 다크 라이트' },
  { id: 'language', group: 'appearance', title: 'settings.languageSection', keys: ['settings.language', 'settings.languageHelp'], aliases: 'language locale English Korean 언어 한국어 영어' },
  { id: 'mcp', group: 'integrations', title: 'mcp.section', prefixes: ['mcp.'], aliases: 'MCP API agent Codex Claude port 토큰 에이전트 연동 포트' },
  { id: 'lockdown', group: 'security', title: 'lockdown.title', prefixes: ['lockdown.'], aliases: 'egress offline scope security outbound 네트워크 보안 외부 연결 범위' },
  { id: 'project', group: 'project', title: 'project.section', prefixes: ['project.'], keys: ['startup.switch'], aliases: 'project import export backup JSON SQLite save 프로젝트 가져오기 내보내기 백업 저장 경로' },
  { id: 'media-storage', group: 'project', title: 'captureStorage.section', prefixes: ['captureStorage.'], aliases: 'media storage body limit image audio video 5MB 미디어 본문 저장 용량 제한 이미지 오디오 비디오' },
  { id: 'compact', group: 'project', title: 'compact.title', prefixes: ['compact.'], aliases: 'compact vacuum disk storage delete database 용량 압축 정리 삭제 디스크 데이터베이스' },
  { id: 'about', group: 'about', title: 'about.section', prefixes: ['about.'], aliases: 'version build commit release 버전 빌드 커밋 정보' },
  { id: 'updates', group: 'about', title: 'updates.section', prefixes: ['updates.'], aliases: 'update upgrade stable nightly automatic 업데이트 자동 릴리스' },
] as const satisfies readonly SectionEntry[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SettingsSectionId = SettingsSection['id'];

const normalise = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const matchesTerm = (text: string, term: string) => /^[a-z0-9]/.test(term)
  ? new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)
  : text.includes(term);
const catalogueKeys = Object.keys(CATALOGUES.en) as TranslationKey[];
const index = SETTINGS_SECTIONS.map((definition) => {
  const section: SectionEntry = definition;
  const keys = [section.title, `settings.group.${section.group}` as TranslationKey,
    ...(section.keys ?? []), ...catalogueKeys.filter((key) => section.prefixes?.some((prefix) => key.startsWith(prefix)))];
  const titles = normalise([CATALOGUES.en[section.title], CATALOGUES.ko[section.title]].join(' '));
  const text = normalise([...keys.flatMap((key) => [CATALOGUES.en[key], CATALOGUES.ko[key]]), section.aliases ?? ''].join(' '));
  return { section: definition, titles, text, compact: text.replace(/\s/g, '') };
});

/** Search translated labels and help without mounting sections or calling APIs. */
export function searchSettings(query: string): SettingsSection[] {
  const terms = normalise(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  return index.filter(({ text, compact }) => terms.every((term) => matchesTerm(text, term)
    || !/^[a-z0-9]/.test(term) && compact.includes(term)))
    .map((entry) => ({ ...entry, score: terms.filter((term) => matchesTerm(entry.titles, term)).length }))
    .sort((a, b) => b.score - a.score)
    .map(({ section }) => section);
}
