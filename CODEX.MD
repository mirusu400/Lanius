# Lanius — codex.md

> **프로젝트명:** Lanius (라니우스) — 때까치의 학명 속명(genus *Lanius*). 때까치("butcher bird")는 먹이를 매복해 낚아채 가시에 꽂아두는 포식성 새다.
> 클라이언트와 서버 사이에서 트래픽을 가로채(intercept) 붙잡아 두는 이 도구의 성격을 담은 이름이다.
>
> 코딩 에이전트(및 기여자)를 위한 프로젝트 지침 문서.
> 작업을 시작하기 전에 이 문서를 먼저 읽고, 여기 정의된 **목표 / 비목표 / 규약**을 따를 것.

---

## 1. 프로젝트 개요

**한 줄 정의:** Lanius는 mitmproxy를 프록시 엔진으로 임베드하고, 그 위에 Burp Suite와 유사한 데스크톱 GUI를 올린 웹 보안 테스트 도구다.

**핵심 원칙**

1. **엔진은 재발명하지 않는다.** TLS 인터셉션, 즉석 인증서 발급, HTTP/1·HTTP/2·WebSocket 파싱, 원시 TCP 중계는 mitmproxy가 이미 검증한 기능이므로 그대로 임베드해 사용한다.
2. **우리가 소유하는 것은 "앱 셸"이다.** GUI, 워크플로우(엔드포인트 관리·스코프·Repeater·Intruder), 데이터 모델 확장, 자체 플러그인 시스템이 우리의 부가가치다.
3. **HTTP 우선(HTTP-first).** 도구는 웹 애플리케이션 펜테스트에 최적화한다. 원시 TCP는 바이트 레벨로 지원하되, 구조화는 필요할 때 플러그인으로 얹는다.
4. **점진적으로 만든다.** 프록시 히스토리 → 인터셉트 → Repeater → Target/Scope → Intruder 순으로 세로 슬라이스를 완성해 나간다.

---

## 2. 목표 / 비목표 (반드시 준수)

### 목표 (Goals)

- Burp과 유사한 탭 기반 데스크톱 GUI (Proxy / Target / Repeater / Intruder / Decoder / Comparer / Logger / Plugins / Settings).
- mitmproxy를 **라이브러리로 임베드**(`DumpMaster`)하여 프록시 엔진으로 사용.
- HTTP/HTTPS 트래픽 인터셉트 및 실시간 수정(브레이크포인트).
- 프록시 히스토리 저장·검색·필터.
- **엔드포인트 기반 관리** (호스트+경로 패턴으로 플로우를 그룹핑, path/query 파라미터 식별).
- **Scope** (include/exclude 규칙을 영구 저장, 캡처/표시/도구 동작을 스코프로 제한).
- **Repeater** (요청 편집 후 재전송, 응답 비교).
- **Intruder** (페이로드 위치 지정 + 워드리스트 기반 퍼징).
- Decoder / Comparer 유틸리티.
- **자체 플러그인 시스템** (엔진 측 Python 애드온 + UI 측 JS 플러그인). -> 가능하다면 Burp Suite의 Extension (BApp) 호환이 가능하도록 한다.
- **MCP 연동** (에이전트가 히스토리 조회·인터셉트·리플레이 가능).
- **원시 TCP 인터셉트** (바이트 레벨 읽기/수정).
- CA 인증서 관리 UI (내보내기 및 `mitm.it` 설치 안내).

### 비목표 (Non-Goals) — 착수 금지 항목

- ❌ **프록시를 바닥부터 재구현.** mitmproxy로 충분하다.
- ❌ **Burp Scanner / Collaborator 급 자동 취약점 스캐너의 초기 재현.** 필요 시 후속 마일스톤에서 별도 검토(예: Nuclei 연동).
- ❌ mitmproxy가 파싱하지 못하는 임의 바이너리 프로토콜의 완전 구조화 뷰(초기 범위 밖. 원시 바이트 레벨까지만 지원).

> 위 비목표를 바꾸려면 이 문서를 먼저 갱신하고 결정 근거를 `## 12. 결정 로그`에 남길 것.

---

## 3. 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│  GUI Shell  (Tauri 또는 Electron)                            │
│  └─ Frontend: React + TypeScript                             │
│     탭: Proxy / Target / Repeater / Intruder / Decoder ...   │
│     UI 플러그인 로더 (JS)                                     │
└───────────────▲─────────────────────────────────────────────┘
                │  로컬 WebSocket (실시간 flow 스트림)
                │  로컬 REST/RPC (액션: 인터셉트 resume, replay 등)
