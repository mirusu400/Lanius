/** In-app documentation.
 *
 * Kept as data rather than markup so the Docs tab stays a renderer, and
 * out of the translation catalogue because these are paragraphs, not UI
 * labels: mixing them in would make the catalogue unreadable and every
 * edit a two-locale chore.
 */

import type { Locale } from '../i18n';

export interface DocBlock {
  kind: 'text' | 'code' | 'note';
  body: string;
}

export interface DocSection {
  heading: string;
  blocks: DocBlock[];
}

export interface DocPage {
  id: string;
  title: string;
  summary: string;
  sections: DocSection[];
}

const en: DocPage[] = [
  {
    id: 'capture',
    title: 'System capture',
    summary:
      'Intercept applications that ignore proxy settings, without configuring them.',
    sections: [
      {
        heading: 'What it does',
        blocks: [
          {
            kind: 'text',
            body: 'Most tools only see traffic from clients you have pointed at the proxy. Some applications never look at the system proxy setting, so they stay invisible. System capture takes the traffic at the operating system level instead, so an application does not need to cooperate, or even know.',
          },
        ],
      },
      {
        heading: 'Turning it on',
        blocks: [
          {
            kind: 'text',
            body: 'Open Settings, find System capture, and choose what to capture:',
          },
          {
            kind: 'text',
            body: 'Off. Only clients configured to use the proxy.\nEvery application. Everything leaving this machine.\nSelected applications. Only the processes you name.',
          },
          {
            kind: 'text',
            body: 'Names are process names or PIDs, comma separated. Prefix one with ! to exclude it instead:',
          },
          { kind: 'code', body: 'curl, firefox\n!Slack\npid:4123' },
        ],
      },
      {
        heading: 'Approving it on macOS',
        blocks: [
          {
            kind: 'text',
            body: 'The first time you switch it on, macOS installs a network extension and asks you to approve it. Until you do, nothing is captured. Lanius shows a banner while it is waiting.',
          },
          {
            kind: 'text',
            body: 'Open System Settings > General > Login Items & Extensions > Network Extensions, and enable Mitmproxy Redirector.',
          },
          {
            kind: 'note',
            body: 'On Windows the helper needs administrator rights instead. On Linux it needs sudo and a kernel of 6.8 or newer.',
          },
        ],
      },
      {
        heading: 'Changing it later',
        blocks: [
          {
            kind: 'text',
            body: 'The system redirector cannot be reconfigured while it is running. Switching capture on works immediately, but changing which applications are captured, or turning it off again, takes effect the next time Lanius starts. Lanius tells you when that is the case rather than pretending the change applied.',
          },
        ],
      },
      {
        heading: 'What it will not capture',
        blocks: [
          {
            kind: 'text',
            body: 'Applications that pin their certificates refuse the connection rather than being intercepted. That is what pinning is for, and no amount of redirection changes it. Capture is also outbound only; for inbound connections use reverse proxy mode.',
          },
        ],
      },
    ],
  },
  {
    id: 'tls',
    title: 'TLS fingerprint',
    summary: 'Make the handshake towards the server look like a browser.',
    sections: [
      {
        heading: 'Why it matters',
        blocks: [
          {
            kind: 'text',
            body: 'Lanius terminates TLS and opens its own connection to the server, so the handshake the server sees belongs to the proxy, not to your client. Servers fingerprint that handshake, and a proxy-shaped one is easy to spot and block.',
          },
        ],
      },
      {
        heading: 'Choosing a profile',
        blocks: [
          {
            kind: 'text',
            body: 'Settings > TLS fingerprint offers Chrome, Firefox and Safari, which reorder the cipher list to match those browsers, plus Force TLS 1.2 for servers that behave differently on the older version. You can also supply your own OpenSSL cipher string.',
          },
          { kind: 'code', body: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384' },
          {
            kind: 'text',
            body: 'An unusable cipher list is refused rather than stored, because it would turn every request into a 502 with no obvious cause.',
          },
        ],
      },
      {
        heading: 'How far it goes',
        blocks: [
          {
            kind: 'note',
            body: 'This shapes the cipher list and TLS version only. A full JA3 or JA4 match would also need extension ordering and GREASE, which the underlying TLS library does not expose, so a determined fingerprinter can still tell the difference.',
          },
        ],
      },
    ],
  },
  {
    id: 'decoder',
    title: 'Decoder',
    summary: 'Chain transforms across several payloads at once.',
    sections: [
      {
        heading: 'Tabs',
        blocks: [
          {
            kind: 'text',
            body: 'Each tab holds its own payload and its own chain, so you can keep several tokens side by side instead of losing one to look at the next. A tab is labelled by its payload until you give it a name.',
          },
        ],
      },
      {
        heading: 'Chains',
        blocks: [
          {
            kind: 'text',
            body: 'Add steps to transform the input in order, each one feeding the next. A step is a codec and a direction, so base64 decode followed by gzip decode is two steps. Every step shows its own output, so you can see where a chain goes wrong.',
          },
        ],
      },
      {
        heading: 'Reading the result',
        blocks: [
          {
            kind: 'text',
            body: 'The result pane shows the final value as text, or as a hex dump when you need the bytes. Decoding often lands on binary; when it does, the pane says so rather than filling with unreadable characters.',
          },
        ],
      },
    ],
  },
];

const ko: DocPage[] = [
  {
    id: 'capture',
    title: '시스템 캡처',
    summary: '프록시 설정을 무시하는 앱도 별도 설정 없이 가로챕니다.',
    sections: [
      {
        heading: '무엇을 하는가',
        blocks: [
          {
            kind: 'text',
            body: '보통은 프록시를 바라보도록 설정한 클라이언트의 트래픽만 볼 수 있습니다. 일부 앱은 시스템 프록시 설정을 아예 읽지 않아서 보이지 않습니다. 시스템 캡처는 운영체제 수준에서 트래픽을 가져오므로, 앱이 협조하지 않아도, 심지어 알지 못해도 캡처됩니다.',
          },
        ],
      },
      {
        heading: '켜는 방법',
        blocks: [
          { kind: 'text', body: 'Settings 탭에서 System capture를 찾아 선택하세요.' },
          {
            kind: 'text',
            body: '끄기. 프록시로 설정된 클라이언트만 봅니다.\n모든 앱. 이 기기에서 나가는 모든 트래픽을 봅니다.\n선택한 앱. 지정한 프로세스만 봅니다.',
          },
          {
            kind: 'text',
            body: '이름은 프로세스 이름이나 PID이며 쉼표로 구분합니다. 앞에 !를 붙이면 제외됩니다.',
          },
          { kind: 'code', body: 'curl, firefox\n!Slack\npid:4123' },
        ],
      },
      {
        heading: 'macOS 승인',
        blocks: [
          {
            kind: 'text',
            body: '처음 켜면 macOS가 네트워크 확장을 설치하고 승인을 요구합니다. 승인 전에는 아무것도 캡처되지 않으며, 대기 중에는 Lanius가 안내 배너를 띄웁니다.',
          },
          {
            kind: 'text',
            body: '시스템 설정 > 일반 > 로그인 항목 및 확장 프로그램 > 네트워크 확장에서 Mitmproxy Redirector를 켜세요.',
          },
          {
            kind: 'note',
            body: 'Windows에서는 대신 관리자 권한이 필요하고, Linux에서는 sudo와 커널 6.8 이상이 필요합니다.',
          },
        ],
      },
      {
        heading: '나중에 바꿀 때',
        blocks: [
          {
            kind: 'text',
            body: '시스템 리다이렉터는 실행 중에 다시 설정할 수 없습니다. 켜는 것은 즉시 적용되지만, 캡처 대상을 바꾸거나 다시 끄는 것은 Lanius를 재시작해야 반영됩니다. 이 경우 Lanius가 적용된 척하지 않고 재시작이 필요하다고 알려줍니다.',
          },
        ],
      },
      {
        heading: '캡처되지 않는 것',
        blocks: [
          {
            kind: 'text',
            body: '인증서 피닝을 쓰는 앱은 가로채기 대신 연결을 거부합니다. 피닝의 목적이 그것이며 리다이렉션으로는 해결할 수 없습니다. 또한 캡처는 나가는 연결만 대상으로 하므로, 들어오는 연결은 리버스 프록시 모드를 쓰세요.',
          },
        ],
      },
    ],
  },
  {
    id: 'tls',
    title: 'TLS 지문',
    summary: '서버로 가는 핸드셰이크를 브라우저처럼 보이게 합니다.',
    sections: [
      {
        heading: '왜 필요한가',
        blocks: [
          {
            kind: 'text',
            body: 'Lanius는 TLS를 종단하고 서버에 자신의 연결을 새로 엽니다. 따라서 서버가 보는 핸드셰이크는 클라이언트가 아니라 프록시의 것입니다. 서버는 이 핸드셰이크로 지문을 만들고, 프록시 모양의 지문은 쉽게 탐지되어 차단됩니다.',
          },
        ],
      },
      {
        heading: '프로필 선택',
        blocks: [
          {
            kind: 'text',
            body: 'Settings > TLS fingerprint에서 Chrome, Firefox, Safari를 고르면 해당 브라우저에 맞게 cipher 순서가 바뀝니다. 구버전에서 다르게 동작하는 서버를 위해 TLS 1.2 강제도 있습니다. 직접 OpenSSL cipher 문자열을 넣을 수도 있습니다.',
          },
          { kind: 'code', body: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384' },
          {
            kind: 'text',
            body: '사용할 수 없는 cipher 목록은 저장되지 않고 거부됩니다. 저장되면 모든 요청이 원인 모를 502가 되기 때문입니다.',
          },
        ],
      },
      {
        heading: '한계',
        blocks: [
          {
            kind: 'note',
            body: 'cipher 목록과 TLS 버전만 바꿉니다. 완전한 JA3/JA4 일치에는 확장 순서와 GREASE가 필요한데 기반 TLS 라이브러리가 이를 제공하지 않으므로, 작정한 지문 분석은 여전히 구별할 수 있습니다.',
          },
        ],
      },
    ],
  },
  {
    id: 'decoder',
    title: '디코더',
    summary: '여러 데이터를 동시에 두고 변환을 이어 붙입니다.',
    sections: [
      {
        heading: '탭',
        blocks: [
          {
            kind: 'text',
            body: '탭마다 자기 데이터와 자기 체인을 갖습니다. 다음 것을 보려고 이전 것을 잃지 않고 여러 토큰을 나란히 둘 수 있습니다. 이름을 지정하기 전까지는 입력값이 탭 이름이 됩니다.',
          },
        ],
      },
      {
        heading: '체인',
        blocks: [
          {
            kind: 'text',
            body: '단계를 추가하면 순서대로 변환되며 각 단계의 결과가 다음 단계로 들어갑니다. 한 단계는 코덱과 방향으로 이루어지므로 base64 디코드 후 gzip 디코드는 두 단계입니다. 단계마다 결과를 보여주므로 어디서 어긋났는지 알 수 있습니다.',
          },
        ],
      },
      {
        heading: '결과 보기',
        blocks: [
          {
            kind: 'text',
            body: '결과 창은 최종 값을 텍스트로 보여주고, 바이트가 필요하면 Hex로 전환할 수 있습니다. 디코딩 결과가 바이너리인 경우가 많은데, 그럴 때는 읽을 수 없는 문자로 채우는 대신 그렇다고 알려줍니다.',
          },
        ],
      },
    ],
  },
];

const PAGES: Record<Locale, DocPage[]> = { en, ko };

export function docPages(locale: Locale): DocPage[] {
  return PAGES[locale] ?? PAGES.en;
}
