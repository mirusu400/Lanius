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
    id: 'mcp',
    title: 'AI agents (MCP)',
    summary: 'Let a coding agent read your captured traffic and replay requests.',
    sections: [
      {
        heading: 'What this is',
        blocks: [
          {
            kind: 'text',
            body: 'Lanius speaks the Model Context Protocol, so an AI coding agent can work with what you have captured instead of you pasting requests into a chat window. The agent connects to the running engine and gets a set of tools.',
          },
          {
            kind: 'text',
            body: 'Settings shows the endpoint and a configuration you can copy straight into your client. The address carries the port this engine is actually on, so it stays right even after you move the listener.',
          },
        ],
      },
      {
        heading: 'What an agent can do',
        blocks: [
          {
            kind: 'text',
            body: 'Reading: list_flows and get_flow for captured traffic, list_sites and list_endpoints to see the shape of an application, get_scope for the current scope, list_intercepted for requests held at a breakpoint, and decode_value for encoded strings.',
          },
          {
            kind: 'text',
            body: 'Acting: send_request puts a new request through the proxy, replay_flow repeats a captured one with edits, add_scope_rule changes the scope, set_intercept turns interception on and off, and forward_intercepted and drop_intercepted decide what happens to a held request.',
          },
          {
            kind: 'note',
            body: 'Sensitive headers such as Authorization and Cookie are redacted unless the agent asks for them with reveal_secrets.',
          },
        ],
      },
      {
        heading: 'Connecting a client',
        blocks: [
          {
            kind: 'text',
            body: 'Copy the configuration from Settings and paste it into your agent. For a client that speaks HTTP it looks like this:',
          },
          {
            kind: 'code',
            body: '{\n  "mcpServers": {\n    "lanius": {\n      "url": "http://127.0.0.1:8081/mcp/mcp"\n    }\n  }\n}',
          },
          {
            kind: 'text',
            body: 'A client that only speaks stdio can run the server directly against the project database, which works without the desktop app open, though only the reading tools are available that way:',
          },
          {
            kind: 'code',
            body: 'python -m app.mcp',
          },
        ],
      },
      {
        heading: 'Turning it off',
        blocks: [
          {
            kind: 'text',
            body: 'An agent with these tools can send traffic through your proxy, change your scope and release held requests. Untick "Allow agents to connect" in Settings and connections are refused; the rest of Lanius is unaffected.',
          },
          {
            kind: 'note',
            body: 'The endpoint listens on this machine only, like the rest of the API, so it is not reachable from the network even when the proxy itself is.',
          },
        ],
      },
    ],
  },
  {
    id: 'listener',
    title: 'Proxy listener',
    summary:
      'Choose the port, and let other devices reach the proxy.',
    sections: [
      {
        heading: 'Changing the port',
        blocks: [
          {
            kind: 'text',
            body: 'Port 8080 is a popular default, and another tool may already hold it. Open Settings, find Proxy listener, type a free port and apply. The change takes effect immediately and is remembered for next time.',
          },
          {
            kind: 'text',
            body: 'If the port was already taken when Lanius started, the same section says so and the rest of the app keeps working, so you can pick another port without restarting.',
          },
        ],
      },
      {
        heading: 'Letting other devices through',
        blocks: [
          {
            kind: 'text',
            body: 'By default the proxy accepts connections from this machine only, which is why a phone on the same network cannot use it. The bind address changes that:',
          },
          {
            kind: 'text',
            body: 'This machine only (127.0.0.1) is the default. All interfaces (0.0.0.0) is reachable on every network this machine is connected to. A specific address is reachable on that network alone.',
          },
          {
            kind: 'text',
            body: 'Then point the other device at this machine\u2019s address and the port shown. Install the CA certificate there as well, or HTTPS will fail.',
          },
          {
            kind: 'note',
            body: 'Anyone who can reach that address can send traffic through your proxy. On a network you do not control, prefer a specific address over all interfaces.',
          },
        ],
      },
      {
        heading: 'If an address is refused',
        blocks: [
          {
            kind: 'text',
            body: 'A port in use, or an address this machine does not have, is rejected and the proxy stays where it was. You do not lose a working proxy to a typo.',
          },
        ],
      },
    ],
  },
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
            body: 'Selected applications gives you a list. Add a rule and type part of a name, or use Pick a running app to choose from what is running and have its full path filled in.',
          },
          {
            kind: 'text',
            body: 'Each rule matches part of the executable path, so a fragment is enough:',
          },
          {
            kind: 'code',
            body: 'chrome            Google Chrome, and anything else with chrome in its path\n/Applications/    everything installed there\npid:4123          one process',
          },
          {
            kind: 'text',
            body: 'Set a rule to Exclude to leave something out, and untick one to switch it off without deleting it. Rules take effect when you press Apply.',
          },
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
  {
    id: 'project',
    title: 'Projects',
    summary: 'Your work is saved as you go, and can be exported.',
    sections: [
      {
        heading: 'What is saved',
        blocks: [
          {
            kind: 'text',
            body: 'Captured traffic, your scope, and the tabs you have open in Repeater and Decoder are written to the project database as you work. Closing Lanius and opening it again puts you back where you were; there is nothing to remember to save.',
          },
        ],
      },
      {
        heading: 'Export and import',
        blocks: [
          {
            kind: 'text',
            body: 'Settings > Project exports everything as one file. A long capture dwarfs the rest, so there is a second button that leaves it out when you only want to pass on a scope and a set of requests.',
          },
          {
            kind: 'note',
            body: 'Importing replaces what is currently open, so Lanius asks first.',
          },
        ],
      },
      {
        heading: 'Where it lives',
        blocks: [
          {
            kind: 'text',
            body: 'The database sits in ~/.lanius, and Settings shows the exact path. An exported project is plain JSON, so it can be read, diffed and kept in version control.',
          },
        ],
      },
    ],
  },
];

