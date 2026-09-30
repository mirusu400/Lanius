# Lanius 플러그인 플랫폼 조사

> 이 문서는 구현 전 기준 커밋의 상태를 기록한 조사 자료다. 구현 후의
> 기능과 남은 확장 지점은 [Plugin platform status and next steps](../plugin-platform-status.md)에
> 정리되어 있다.

조사일: 2026-09-29

기준 커밋: `54d31df`

조사 브랜치: `research/plugin-platform`

## 결론

Lanius의 현재 플러그인 기능은 **mitmproxy 애드온을 런타임에 싣는 최소 기능 제품**으로는 잘 동작한다. Python 플러그인이 실제 프록시 애드온 체인에 들어가 HTTP, TCP, WebSocket 트래픽을 읽고 수정할 수 있고, 활성 상태 저장, enable/disable, 수동 reload, 오류 표시, Copy as 메뉴용 코드 생성기 등록까지 구현되어 있다. 전용 테스트 31개도 모두 통과한다.

하지만 서드파티 플러그인 생태계를 만들기에는 "트래픽 훅" 이외의 공식 확장 지점이 부족하다. 지금은 플러그인이 Lanius 내부 모듈을 직접 import하거나 mitmproxy 전역 객체에 의존해야 한다. 전용 탭, 메시지 에디터, 일반 컨텍스트 메뉴, 설정, 단축키, Fuzzer payload, 스캐너 check, issue 저장, 프로젝트 저장소, 설치와 업데이트를 위한 안정된 API가 없다.

따라서 예제 플러그인을 많이 추가하기 전에 다음 세 층을 순서대로 만드는 것이 좋다.

1. 현재 Python loader의 수명주기와 unload를 안전하게 고친다.
2. owner 기반 등록과 자동 해제가 가능한 버전형 `lanius_sdk`를 만든다.
3. manifest 패키지, UI plugin, scanner/issue 모델, 서명된 catalog를 그 위에 올린다.

기존 Python 애드온 호환성은 유지할 수 있다. 다만 커뮤니티 플러그인까지 같은 엔진 프로세스에서 실행하는 구조는 권한 격리가 불가능하므로, 장기적으로는 **신뢰된 in-process traffic addon**과 **격리된 package plugin**을 구분하는 편이 안전하다.

## 현재 구현 범위

### 로딩과 관리

현재 loader는 [`engine/app/addons/plugins.py`](../../engine/app/addons/plugins.py)를 중심으로 동작한다.

| 항목 | 현재 동작 | 평가 |
|---|---|---|
| 검색 | plugin directory 바로 아래의 `*.py`와 `__init__.py`가 있는 directory 검색 | 동작함. 중첩 catalog나 manifest는 없음 |
| entry point | `Plugin` class/instance 또는 `addons = [...]` | mitmproxy addon과 호환됨 |
| metadata | module의 `DESCRIPTION`, `VERSION`, `AUTHOR` | plugin을 실제 load한 뒤에만 채워짐 |
| 활성 상태 | project SQLite의 `plugins.enabled` setting에 이름 목록 저장 | project별 enable 상태, 설치 파일은 machine 공용 |
| 제어 | REST API와 Plugins 탭에서 enable, disable, reload, rescan | 설치, 삭제, 순서 변경, 자동 reload는 없음 |
| 오류 | import와 addon 등록 오류를 잡아 Plugins 탭에 표시 | hook 실행 오류와 성능 상태는 plugin별로 보이지 않음 |
| 실행 위치 | engine Python process 안에서 full trust로 실행 | 빠르지만 파일, 네트워크, 프로세스, CA와 project data에 제한 없이 접근 가능 |

데스크톱 shell은 `LANIUS_PLUGINS_DIR`을 machine 공용 plugin directory로 지정하고, enable 목록은 열린 project DB에 저장한다. 이 조합은 "한 번 설치하고 project마다 켜기"에 알맞다.

### 가능한 확장

현재 상태에서도 다음은 실제로 가능하다.

- HTTP request/response 관찰과 실시간 수정
- raw TCP message 관찰과 수정
- WebSocket message 관찰과 수정
- mitmproxy가 전달하는 lifecycle, connection, TLS, DNS, UDP, QUIC hook 사용
- async hook 구현
- mitmproxy API를 이용한 추가 request 발행과 flow 조작
- Lanius 내부 Python module을 직접 import해 codec, code generation 같은 기능 재사용
- `codegen_formats`로 Proxy, Target, Replay, Fuzzer의 Copy as 메뉴에 생성기 추가
- 외부 API 호출, subprocess 실행, 로컬 파일 접근 등 일반 Python이 할 수 있는 작업

