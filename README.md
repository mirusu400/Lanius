# Lanius

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
- ⬜ M7 이후: 플러그인 시스템, MCP 연동

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
| WS | `/ws` | 실시간 이벤트 (`flow.*`, `tcp.*`, `intercept.*`, `scope.*`, `intruder.*`, `engine.*`) |

모든 엔드포인트는 기본적으로 `127.0.0.1`에만 바인딩된다.

## 개발

```bash
cd engine
.venv/bin/python -m pytest -q     # 엔진 단위 테스트 (199)
.venv/bin/python -m mypy          # 타입 체크

cd ../ui
npm test                          # UI 테스트 (126, jsdom 렌더 포함)
npx tsc -b                        # 타입 체크
```

## 주의

인가된 대상에 대한 보안 테스트 용도로만 사용할 것. 대상의 동의·권한 확인은 사용자 책임이다.
