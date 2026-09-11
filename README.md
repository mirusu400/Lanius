# Lanius

[![CI](https://github.com/mirusu400/Lanius/actions/workflows/ci.yml/badge.svg)](https://github.com/mirusu400/Lanius/actions/workflows/ci.yml)
[![Nightly](https://github.com/mirusu400/Lanius/actions/workflows/nightly.yml/badge.svg)](https://github.com/mirusu400/Lanius/actions/workflows/nightly.yml)

> 때까치(*Lanius*) — 매복해 먹이를 가로채는 새. 클라이언트와 서버 사이 트래픽을 가로채는 도구.

Lanius는 **mitmproxy를 엔진으로 임베드**하고 그 위에 Burp Suite 유사 워크플로우를 올린 웹 보안 테스트 도구다.
설계 원칙·목표·로드맵은 [`CODEX.MD`](./CODEX.MD)를 참고.

## 현재 상태 — M0 (엔진 부트스트랩) 완료

- ✅ `DumpMaster` 임베드 (TLS MITM·HTTP/1·HTTP/2 자동 처리)
- ✅ 캡처 애드온: flow → SQLite 영속화 (DB 쓰기는 워커 스레드로 오프로드)
- ✅ 이벤트 브로커 + WebSocket 실시간 flow 스트림
- ✅ REST API: 히스토리 조회/필터/상세/초기화
- ✅ 민감 헤더 기본 리댁션 (`Authorization`, `Cookie`, `Set-Cookie`)
- ✅ **M1** React+TS GUI: 실시간 프록시 히스토리 테이블, 필터/검색, 요청·응답 상세 뷰
- ✅ **M2** 인터셉트: 브레이크포인트, 원시 HTTP 편집, Forward / Drop / Forward all
- ✅ **M3** Repeater: 히스토리에서 보내기, 다중 탭 편집·재전송, 응답 뷰
- ✅ **M4** Target: 사이트맵 트리, Scope 편집기(영구 저장·캡처 제한), 엔드포인트 그룹핑
- ✅ **M5** Intruder: § 페이로드 위치, 공격 유형 4종, 실시간 결과 테이블
- ✅ **M6** Decoder(인/디코드 체인) · Comparer(diff) · 원시 TCP 캡처와 헥스 뷰
- ✅ **M7** 플러그인: Python 애드온 로더 + Plugins 탭 + 예시 플러그인 2개
- ✅ **M8** MCP 연동: 에이전트용 툴 13종 (리댁션 기본)
- ✅ Logger(실시간·저장 이벤트) · Settings(엔진 상태, CA 내보내기, 언어 설정)
- ✅ **i18n**: 영어/한국어, Settings에서 즉시 전환·기기에 기억

- ✅ **데스크톱 셸(Tauri)**: 엔진을 사이드카로 자동 기동하는 `Lanius.app`

9개 탭 + 데스크톱 앱까지 완료. 남은 항목은 UI측 JS 플러그인 API다.

## 빠른 시작

```bash
cd engine
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt

python -m app.main                     # 프록시 127.0.0.1:8080, API 127.0.0.1:8081
```

트래픽 흘려보내기:

```bash
curl -x http://127.0.0.1:8080 http://example.com/
curl -x http://127.0.0.1:8080 --cacert ~/.mitmproxy/mitmproxy-ca-cert.pem https://example.com/
curl http://127.0.0.1:8081/api/flows
```

HTTPS를 신뢰하려면 프록시를 설정한 기기에서 <http://mitm.it> 에 접속해 CA를 설치한다.
CA는 최초 실행 시 `~/.mitmproxy`에 자동 생성되며, **절대 커밋하지 않는다.**

### CLI 옵션

| 옵션 | 환경변수 | 기본값 |
|---|---|---|
| `--proxy-host` / `--proxy-port` | `LANIUS_PROXY_HOST` / `LANIUS_PROXY_PORT` | `127.0.0.1:8080` |
| `--api-host` / `--api-port` | `LANIUS_API_HOST` / `LANIUS_API_PORT` | `127.0.0.1:8081` |
| `--db` | `LANIUS_DATA_DIR` | `~/.lanius/lanius.sqlite` |
| `--log-level` | `LANIUS_LOG_LEVEL` | `info` |
| (모드 추가) | `LANIUS_EXTRA_MODES` | 없음 (예: `reverse:tcp://127.0.0.1:19100@19101`) |
| (강제 TCP) | `LANIUS_TCP_HOSTS` | 없음 |
| (플러그인) | `LANIUS_PLUGINS_DIR` | `~/.lanius/plugins` |

비-HTTP 서비스를 바이트 단위로 보려면 reverse 모드를 추가한다:

```bash
LANIUS_EXTRA_MODES='reverse:tcp://127.0.0.1:19100@19101' python -m app.main
# 클라이언트를 127.0.0.1:19101 로 접속시키면 원시 TCP flow로 캡처된다
```

## UI (M1)

```bash
cd ui && npm install && npm run dev     # http://127.0.0.1:5173
```

엔진 주소가 기본값(`http://127.0.0.1:8081`)과 다르면 `VITE_LANIUS_API`로 지정한다.

Proxy 탭 기능: 실시간 flow 테이블(WS 자동 재연결), host/method/status/검색 필터,
일시정지·비우기, 요청/응답 헤더·바디 상세 뷰, 민감 헤더 표시 토글.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/status` | 엔진 상태, flow 개수, 구독자 수 |
| GET | `/api/flows` | 히스토리 목록 (`limit`, `offset`, `host`, `method`, `status_code`, `search`) |
| GET | `/api/flows/{id}` | flow 상세. `?reveal=true`로 리댁션 해제 |
| DELETE | `/api/flows` | 히스토리 초기화 |
| GET | `/api/intercept` | 인터셉트 규칙 + 대기 중 flow 목록 |
| PATCH | `/api/intercept` | 규칙 변경 (`enabled`, `intercept_requests`, `intercept_responses`, `host_filter`) |
| POST | `/api/intercept/{id}/forward` | (선택적 편집 후) 전달 |
| POST | `/api/intercept/{id}/drop` | 요청 폐기 |
| POST | `/api/intercept/forward-all` | 대기 중 전체 전달 |
| POST | `/api/repeater/send` | 요청 전송 (`url`, `method`, `headers`, `body`) |
| GET/PATCH | `/api/scope` | 스코프 조회 / 캡처 제한 토글 |
| POST | `/api/scope/rules`, `/api/scope/from-url` | 규칙 추가 |
| PATCH/DELETE | `/api/scope/rules/{id}` | 규칙 수정 / 삭제 |
| GET | `/api/scope/check?url=` | URL 스코프 판정 |
| GET | `/api/sitemap`, `/api/sitemap/paths` | 사이트 목록 / 사이트별 경로 |
| GET | `/api/endpoints` | 엔드포인트 그룹(경로 템플릿 + 파라미터) |
| POST | `/api/intruder/positions`, `/api/intruder/plan` | 위치 파싱 / 요청 수 예측 |
| POST/GET | `/api/intruder/attacks` | 공격 시작 / 목록 |
| GET/POST | `/api/intruder/attacks/{id}`, `/stop` | 결과 조회 / 중단 |
| GET | `/api/codecs` | 사용 가능한 코덱/해시 목록 |
| POST | `/api/decode` | 인/디코드 체인 실행 |
| POST | `/api/compare` | 두 텍스트 diff (`word` / `byte`) |
| GET | `/api/ca`, `/api/ca/{pem\|cer\|p12}` | CA 정보 / 공개 인증서 내려받기 |
| GET | `/api/events` | 저장된 이벤트 로그 |
| GET | `/api/plugins` | 플러그인 목록 + 디렉터리 |
| POST | `/api/plugins/{name}/enable\|disable\|reload` | 활성 / 비활성 / 리로드 |
| WS | `/ws` | 실시간 이벤트 (`flow.*`, `tcp.*`, `intercept.*`, `scope.*`, `intruder.*`, `engine.*`) |

모든 엔드포인트는 기본적으로 `127.0.0.1`에만 바인딩된다.

## 개발

```bash
cd engine
.venv/bin/python -m pytest -q     # 엔진 단위 테스트 (264)
.venv/bin/python -m mypy          # 타입 체크

cd ../ui
npm test                          # UI 테스트 (181, jsdom 렌더 포함)
npx tsc -b                        # 타입 체크

cd ../shell/src-tauri
cargo test                        # 셸 테스트 (8)
```

## 언어 (i18n)

Settings 탭에서 인터페이스 언어를 바꿀 수 있다(영어·한국어). 선택은 즉시 적용되고
`localStorage`에 저장되며, 저장된 값이 없으면 브라우저 언어를 따른다.

번역 문자열은 `ui/src/i18n/catalogue.ts` 한 곳에 모여 있다. 영어가 기준이고 다른
언어는 그 타입에 맞춰지므로, 키가 빠지거나 오타가 나면 `tsc`가 실패한다.

언어를 추가하려면 `LOCALES`에 코드를 넣고 카탈로그를 하나 더 작성하면 된다.

```bash
cd ui
npm run test:locales    # 전체 테스트를 영어와 한국어로 각각 실행
```

## 내려받기 (나이틀리)

매일 자동 빌드된 프리릴리스를 [Releases](https://github.com/mirusu400/Lanius/releases)에서 받을 수 있다.
macOS는 `.dmg`/`.app.tar.gz`, Linux는 `.AppImage`/`.deb`를 제공한다.

서명하지 않은 빌드이므로 macOS에서는 첫 실행 전에 격리 속성을 해제해야 한다:

```bash
xattr -dr com.apple.quarantine /Applications/Lanius.app
```

## CI

| 워크플로 | 트리거 | 내용 |
|---|---|---|
| `ci.yml` | push(main) · PR | 엔진(mypy+pytest, Linux/macOS), UI(타입·린트·2개 언어 테스트·빌드), 셸(fmt·clippy·test, Linux/macOS) |
| `nightly.yml` | 매일 03:00 UTC · 수동 | CI 통과 후 엔진 동결 → 스모크 테스트 → 데스크톱 번들 → 프리릴리스 발행 |

나이틀리는 최근 24시간 내 커밋이 없으면 건너뛴다. 수동 실행(`workflow_dispatch`)은 항상 빌드하며,
`publish` 입력으로 릴리스 발행 여부를 고를 수 있다.

빌드된 엔진 바이너리는 번들 전에 스모크 테스트를 거친다. 실제로 기동해 `/api/status`를 확인하고,
프록시로 요청을 흘려 히스토리에 기록되는지까지 확인한 뒤에만 패키징한다.

## 데스크톱 앱 빌드

엔진을 단일 실행파일로 굳힌 뒤 `.app`으로 번들한다.

```bash
cd engine && .venv/bin/pyinstaller --clean --noconfirm lanius-engine.spec   # 엔진 바이너리
cd ../shell && npx tauri build --bundles app                                # Lanius.app
```

프론트엔드는 바이너리에 컴파일되어 들어가므로 `beforeBuildCommand`가 `ui`를 항상 먼저
재빌드한다(낡은 UI가 번들되는 것을 방지).

결과물은 `shell/src-tauri/target/release/bundle/macos/Lanius.app` (약 49MB, Python 설치 불필요).
앱을 실행하면 엔진이 사이드카로 자동 기동되고, 창을 닫거나 앱이 강제 종료돼도
엔진이 함께 정리된다. 이미 `python -m app.main`으로 엔진을 띄워 둔 경우 그 인스턴스를 재사용한다.

개발 중에는 셸이 저장소의 가상환경을 그대로 사용한다:

```bash
cd shell && npx tauri dev
```

## MCP (에이전트 연동)

에이전트가 히스토리 조회·스코프 관리·인터셉트·replay를 할 수 있다.

```jsonc
// MCP 클라이언트 설정 예시 (stdio, 읽기 전용)
{
  "mcpServers": {
    "lanius": {
      "command": "/path/to/Lanius/engine/.venv/bin/python",
      "args": ["-m", "app.mcp"],
      "cwd": "/path/to/Lanius/engine"
    }
  }
}
```

엔진이 실행 중이면 `http://127.0.0.1:8081/mcp/mcp` (streamable HTTP)로 붙을 수 있으며,
이 경우 인터셉트·replay 등 쓰기 툴까지 사용할 수 있다.

**툴:** `list_flows`, `get_flow`, `list_sites`, `list_endpoints`, `get_scope`,
`add_scope_rule`, `list_intercepted`, `set_intercept`, `forward_intercepted`,
`drop_intercepted`, `send_request`, `replay_flow`, `decode_value`.

민감 헤더는 기본 리댁션되며, `reveal_secrets=true`를 명시할 때만 실제 값이 나온다.

## 플러그인

플러그인은 mitmproxy 애드온과 동일하다. `~/.lanius/plugins`에 `.py` 파일을 두면
Plugins 탭에서 발견되며, 활성화하면 즉시 실시간 트래픽에 적용된다.
작성법과 예시는 [`plugins/README.md`](./plugins/README.md) 참고.

```bash
cp plugins/*.py ~/.lanius/plugins/    # 예시 플러그인 설치
```

플러그인은 샌드박스가 아니라 엔진 프로세스에서 실행된다. 신뢰할 수 있는 코드만 활성화할 것.

## 주의

인가된 대상에 대한 보안 테스트 용도로만 사용할 것. 대상의 동의·권한 확인은 사용자 책임이다.