`PluginManager`가 plugin object를 실제 `AddonManager`에 추가하므로, dispatch 자체는 [`mitmproxy event hook 목록`](https://docs.mitmproxy.org/stable/api/events.html)에 있는 hook 전반을 처리한다. 현재 문서와 Plugins 탭에 표시되는 hook은 `request`, `response`, TCP 일부, `websocket_message`, `running`, `done` 등 10개만 하드코딩되어 있어 실제 능력을 제대로 보여주지 못한다. 예를 들어 `requestheaders`, `responseheaders`, `websocket_start/end`, client/server connection, TLS, DNS, UDP, QUIC hook은 실행 가능하지만 목록에는 나타나지 않는다.

### 제품 UI에서 사용할 수 있는 확장 지점

현재 Lanius 고유 확장 지점은 사실상 `codegen_formats` 하나다. 플러그인이 `(label, callable)`을 등록하면 engine의 format registry를 거쳐 여러 화면의 Copy as 메뉴에 나타난다. 이 작은 구현은 앞으로 만들 contribution registry의 좋은 원형이다. 등록 owner가 있고 unload 시 owner의 contribution을 지우기 때문이다.

그 밖의 UI는 plugin 관리 화면뿐이다. [`ui/src/tabs/PluginsTab.tsx`](../../ui/src/tabs/PluginsTab.tsx)는 directory, 이름, 설명, version, hook, load 상태, 오류, toggle, reload를 보여준다. plugin이 새 tab, panel, editor, button, column, menu, command를 추가할 방법은 없다.

### 검증된 테스트 범위

[`engine/tests/test_plugins.py`](../../engine/tests/test_plugins.py)는 다음을 검증한다.

- file/package 검색과 private file 제외
- 단일 `Plugin`과 여러 `addons` object
- enable, disable, reload, project별 영속 상태
- import 실패 격리와 API의 4xx 응답
- live mitmproxy addon chain 등록
- 같은 class 이름을 가진 여러 plugin의 공존
- capture addon이 plugin 뒤에 실행되어 수정 결과가 history에 저장되는 순서
- code generator 등록과 unload
- shipped examples의 실제 flow 수정

조사 중 아래 명령으로 이 파일의 테스트 31개를 실행했고 모두 통과했다.

```text
python -m pytest tests/test_plugins.py -q
31 passed
```

별도 runtime probe에서는 다음 현재 동작도 재현했다.

- disabled plugin의 description과 version은 `None`이고 enable 뒤에야 채워진다.
- `requestheaders`와 `dns_response` hook을 가진 plugin은 실제 load되지만 UI용 `hooks` 목록은 빈 배열이다.
- 두 plugin이 같은 codegen ID를 등록하면 나중 것이 앞의 것을 덮어쓰고, 나중 plugin을 disable한 뒤에는 앞의 항목이 복원되지 않는다.

## 지금 고쳐야 할 정확성 문제

기능을 넓히기 전에 아래 문제를 먼저 해결해야 한다. contribution 종류가 늘어난 뒤 고치면 stale registration과 unload 오류가 여러 registry로 퍼진다.

### 1. runtime enable/reload의 lifecycle이 불완전하다

engine 시작 전에 load된 plugin은 이후 master의 `running` event를 받는다. 반면 engine이 이미 실행 중일 때 Plugins 탭에서 enable 또는 reload한 plugin은 `AddonManager.add()`가 보내는 `load`만 받고 `running`과 현재 option의 초기 `configure`를 받지 않는다.

mitmproxy의 `AddonManager.register()` 주석도 이미 running 중인 chain에 동적 등록할 때 caller가 `running`과 `configure`를 이어서 보내야 한다고 명시한다. 초기화가 `running`이나 `configure`에 있는 addon은 시작 시 자동 load하면 동작하지만 같은 addon을 UI에서 켜거나 reload하면 다르게 동작할 수 있다.

관리 API를 async로 바꾸고 load mode에 따라 lifecycle을 명시적으로 완성해야 한다. hot unload의 async `done`도 같은 경로에서 처리해야 한다.

### 2. unload가 모든 등록을 되돌리지 못한다

mitmproxy `AddonManager.remove()`는 chain과 lookup에서 addon을 빼고 `done`을 부르지만, load 시 수집한 command와 추가한 option을 제거하지 않는다. 따라서 plugin이 mitmproxy command/option을 직접 선언하면 disable/reload 이후에도 전역 등록이 남을 수 있다.

Lanius contribution은 전부 다음 성질을 가져야 한다.

- 등록할 때 plugin owner와 registration handle 기록
- unload 시 등록 역순으로 dispose
- 일부 등록이 실패하면 이미 끝난 등록을 전부 rollback
- 같은 ID 충돌을 명시적 오류로 처리
- reload 실패 시 이전 version 유지 또는 완전한 disabled 상태 중 하나를 일관되게 보장

raw mitmproxy command/option을 공식 API로 약속하기보다는 Lanius 자체 command와 settings registry를 제공하는 편이 unload를 통제하기 쉽다.

### 3. code generator 등록이 완전히 transactional하지 않다

`codegen_formats`는 addon chain 등록보다 먼저 추가된다. 이후 addon 등록이 실패하면 addon object는 rollback하지만 format owner는 제거하지 않아 메뉴 항목이 남을 수 있다.

또한 built-in format 이름은 보호하지만 plugin 두 개가 같은 `kind`를 쓰면 나중 plugin이 앞 plugin을 조용히 덮어쓴다. 나중 plugin을 disable하면 원래 항목이 복원되지 않고 없어져 버린다. ID를 `{plugin_id}:{local_id}`로 namespace하고 registry가 중복을 거부해야 한다.

### 4. 검색과 상태 변경 사이에 thread race가 있다

`GET /api/plugins`는 `discover()`를 worker thread에서 실행한다. `discover()`는 file이 사라진 plugin을 unload하면서 live mitmproxy addon chain까지 수정할 수 있다. enable/disable/reload는 event loop thread에서 같은 `plugins` dictionary와 addon chain을 수정한다.

filesystem scan만 worker에서 하고, scan 결과를 반영하는 모든 state mutation과 addon lifecycle은 engine event loop 한 곳에서 직렬화해야 한다. plugin별 lock보다 manager command queue가 단순하다.

### 5. metadata와 hook 표시는 신뢰할 수 없다

새로 발견한 disabled plugin은 import하지 않으므로 설명, version, author, hook이 비어 있다. UI test의 disabled fixture에는 metadata가 들어 있지만 실제 discovery 결과와 다르다.

metadata는 실행 없이 읽을 수 있는 manifest로 옮겨야 한다. legacy `.py`는 AST로 상단 literal 상수만 읽는 fallback을 둘 수 있다. hook 표시는 mitmproxy의 현재 hook registry를 기준으로 찾거나 manifest capability와 runtime registration을 함께 보여주는 편이 맞다.

### 6. package reload가 하위 module을 정리하지 않는다

unload는 `sys.modules["lanius_plugins.<name>"]`만 제거한다. package plugin이 `.parser`, `.ui`, `.rules` 같은 하위 module을 import했다면 reload 뒤에도 예전 하위 module이 남을 수 있다. 해당 prefix의 module을 모두 제거하고 import cache를 무효화해야 한다.

### 7. 실행 오류, block, 자원 사용을 관리하지 못한다

mitmproxy는 일반적인 hook exception을 log하고 다음 addon으로 진행하지만 plugin은 loaded 상태로 남는다. 무한 loop, blocking I/O, `SystemExit`, native module crash까지 막지는 못한다. `codegen_formats` callable도 FastAPI event loop에서 동기 실행되어 느린 plugin 하나가 API를 막을 수 있다.

plugin별 log/output/error, 최근 오류 수, hook 실행 시간, timeout 가능한 background job, manual safe mode가 필요하다. CPU와 blocking I/O 작업은 task service나 subprocess로 보내야 한다.

### 8. dependency와 compatibility 계약이 없다

별도 dependency resolver, per-plugin environment, SDK version 범위가 없다. frozen desktop engine에서는 engine bundle에 없는 package를 plugin이 당연히 import할 수 있다고 보장할 수 없다. pure Python dependency를 plugin package에 vendor하는 규칙과 native dependency를 별도 process에서 실행하는 규칙이 필요하다.

## 확장 지점 현황

보안 테스트 도구의 플러그인 생태계에서 흔히 필요한 확장 범주를 기준으로 Lanius의 현재 상태를 정리하면 다음과 같다.

| 확장 범주 | Lanius 현재 | 제안 우선순위 |
|---|---|---|
| HTTP/Proxy traffic handler | mitmproxy hook으로 강력하게 지원 | 유지, stable wrapper 추가 |
| WebSocket handler | message hook으로 수정 가능 | wrapper와 editor/action 추가 |
| 추가 HTTP request | mitmproxy/Lanius 내부 접근으로 가능 | `sdk.http.send()` 제공 |
| 전용 tab/page | 없음 | P2 |
| Context menu/action | Copy as generator만 있음 | P1 최우선 |
| Custom message editor | 없음 | P2 |
| Settings panel | 없음 | P1 |
| Hotkey/menu bar | app 자체 shortcut만 있음 | P1/P2 |
| Fuzzer payload | plugin API 없음 | P1 |
| Scanner check | scanner/issue 모델 자체가 없음 | P3 |
| Site map/scope/tool APIs | REST와 내부 Python object는 존재 | P1 wrapper |
| Persistence | enable 목록만 공식 지원 | P1 |
| Logging | 전용 화면 없음 | P0/P1 |
| Install/update/catalog | directory에 수동 copy | P2/P4 |
| Ordering | load 순서뿐, UI 제어 없음 | P0 |
| Auto reload | reload button | P0/P2 |
| Compatibility | 계약 없음 | P1/P2 |
| Security review | trust warning만 있음 | P4 |

비교 대상으로 Caido도 볼 가치가 있다. Caido는 하나의 package에 `manifest.json`, frontend plugin, backend plugin을 함께 넣고 typed frontend/backend SDK와 RPC를 제공한다. [공식 plugin architecture](https://developer.caido.io/plugins/concepts/package.html)는 Lanius의 React UI와 Python engine을 잇는 package 설계에 더 직접적인 참고가 된다. Caido package는 release signature도 요구한다. [공식 repository/signing 안내](https://developer.caido.io/plugins/guides/repository.html)를 참고할 수 있다.

## 제안 architecture

### 두 종류의 runtime

#### Trusted traffic addon

기존 Python addon을 유지한다. request/response/TCP/WebSocket을 낮은 latency로 동기 수정해야 하는 plugin에 적합하다.

- 사용자가 local file로 명시적으로 설치
- full trust badge와 source path 표시
- API compatibility 검사
- event loop budget 측정과 경고
- blocking 작업을 위한 `sdk.tasks` 제공
- manifest가 없어도 legacy mode로 load 가능

Python을 같은 process에서 실행하면서 실질적인 permission sandbox를 제공할 수는 없다. manifest permission은 사용자에게 알리는 용도로는 쓸 수 있지만 보안 경계로 표현하면 안 된다.

#### Package plugin

UI, 분석 job, 외부 tool 연동, community store plugin은 package 단위로 배포한다.

- frontend: sandboxed iframe 또는 제한된 webview surface에서 실행
- backend: 별도 Python worker process에서 실행
- frontend와 backend는 namespaced RPC와 event channel로 통신
- engine data는 capability 기반 SDK로만 접근
- crash, timeout, memory 문제를 main proxy와 격리

동기 traffic rewrite가 필요한 package는 별도 심사를 거쳐 trusted addon component를 포함하게 할 수 있다. 대부분의 passive 분석, import/export, 외부 scanner, dashboard, report 기능은 subprocess로 충분하다.

### manifest 초안

```json
{
  "schema": 1,
  "id": "lanius.jwt-inspector",
  "name": "JWT Inspector",
  "version": "1.0.0",
  "description": "Inspect and edit JWT values in HTTP messages",
  "author": {
    "name": "Lanius",
    "url": "https://example.invalid"
  },
  "license": "MIT",
  "compatibility": {
    "pluginApi": ">=1.0 <2.0",
    "lanius": ">=0.1.0"
  },
  "components": {
    "backend": "backend/main.py",
    "frontend": "frontend/index.js"
  },
  "contributes": {
    "actions": ["jwt.copy-decoded"],
    "editors": ["jwt"],
    "settings": "settings.schema.json"
  },
  "permissions": [
    "traffic.read",
    "project.storage"
  ]
}
```

package 확장자는 예를 들어 `.lanius-plugin`으로 두고, 내부는 manifest, backend source 또는 wheel, prebuilt frontend JS/CSS, assets, lockfile, signature를 포함한 zip으로 만들 수 있다.

### SDK와 contribution registry

plugin에는 engine object나 FastAPI app을 직접 주지 않고 `PluginContext` 하나를 전달한다.

```python
def activate(ctx):
    ctx.actions.register(...)
    ctx.scanner.register_passive_check(...)
    ctx.settings.register_schema(...)
    ctx.events.on("traffic.response", ...)
```

각 `register()`는 disposable registration을 반환하고 manager도 owner별 registration을 기록한다. unload는 manager가 항상 전부 정리한다.

권장 SDK 영역은 다음과 같다.

- `sdk.http`: request 생성, 발행, replay, response와 timing
- `sdk.traffic`: live event 구독, stored flow query, annotation/highlight
- `sdk.scope`: scope 조회와 변경
- `sdk.site_map`: host, path, endpoint query와 추가
- `sdk.replay`: 새 tab으로 보내기, programmatic send
- `sdk.fuzzer`: payload generator, payload processor, attack 시작과 결과 event
- `sdk.scanner`: passive/active check, insertion point, issue report와 dedup
- `sdk.websocket`: message event, send/repeat, editor action
- `sdk.ui`: tab/page, context action, editor, column, badge, notification, hotkey
- `sdk.codecs`: encoder/decoder/transform 등록
- `sdk.settings`: typed schema, user/project scope
- `sdk.storage`: namespaced KV/blob storage와 quota
- `sdk.tasks`: cancellable background task, progress, timeout
- `sdk.logging`: plugin별 structured log
- `sdk.process`: 선언한 permission이 있을 때 외부 process 실행

UI에서 plugin backend의 arbitrary FastAPI route를 mount하지 말고 `/api/plugins/{plugin_id}/rpc/{method}` 하나로 dispatch하는 것이 좋다. route 충돌과 unload 정리가 쉬워지고, method별 schema와 permission 검사를 넣을 수 있다.

### permission 초안

최소한 아래 capability는 구분해야 한다.

- `traffic.read`, `traffic.modify`, `traffic.secrets`
- `project.read`, `project.write`, `project.storage`
- `scope.read`, `scope.write`
- `network.target`, `network.external`
- `filesystem.plugin`, `filesystem.user-selected`
- `process.spawn`
- `ui.extend`
- `ai.use`

trusted in-process Python addon에 대해서는 이 permission이 enforcement boundary가 아니다. subprocess와 sandboxed frontend에서만 실제 enforcement가 가능하다.

## 구현 단계

### P0: loader hardening

목표는 기존 기능을 늘리기 전에 enable/disable/reload를 완전히 되돌릴 수 있게 만드는 것이다.

- 모든 manager mutation을 engine event loop에서 직렬화
- hot load 시 `load` → initial `configure` → `running` lifecycle 보장
- async `done`을 기다리는 unload
- module subtree와 import cache 정리
- contribution 등록 transaction과 rollback
- format ID namespace와 충돌 오류
- 전체 hook detection
- manifest/AST metadata preflight
- plugin 순서 변경과 영속화
- auto reload watcher와 safe mode
- plugin별 output, error, hook duration 표시
- startup 실패, hook 실패, partial registration, package reload 회귀 테스트

### P1: stable backend SDK와 headless contributions

이 단계만 끝나도 UI bundle을 싣지 않는 유용한 plugin을 많이 만들 수 있다.

- versioned `lanius_sdk`
- action/context menu registry
- typed settings와 user/project persistence
- codegen/codec/column/highlight 등록
- Fuzzer payload generator/processor
- flow query, replay, scope, site map facade
- namespaced storage, logging, background task
- 모든 registration의 owner 기반 dispose

### P2: package와 UI plugin

- `.lanius-plugin` manifest와 local install/uninstall
- compatibility, checksum, signature 검증
- frontend asset serving과 sandboxed bridge
- page/tab, message editor, settings panel, modal, command palette, hotkey
- backend RPC와 frontend event subscription
- development mode와 file watcher
- import/export 가능한 offline package

### P3: scanner와 issue platform

- issue table: title, severity, confidence, URL, evidence, remediation, plugin, dedup key
- passive check와 active check scheduler
- parameter와 nested data insertion point abstraction
- concurrency, rate, scope, timeout, cancellation 정책
- request/response evidence와 issue UI
- issue import/export와 external scanner adapter
- OAST service는 별도 단계로 추가

### P4: catalog와 생태계

- signed immutable release와 public key
- source repository와 license 필수
- compatibility matrix와 update channel
- one-click install/update/rollback
- review checklist와 automated static checks
- popularity, rating보다 먼저 crash rate와 resource impact 표시
- security incident 시 package revoke 목록

## 만들 수 있는 plugin 후보

### 현재 API만으로 바로 가능한 것

| Plugin | 현재 가능한 핵심 | 현재 제약 |
|---|---|---|
| Security Header Tagger | response hook으로 comment 추가 | structured issue와 전용 화면 없음 |
| Request Stamp/Correlation ID | request header 수정 | 설정 UI 없음 |
| Target Redirector | request host/path 수정 | rule UI와 안전한 persistence 없음 |
| Session/CSRF Token Sync | response에서 token 수집 후 request 갱신 | project storage와 사용자 제어 부족 |
| JWT/AES traffic transformer | request/response hook에서 decode/re-encode | custom editor가 없음 |
| WebSocket transformer | `websocket_message` 수정 | custom viewer/action 없음 |
| Passive secret/endpoint detector | response 분석과 comment/highlight | issue model 없음 |
| Copy as sqlmap/x8/httpie | `codegen_formats` | 선택 context와 plugin settings 부족 |
| External tool launcher | Python subprocess로 실행 | permission, job UI, result import 없음 |

이들은 예제로는 만들 수 있지만, 내부 API 직접 접근과 각자 만든 설정 저장 방식을 권장 사례로 굳히지 않는 것이 좋다.

### P1 이후 우선 제공할 first-party plugin

| Plugin | 필요한 contribution | 가치 |
|---|---|---|
| Hackvertor 계열 Transform Library | codec, editor action, context menu | 수동 테스트 전반에서 재사용 가능 |
| Custom Payload Kit | Fuzzer generator/processor, settings | SDK의 payload API를 검증하기 좋음 |
| Request Minimizer | request action, replay send, diff | 작고 명확한 headless plugin |
| Token Sync | traffic event, project storage, settings | session API와 persistence를 검증 |
| Copy as Toolkit | codegen/action | 기존 확장 지점을 안정화하는 예제 |
| Header/Parameter Highlighter | column/highlight/filter | history contribution을 검증 |

### P2/P3 이후 대표 plugin

| Plugin | 필요한 기반 |
|---|---|
| JWT Inspector | custom HTTP editor, codec, settings |
| MessagePack/Protobuf Editor | custom editor, binary codec, schema assets |
| AuthMatrix/Autorize | custom tab, multi-session storage, replay, result table |
| Passive Secrets Scanner | passive check, issue model, evidence |
| JS Link/Endpoint Finder | passive check, site map write |
| GraphQL Toolkit | custom editor, introspection action, site map |
| OpenAPI/Postman/HAR Importer | file picker, site map/replay write |
| Nuclei Bridge | subprocess, task progress, issue import |
| sqlmap Launcher | context action, subprocess, structured output |
| 403 Bypass/Content-Type Tester | action, request mutation matrix, result tab |
| Cache Poisoning/Param Miner | active scanner, insertion points, dedup |
| OAST Client | external network permission, polling service, issue correlation |
| WebSocket Fuzzer | WebSocket API, payload provider, result table |
| Report/Collaboration Export | issue API, redaction, external network permission |

## 첫 구현 범위 제안

첫 개발 milestone은 "Plugin Platform v1"로 잡고 아래까지만 구현하는 것이 적절하다.

1. P0 loader hardening 전부
2. `plugin.json`과 local package install/uninstall
3. owner/disposable contribution registry
4. action/context menu, settings, storage, logging, task API
5. codec과 Fuzzer payload provider
6. first-party plugin 3개: Transform Library, Token Sync, Custom Payload Kit

이 범위는 scanner와 arbitrary UI를 서두르지 않으면서도 현재의 단일 codegen hook을 실제 plugin platform으로 바꾼다. 이후 UI bridge를 붙일 때 같은 manifest, lifecycle, owner registry, permission, storage를 재사용할 수 있다.

## 참고 자료

- [mitmproxy: addon event hooks](https://docs.mitmproxy.org/stable/api/events.html)
- [mitmproxy: addon options](https://docs.mitmproxy.org/stable/addons/options/)
- [mitmproxy: addon commands](https://docs.mitmproxy.org/stable/addons/commands/)
- [Caido: plugin package architecture](https://developer.caido.io/plugins/concepts/package.html)
- [Caido: plugin package signing](https://developer.caido.io/plugins/guides/repository.html)