const ko: DocPage[] = [
  {
    id: 'mcp',
    title: 'AI 에이전트 (MCP)',
    summary: '코딩 에이전트가 캡처한 트래픽을 읽고 요청을 다시 보낼 수 있게 합니다.',
    sections: [
      {
        heading: '무엇인가',
        blocks: [
          {
            kind: 'text',
            body: 'Lanius는 Model Context Protocol을 지원합니다. 요청을 채팅창에 복사해 붙여넣는 대신, AI 코딩 에이전트가 캡처한 내용을 직접 다룰 수 있습니다. 에이전트는 실행 중인 엔진에 연결해 도구 모음을 받습니다.',
          },
          {
            kind: 'text',
            body: '설정에 엔드포인트와 클라이언트에 그대로 붙여넣을 수 있는 설정이 있습니다. 주소에는 이 엔진이 실제로 쓰는 포트가 들어가므로, 리스너를 옮겨도 계속 맞습니다.',
          },
        ],
      },
      {
        heading: '에이전트가 할 수 있는 일',
        blocks: [
          {
            kind: 'text',
            body: '읽기: 캡처한 트래픽은 list_flows와 get_flow, 애플리케이션의 구조는 list_sites와 list_endpoints, 현재 스코프는 get_scope, 중단점에 멈춘 요청은 list_intercepted, 인코딩된 문자열은 decode_value로 봅니다.',
          },
          {
            kind: 'text',
            body: '실행: send_request는 새 요청을 프록시로 보내고, replay_flow는 캡처한 요청을 수정해 다시 보냅니다. add_scope_rule은 스코프를 바꾸고, set_intercept는 가로채기를 켜고 끄며, forward_intercepted와 drop_intercepted는 멈춰 둔 요청을 내보내거나 버립니다.',
          },
          {
            kind: 'note',
            body: 'Authorization, Cookie 같은 민감한 헤더는 에이전트가 reveal_secrets로 명시하지 않으면 가려집니다.',
          },
        ],
      },
      {
        heading: '클라이언트 연결',
        blocks: [
          {
            kind: 'text',
            body: '설정에서 구성을 복사해 에이전트에 붙여넣으세요. HTTP를 쓰는 클라이언트라면 이런 모양입니다:',
          },
          {
            kind: 'code',
            body: '{\n  "mcpServers": {\n    "lanius": {\n      "url": "http://127.0.0.1:8081/mcp/mcp"\n    }\n  }\n}',
          },
          {
            kind: 'text',
            body: 'stdio만 지원하는 클라이언트는 프로젝트 데이터베이스를 직접 읽는 서버를 실행할 수 있습니다. 데스크톱 앱이 꺼져 있어도 되지만, 이 방식에서는 읽기 도구만 쓸 수 있습니다:',
          },
          {
            kind: 'code',
            body: 'python -m app.mcp',
          },
        ],
      },
      {
        heading: '끄는 방법',
        blocks: [
          {
            kind: 'text',
            body: '이 도구를 가진 에이전트는 프록시로 트래픽을 보내고, 스코프를 바꾸고, 멈춰 둔 요청을 내보낼 수 있습니다. 설정에서 "에이전트 연결 허용"을 끄면 연결이 거부되며, 나머지 기능에는 영향이 없습니다.',
          },
          {
            kind: 'note',
            body: '엔드포인트는 나머지 API와 마찬가지로 이 컴퓨터에서만 대기합니다. 프록시 자체를 네트워크에 열어도 이쪽은 외부에서 접속할 수 없습니다.',
          },
        ],
      },
    ],
  },
  {
    id: 'listener',
    title: '프록시 리스너',
    summary: '포트를 고르고, 다른 기기에서도 접속할 수 있게 합니다.',
    sections: [
      {
        heading: '포트 바꾸기',
        blocks: [
          {
            kind: 'text',
            body: '8080은 흔한 기본값이라 다른 도구가 이미 쓰고 있을 수 있습니다. 설정에서 프록시 리스너를 찾아 비어 있는 포트를 입력하고 적용하세요. 바로 반영되고 다음 실행에도 유지됩니다.',
          },
          {
            kind: 'text',
            body: '시작할 때 이미 포트가 사용 중이었다면 같은 자리에 그 사실이 표시되고, 나머지 기능은 계속 동작합니다. 재시작 없이 다른 포트를 고르면 됩니다.',
          },
        ],
      },
      {
        heading: '다른 기기에서 접속하기',
        blocks: [
          {
            kind: 'text',
            body: '기본값은 이 컴퓨터에서만 접속을 받습니다. 같은 네트워크의 휴대폰이 쓰지 못하는 이유가 이것입니다. 바인딩 주소를 바꾸면 됩니다:',
          },
          {
            kind: 'text',
            body: '이 컴퓨터만 (127.0.0.1) 이 기본값입니다. 모든 인터페이스 (0.0.0.0) 는 연결된 모든 네트워크에서 접속할 수 있고, 특정 주소는 그 네트워크에서만 접속할 수 있습니다.',
          },
          {
            kind: 'text',
            body: '그 다음 상대 기기의 프록시를 이 컴퓨터의 주소와 표시된 포트로 지정하세요. CA 인증서도 그 기기에 설치해야 HTTPS가 동작합니다.',
          },
          {
            kind: 'note',
            body: '그 주소에 닿을 수 있는 누구나 프록시로 트래픽을 보낼 수 있습니다. 신뢰할 수 없는 네트워크에서는 모든 인터페이스보다 특정 주소를 쓰세요.',
          },
        ],
      },
      {
        heading: '주소가 거부되면',
        blocks: [
          {
            kind: 'text',
            body: '이미 쓰이는 포트나 이 컴퓨터에 없는 주소는 거부되고, 프록시는 원래 자리를 지킵니다. 오타 때문에 잘 돌던 프록시를 잃지 않습니다.',
          },
        ],
      },
    ],
  },
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
            body: '선택한 앱을 고르면 목록이 나옵니다. 규칙을 추가해 이름 일부를 입력하거나, 실행 중인 앱에서 고르기로 선택하면 전체 경로가 채워집니다.',
          },
          {
            kind: 'text',
            body: '각 규칙은 실행 파일 경로의 일부와 일치하므로 조각만 넣어도 됩니다.',
          },
          {
            kind: 'code',
            body: 'chrome            Google Chrome 등 경로에 chrome이 든 것\n/Applications/    그 아래 설치된 모든 앱\npid:4123          특정 프로세스',
          },
          {
            kind: 'text',
            body: '제외로 바꾸면 해당 항목을 빼고, 체크를 해제하면 삭제하지 않고 잠시 끕니다. 적용을 눌러야 반영됩니다.',
          },
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
  {
    id: 'project',
    title: '프로젝트',
    summary: '작업은 자동으로 저장되고, 내보낼 수 있습니다.',
    sections: [
      {
        heading: '무엇이 저장되는가',
        blocks: [
          {
            kind: 'text',
            body: '캡처한 트래픽, 범위, Repeater와 Decoder에 열어 둔 탭이 작업하는 동안 프로젝트 데이터베이스에 기록됩니다. Lanius를 닫았다 열면 하던 곳으로 돌아오며, 따로 저장할 것이 없습니다.',
          },
        ],
      },
      {
        heading: '내보내기와 가져오기',
        blocks: [
          {
            kind: 'text',
            body: 'Settings > Project에서 전체를 한 파일로 내보냅니다. 긴 캡처는 나머지보다 훨씬 크므로, 범위와 요청만 전달하고 싶을 때 쓰는 캡처 제외 버튼도 있습니다.',
          },
          {
            kind: 'note',
            body: '가져오면 현재 열린 내용이 대체되므로 Lanius가 먼저 확인합니다.',
          },
        ],
      },
      {
        heading: '어디에 있는가',
        blocks: [
          {
            kind: 'text',
            body: '데이터베이스는 ~/.lanius에 있고 정확한 경로는 Settings에 표시됩니다. 내보낸 프로젝트는 평범한 JSON이므로 열어 보고 비교하고 버전 관리에 넣을 수 있습니다.',
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