┌───────────────┴─────────────────────────────────────────────┐
│  Backend Service  (Python, FastAPI + asyncio)                │
│  ├─ mitmproxy 엔진 (DumpMaster 임베드)                        │
│  │   └─ 커스텀 애드온: capture / scope / endpoint / intruder  │
│  ├─ 이벤트 브로커 (asyncio 큐 → WS 브로드캐스트)             │
│  ├─ 영속화: SQLite (flows / endpoints / scope / projects)    │
│  └─ MCP 서버 (기존 mitmproxy-MCP 포크 기반)                  │
└──────────────────────────────────────────────────────────────┘
```

**데이터 흐름**

1. 클라이언트 트래픽 → mitmproxy 엔진 → 애드온의 `request`/`response`/`tcp_message` 훅에서 `Flow` 객체 가로채기.
2. 애드온이 flow를 SQLite에 기록하고, 이벤트를 asyncio 큐에 push.
3. 백엔드가 큐를 소비해 WebSocket으로 프론트에 실시간 push.
4. 프론트의 액션(인터셉트 resume, 요청 수정 후 replay 등)은 REST/RPC로 백엔드에 전달 → 애드온이 엔진에 반영.
5. MCP 서버는 동일한 애드온 상태/DB를 노출.

---

## 4. 기술 스택 & 근거

| 레이어 | 선택 | 근거 |
|---|---|---|
| 프록시 엔진 | **mitmproxy** (Python, MIT) | 검증된 TLS MITM·즉석 인증서·HTTP2/WS·원시 TCP. 애드온이 곧 플러그인 시스템. |
| 엔진 임베드 | **`DumpMaster`** | mitmproxy를 앱 내부 엔진으로 구동, 런타임에 애드온 추가/제거 가능. |
| 백엔드 | **FastAPI + asyncio** | mitmproxy가 asyncio 기반이라 동일 루프에 자연스럽게 통합. WS/REST 제공 용이. |
| 영속화 | **SQLite** | 단일 파일, 프로젝트 단위 저장에 적합. 초기 의존성 최소. |
| GUI 셸 | **Tauri**(권장) 또는 Electron | Tauri = 작은 바이너리·낮은 메모리. Electron = 러닝커브 낮음. Python 백엔드는 **사이드카 프로세스**로 번들. |
| 프론트 | **React + TypeScript** | 탭/테이블/에디터 UI 생태계 성숙. Monaco 에디터로 요청 편집. |
| 플러그인 | 엔진측 **Python 애드온** + UI측 **JS 플러그인** | Caido 방식. BApp 호환 대신 자체 API로 필요한 것만 포팅. |
| MCP | **자체 MCP 서버**(`mcp` SDK) | 우리 스토어/애드온을 직접 감싸 Lanius 고유 기능(스코프·인터셉트·Intruder)까지 노출. |

> **엔진 언어 트레이드오프 메모:** mitmproxy는 Python이라 런타임을 함께 배포해야 한다(사이드카). 단일 바이너리·최고 성능이 하드 요구가 되면 그때 Rust/Go 프록시 엔진으로의 교체를 별도 검토(참고: Caido가 Rust를 택한 이유). 현재 결정은 mitmproxy 유지.

---

## 5. 엔진 노트 (검증된 사실 · 제약)

작업 시 아래 사실을 전제로 한다.

- **임베드:** mitmproxy는 `libmproxy` 위에 지어져 있고, `DumpMaster`를 생성해 코드에서 직접 구동할 수 있다. 애드온은 샌드박스 플러그인이 아니라 프로세스에 로드되는 파이썬 객체로, mitmproxy 내부 + 파이썬 생태계 전체에 접근한다. (mitmproxy 자체 기능 상당수도 내장 애드온으로 구현됨.)
- **애드온 이벤트 훅:** `request`, `response`, `tcp_start`/`tcp_message`/`tcp_end`/`tcp_error` 등. 훅에서 `Flow` 객체를 수정하면 트래픽이 실시간으로 바뀐다.
- **인증서(직접 만들지 않는다):** 첫 실행 시 `~/.mitmproxy`에 고유 CA가 생성되고, 방문 사이트마다 리프 인증서가 즉석 발급된다. 사용자는 CA를 신뢰 저장소에 한 번만 설치하면 되며, 프록시 설정 기기에서 `mitm.it` 접속 시 플랫폼별 설치 앱이 제공된다. → **TLS/인증서 배관은 우리가 구현하지 않는다.**
- **원시 TCP:** mitmproxy는 연결 첫 바이트로 프로토콜을 추정(예: `\x16\x03\x01` → TLS)한다. 이해 못 하는 트래픽은 raw TCP 레이어로 바이트를 그대로 중계하며(이때도 TLS MITM 수행), `--tcp`로 특정 호스트에 강제할 수 있다. **비-HTTP는 바이트 레벨까지만** 제공되고, 구조화가 필요하면 파서(디섹터)를 플러그인으로 얹는다.
- **동시성 제약:** 애드온은 mitmproxy의 **단일 asyncio 이벤트 루프**에서 실행된다. CPU 집약 작업(대규모 Intruder/스캐닝)은 루프를 막지 않도록 **워커 스레드/프로세스**로 오프로드할 것.

---

## 6. 저장소 구조 (초안)

```
/
├── codex.md                  # 이 문서
├── README.md
├── engine/                   # Python: mitmproxy 임베드 + 애드온 + 백엔드
│   ├── app/
│   │   ├── main.py           # FastAPI + DumpMaster 부트스트랩
│   │   ├── proxy.py          # DumpMaster 구성/기동
│   │   ├── addons/
│   │   │   ├── capture.py     # flow → SQLite + 이벤트 push
│   │   │   ├── scope.py       # include/exclude 규칙 적용
│   │   │   ├── endpoints.py   # 엔드포인트 그룹핑/파라미터 식별
│   │   │   ├── intercept.py   # 브레이크포인트 제어
│   │   │   └── intruder.py    # 퍼징 엔진(워커로 오프로드)
│   │   ├── api/              # REST/RPC 라우트
│   │   ├── ws/               # WebSocket 브로드캐스트
│   │   ├── db/               # SQLite 스키마·마이그레이션·쿼리
│   │   └── mcp/              # MCP 서버(포크 통합)
│   └── tests/
├── ui/                       # 프론트엔드 (React + TS)
│   ├── src/
│   │   ├── tabs/             # Proxy / Target / Repeater / Intruder ...
│   │   ├── components/
│   │   ├── plugins/          # UI 플러그인 로더/런타임
│   │   └── api/              # 백엔드 클라이언트(WS/REST)
│   └── tests/
├── shell/                    # Tauri(또는 Electron) 셸, 사이드카 번들 설정
└── plugins/                  # 1st-party 예시 플러그인
```

---

## 7. 마일스톤 (로드맵)

각 마일스톤은 "실제로 동작하는 세로 슬라이스"를 목표로 한다.

- **M0 — 엔진 부트스트랩 ✅ 완료:** `DumpMaster` 임베드, HTTP flow 캡처 → SQLite 기록, 이벤트 브로커 + WS 스트림, REST 히스토리 API, 헤더 리댁션. (GUI 없음, CLI/curl 검증 완료)
- **M1 — 라이브 히스토리 ✅ 완료:** 백엔드 WS 스트림 + React/TS GUI + 프록시 히스토리 테이블(실시간). 요청/응답 상세 뷰, 필터/검색. (Tauri 셸 번들은 M2 이후)
- **M2 — 인터셉트 ✅ 완료:** 브레이크포인트 on/off(요청·응답·host 필터), 원시 HTTP 텍스트 편집 후 Forward/Drop/Forward all.
- **M3 — Repeater ✅ 완료:** 히스토리에서 'Send to Repeater' → 다중 탭 편집·재전송, 응답 확인. (응답 diff는 후속)
- **M4 — Target/Scope/엔드포인트 ✅ 완료:** 사이트맵 트리, Scope include/exclude 영구 규칙(+캡처 제한), 엔드포인트 그룹핑·파라미터 식별.
- **M5 — Intruder ✅ 완료:** 페이로드 위치(§) 지정 + 워드리스트 퍼징 4종(sniper/battering ram/pitchfork/cluster bomb), 결과 테이블 + 길이 이상치 하이라이트.
- **M6 — 유틸 & 원시 TCP ✅ 완료:** Decoder(체인)/Comparer(단어·바이트 diff), 원시 TCP 캡처 + 헥스 덤프 뷰.
- **M7 — 플러그인 시스템 ✅ (엔진측 완료):** Python 애드온 로더(발견·활성/비활성·리로드·영구 상태) + 예시 플러그인 2개 + Plugins 탭. UI측 JS 플러그인 API는 후속.
- **M8 — MCP 연동 ✅ 완료:** 자체 MCP 서버(13개 툴) — 히스토리·사이트맵·엔드포인트 조회, 스코프 관리, 인터셉트 제어·포워드·드롭, replay/send, 디코딩. 시크릿 기본 리댁션.

> DoD(완료 정의): 각 마일스톤은 문서화 + 테스트 + GUI에서 수동 검증 가능해야 한다.

---

## 8. 기능 명세 요약 (탭별)

- **Proxy:** 인터셉트 토글, 히스토리(필터/검색), 요청·응답 상세, "Send to Repeater/Intruder".
- **Target:** 사이트맵 트리, 엔드포인트 뷰(그룹핑+파라미터), Scope 편집기(include/exclude).
- **Repeater:** 다중 탭 요청 에디터(Monaco), 재전송, 응답 diff.
- **Intruder:** 페이로드 위치 마킹, 워드리스트/페이로드 세트, 공격 실행·결과 표(상태코드·길이·시간).
- **Decoder:** URL/Base64/hex/HTML 등 인/디코드 체인.
- **Comparer:** 두 요청/응답 바이트·단어 단위 비교.
- **Logger:** 전체 이벤트 로그.
- **Plugins:** 설치/활성/비활성, 플러그인 제공 탭 마운트.
- **Settings:** CA 내보내기 및 `mitm.it` 안내, 프록시 포트/모드, 프로젝트 관리.

---

## 9. 개발 규약 (에이전트 준수사항)

- **작업 단위:** 현재 마일스톤 범위 안에서만 작업한다. 범위를 벗어나면 먼저 이 문서에 제안을 추가한다.
- **엔진 우회 금지:** HTTP/TLS/인증서/커넥션 처리를 직접 구현하지 말 것. 반드시 mitmproxy 훅/API를 경유한다.
- **동시성:** 이벤트 루프를 블로킹하지 말 것. CPU/블로킹 I/O는 `run_in_executor` 또는 별도 프로세스로.
- **타입:** Python은 타입힌트 + `mypy`, 프론트는 엄격 TypeScript.
- **테스트:** 애드온 로직·DB 쿼리·API에 단위 테스트 필수. flow 처리·스코프 매칭은 회귀 테스트 포함.
- **커밋:** Conventional Commits (`feat:`, `fix:`, `refactor:` ...). 작은 단위로.
- **문서:** 사용자에게 보이는 동작이 바뀌면 해당 섹션과 README를 함께 갱신.

---

## 10. 보안 · 취급 주의

- **CA 개인키는 절대 커밋 금지.** `~/.mitmproxy/*` 및 생성 인증서는 `.gitignore`.
- **시크릿 리댁션:** MCP/로그/외부로 나가는 출력에서 `Authorization`, `Cookie`, `Set-Cookie`, API 키, JWT 등 민감 헤더는 기본 리댁션. 실제 값 노출은 명시적 옵트인일 때만.
- **로컬 바인딩:** 백엔드 WS/REST/MCP는 기본 `127.0.0.1`에만 바인딩.
- **합법적 사용 전제:** 본 도구는 **인가된 대상**에 대한 보안 테스트 용도로만 사용한다. 대상 동의/권한 확인은 사용자 책임.

---

## 11. 빌드 & 실행 (목표 커맨드 — 구현되며 채워짐)

```bash
# 엔진(백엔드)
cd engine && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt          # mitmproxy, fastapi, uvicorn ...
python -m app.main                        # 프록시 + WS/REST 기동

# 프론트
cd ui && npm install && npm run dev

# 데스크톱 셸(사이드카로 엔진 번들)
cd shell && npm run tauri dev
```

---

## 12. 결정 로그

| 날짜 | 결정 | 근거 |
|---|---|---|
| 초기 | 엔진 = mitmproxy 임베드 | 프록시 재발명 회피, 인증서·TLS 무료 확보 |
| 초기 | BApp/Montoya 비호환 | JVM+전체 API+Scanner/Collaborator 재현 비용 과다 |
| 초기 | 자체 플러그인(Python 애드온 + JS UI) | 필요한 익스텐션만 포팅하는 실용 노선 |
| 초기 | 프로젝트명 = **Lanius** | 때까치속(학명)—"매복해 가로채는 포식자" 의미 유지. 후보였던 "Shrike"는 동명 보안업체(Shrike Security)와 정면 충돌해 회피 |
| M0 | Python 3.12 고정 | mitmproxy 11 휠이 3.14를 아직 지원하지 않음. 사이드카 번들 시에도 3.12 런타임 사용 |
| M0 | uvicorn 단일 프로세스에 mitmproxy 공존 | `DumpMaster.run()`을 FastAPI lifespan에서 asyncio 태스크로 기동 → 동일 루프 공유, IPC 불필요 |
| M0 | DB 쓰기는 `asyncio.to_thread` 오프로드 | 애드온 훅이 이벤트 루프를 블로킹하지 않도록(§5 동시성 제약). 브로커 publish는 논블로킹 |
| M0 | 브로커 큐는 바운디드 + 최신 우선 | 느린 WS 구독자가 엔진을 스톨시키지 않도록 가장 오래된 이벤트를 드롭 |
| M1 | 초기 GUI는 브라우저(Vite dev server) | 셸(Tauri) 선택 전에도 UI 반복 개발 가능. 셸은 이 정적 번들을 그대로 로드하면 됨 |
| M1 | 엔진에 localhost 전용 CORS 허용 | UI dev server(5173)와 엔진(8081) 포트가 달라 필요. `127.0.0.1`/`localhost` origin만 허용 |
| M1 | UI 로직은 순수 함수로 분리(`proxyModel.ts`) | 머지/필터/포맷을 DOM 없이 단위 테스트. 컴포넌트는 jsdom + RTL로 검증 |
| M2 | mitmproxy `flow.intercept()/resume()` 사용 | 커넥션 보류 로직을 직접 만들지 않음(§9 엔진 우회 금지) |
| M2 | Drop은 `resume()` → `kill()` 순서 | `kill()`이 resume 이벤트를 발생시키지 않고 `intercepted`만 해제해, 순서가 반대면 클라이언트가 영구 대기(실측 후 회귀 테스트 추가) |
| M2 | mitmproxy `errorcheck` 애드온 제거 + 포트 사전 점검 | 기본 동작이 `sys.exit(1)`이라 호스트 앱까지 종료됨. 바인드 실패를 `ProxyStartError`로 변환 |
| M2 | 인터셉트 편집은 원시 HTTP 텍스트 | Burp와 동일한 사용 감각. 파싱/직렬화는 `interceptModel.ts`에서 순수 함수로 테스트 |
| M3 | Repeater는 mitmproxy `ReplayHandler` 재사용 | 자체 HTTP 클라이언트를 쓰지 않아 TLS·HTTP/2·upstream 모드·애드온 훅이 프록시 트래픽과 동일하게 동작 |
| M3 | Repeater 전송도 히스토리에 기록(`source='repeater'`) | 프록시 트래픽과 구분하면서 동일한 조회 경로 재사용 |
| M3 | 에디터의 헤더가 URL보다 우선 | 명시적 `Host` 스푸핑 등 펜테스트에 필요한 동작 |
| M4 | 스코프 규칙은 SQLite에 영구 저장(스키마 v2) + 메모리 스냅샷 | 프로젝트 재시작 후에도 유지되면서, 애드온은 DB를 건드리지 않아 이벤트 루프를 막지 않음 |
| M4 | include 규칙이 없으면 전부 스코프 | 새 프로젝트에서도 트래픽이 기록되도록(Burp 동작과 동일) |
| M4 | 스코프 캡처 제한은 기본 off, 옵트인 | 기본값이 on이면 초기 사용자가 아무것도 못 보게 됨 |
| M4 | 사이트의 in_scope는 "기록된 경로 중 하나라도 매칭" | `/users/*` 같은 규칙에서도 호스트가 타깃으로 표시되어야 함(실측으로 발견) |
| M4 | 경로 파라미터는 휴리스틱 분류(id/uuid/date/hash/token) | 숫자·UUID 등 동적 세그먼트를 `{id}`로 묶어 실제 API 표면을 노출 |
| M5 | Intruder 공격 유형 4종 모두 구현 | 열린 질문(§13) 해소: sniper/battering ram/pitchfork/cluster bomb. Burp 무료판보다 넓은 범위 |
| M5 | 요청 생성은 `asyncio.to_thread`, 전송은 Repeater 경로 | 템플릿 치환(CPU)이 루프를 막지 않고, 전송은 검증된 엔진 경로를 재사용 |
| M5 | 동시 요청 수 5로 제한(세마포어) + 최대 10만 요청 가드 | 대상 서버와 로컬 리소스를 보호. 오폭 방지 |
| M5 | 길이 이상치 자동 하이라이트 | 브루트포스 결과에서 "성공" 응답을 눈으로 찾지 않아도 됨 |
| M6 | 코덱/비교 로직은 엔진(Python)에 배치 | UI와 플러그인이 같은 구현을 공유. JWT·gzip 등은 파이썬 표준 라이브러리로 충분 |
| M6 | `base64.b64decode(validate=True)` 사용 | 느슨한 디코딩은 `"!!!"`를 빈 바이트로 통과시켜 gzip이 "성공"해 버림(실측으로 발견) |
| M6 | 원시 TCP는 별도 mode로 노출(`LANIUS_EXTRA_MODES`) | 비-HTTP 클라이언트는 HTTP 프록시를 쓰지 않으므로 reverse 모드가 필요. `tcp_hosts`도 지원 |
| M6 | TCP flow는 같은 `flows` 테이블에 `type='tcp'` | 히스토리·스코프·검색을 그대로 재사용. 방향별 바이트는 request/response 바디에 저장 |
| M7 | 플러그인 = mitmproxy 애드온 객체(`Plugin` 클래스 또는 `addons` 리스트) | 별도 API를 발명하지 않고 mitmproxy 훅 전체를 그대로 노출 |
| M7 | 로드시 애드온 이름을 플러그인 이름으로 덮어씀 | mitmproxy는 클래스명으로 애드온을 식별해, 두 플러그인이 모두 `class Plugin`이면 충돌(실측으로 발견) |
| M7 | capture 애드온을 항상 체인 마지막으로 재정렬 | 그렇지 않으면 플러그인의 응답 수정이 기록 이후에 일어나 히스토리에 반영되지 않음(실측으로 발견) |
| M7 | 플러그인 오류는 격리해 표시만 | 하나가 깨져도 엔진과 다른 플러그인은 계속 동작. 단 샌드박스는 아님(§10 신뢰 전제) |
| M8 | mitmproxy-MCP 포크 대신 자체 MCP 서버 작성 | 우리 스토어/애드온을 그대로 감싸는 편이 단순하고, 스코프·인터셉트·Intruder 등 Lanius 고유 기능까지 노출 가능 |
| M8 | MCP는 stdio(`python -m app.mcp`)와 엔진 HTTP 마운트(`/mcp`) 둘 다 제공 | 전자는 GUI 없이 DB만 읽는 경량 모드, 후자는 인터셉트·replay까지 가능한 완전 모드 |
| M8 | 모든 MCP 응답에서 민감 헤더 기본 리댁션 + `reveal_secrets` 옵트인 | §10 준수. 에이전트에게 토큰이 무심코 흘러가지 않도록 |
| M8 | MCP DNS 리바인딩 보호는 켜두되 localhost 임의 포트 허용 | 기본값은 MCP 자체 포트만 허용해 설정 가능한 API 포트에서 421을 반환(실측으로 발견) |

---

## 13. 열린 질문 (착수 전 확정 권장)

- GUI 셸: **Tauri vs Electron** 최종 선택 (권장: Tauri).
- 프로젝트 파일 포맷: SQLite 단일 파일 vs 폴더 번들.
- ~~Intruder 공격 유형 범위~~ → **해결: 4종 모두 구현**(sniper/battering ram/pitchfork/cluster bomb).
- 플러그인 배포 방식(로컬 폴더 vs 간이 레지스트리).
- 라이선스(오픈소스로 공개할지, 공개 시 라이선스 선택).
- 네임스페이스: 보안 분야엔 동명 충돌 없음(확인 완료). 단 bare `lanius`는 무관한 휴면 프로젝트가 선점(PyPI 마크다운 뷰어·GitHub 개인 계정·npm `@lanius` 스코프) → 패키지/org 핸들은 `lanius-proxy` · `getlanius` 등으로 확보. 도메인(`lanius.dev`/`getlanius.com` 등) 가용성 확인 필요.