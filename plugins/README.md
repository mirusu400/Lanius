# Lanius 플러그인 예시

플러그인은 mitmproxy 애드온과 동일한 파이썬 객체다. 파일 하나(`*.py`) 또는
`__init__.py`를 가진 디렉터리를 플러그인 디렉터리(기본 `~/.lanius/plugins`)에
두면 자동으로 발견된다.

## 최소 형태

```python
DESCRIPTION = "한 줄 설명"   # 선택
VERSION = "1.0.0"            # 선택
AUTHOR = "you"               # 선택

class Plugin:
    def request(self, flow):
        flow.request.headers["X-Example"] = "1"
```

`Plugin` 클래스(또는 인스턴스) 대신 `addons = [obj1, obj2]` 리스트를 노출해도 된다.

## 사용 가능한 훅

`request`, `response`, `error`, `tcp_start`, `tcp_message`, `tcp_end`,
`tcp_error`, `websocket_message`, `running`, `done` — 즉 mitmproxy 애드온 훅
전체를 그대로 사용할 수 있다.

## 주의

플러그인은 샌드박스가 아니라 엔진 프로세스 안에서 실행된다(§5). 신뢰할 수 있는
코드만 활성화할 것. 무거운 작업은 이벤트 루프를 막지 않도록 워커로 넘긴다.

## 예시

- `header_tagger.py` — 보안 헤더가 없는 응답에 코멘트 표시
- `request_stamp.py` — 모든 요청에 `X-Lanius` 헤더 추가
