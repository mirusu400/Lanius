"""Verify protocol modes against actual HTTP/1 and HTTP/2 origin traffic."""
from __future__ import annotations

import asyncio
import ssl
from contextlib import asynccontextmanager

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, RequestReceived, StreamEnded
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.addons.replay import build_flow
from app.http_protocol import SETTING
from app.mcp import build_server
from app.tls_trust import TRUSTED_CA_SETTING
from .test_mcp import call
from .test_proxy import engine, free_port
from .test_tls_trust import certificate, pem


@asynccontextmanager
async def origin(tmp_path, *, http2=True, hold=None):
    ca = certificate()
    leaf, key = certificate(ca=False, issuer=ca)
    cert_path, key_path = tmp_path / 'server.pem', tmp_path / 'key.pem'
    cert_path.write_text(pem(leaf))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    context.set_alpn_protocols(['h2', 'http/1.1'] if http2 else ['http/1.1'])
    received = []
    active = set()

    async def respond(reader, writer):
        task = asyncio.current_task()
        active.add(task)
        try:
            if writer.get_extra_info('ssl_object').selected_alpn_protocol() == 'h2':
                conn = H2Connection(config=H2Configuration(client_side=False, header_encoding='utf-8'))
                conn.initiate_connection()
                writer.write(conn.data_to_send())
                bodies = {}
                while data := await reader.read(65536):
                    for event in conn.receive_data(data):
                        if isinstance(event, RequestReceived):
                            bodies[event.stream_id] = b''
                        elif isinstance(event, DataReceived):
                            bodies[event.stream_id] += event.data
                            conn.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                        elif isinstance(event, StreamEnded):
                            received.append(('HTTP/2.0', bodies[event.stream_id]))
                            body = b'HTTP/2.0'
                            conn.send_headers(event.stream_id, [(':status', '200'), ('content-length', str(len(body)))])
                            conn.send_data(event.stream_id, body, end_stream=True)
                    writer.write(conn.data_to_send())
                    await writer.drain()
            else:
                while True:
                    try:
                        head = await reader.readuntil(b'\r\n\r\n')
                    except asyncio.IncompleteReadError:
                        break
                    version = head.split(b'\r\n', 1)[0].split()[-1].decode()
                    length = next((int(line.split(b':', 1)[1]) for line in head.split(b'\r\n')[1:] if line.lower().startswith(b'content-length:')), 0)
                    body = await reader.readexactly(length)
                    received.append((version, body))
                    if hold is not None and b' /slow ' in head:
                        await hold.wait()
                    payload = version.encode()
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(payload)).encode() + b'\r\n\r\n' + payload)
                    await writer.drain()
                    if version == 'HTTP/1.0':
                        break
        except (ConnectionError, ssl.SSLError):
            pass
        finally:
            writer.close()
            active.discard(task)

    server = await asyncio.start_server(respond, '127.0.0.1', 0, ssl=context)
    eng = engine(tmp_path, free_port())
    eng.settings.disable_plugins = True
    eng.store.set_setting(TRUSTED_CA_SETTING, pem(ca[0]))
    await eng.start()
    try:
        yield eng, f'https://localhost:{server.sockets[0].getsockname()[1]}', received
    finally:
        await eng.stop()
        eng.store.close()
        server.close()
        await server.wait_closed()
        for task in list(active):
            task.cancel()
        await asyncio.gather(*list(active), return_exceptions=True)


@pytest.mark.asyncio
async def test_concurrent_replay_modes_are_isolated_and_persisted(tmp_path):
    async with origin(tmp_path) as (eng, url, received):
        async def send(mode, raw_version='HTTP/1.1'):
            flow = build_flow(url=url, method='POST', body=mode, http_version=raw_version)
            record = await eng.replay.send(flow, http_mode=mode)
            assert record.error is None
            assert eng.store.get(record.id).upstream_http_version == record.upstream_http_version
            return record
        modes = ['http1.0', 'http1.1', 'http2', 'auto'] * 3
        records = await asyncio.gather(*(send(mode) for mode in modes))
        for mode, record in zip(modes, records):
            expected = {'http1.0': 'HTTP/1.0', 'http1.1': 'HTTP/1.1', 'http2': 'HTTP/2.0', 'auto': 'HTTP/2.0'}[mode]
            assert record.response_body.decode() == expected
            assert record.upstream_http_version == expected
            assert record.http_mode == mode
            assert (expected, mode.encode()) in received


@pytest.mark.asyncio
async def test_force_h2_does_not_send_http1_to_non_h2_origin(tmp_path):
    async with origin(tmp_path, http2=False) as (eng, url, received):
        record = await eng.replay.send(build_flow(url=url), http_mode='http2')
        assert 'HTTP_VERSION_NEGOTIATION_FAILED' in record.error
        assert record.upstream_http_version is None
        assert received == []
        auto = await eng.replay.send(build_flow(url=url, http_version='HTTP/2'), http_mode='auto')
        assert auto.response_body == b'HTTP/1.1'
        assert auto.upstream_http_version == 'HTTP/1.1'


@pytest.mark.asyncio
async def test_force_h2_plaintext_refused_without_socket(tmp_path):
    eng = engine(tmp_path, free_port())
    await eng.start()
    from unittest.mock import patch
    try:
        with patch('asyncio.open_connection', side_effect=AssertionError('must not connect')):
            record = await eng.replay.send(build_flow(url='http://never-resolve.invalid'), http_mode='http2')
        assert 'h2c' in record.error
        assert record.upstream_http_version is None
    finally:
        await eng.stop()
        eng.store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('mode, expected', [('http1.0', 'HTTP/1.0'), ('http1.1', 'HTTP/1.1'), ('http2', 'HTTP/2.0')])
async def test_project_mode_controls_browser_upstream_and_replay(tmp_path, mode, expected):
    async with origin(tmp_path) as (eng, url, received):
        await eng.set_http_protocol(mode)
        verify = ssl.create_default_context(cafile=str(tmp_path / 'mitm/mitmproxy-ca-cert.pem'))
        async with httpx.AsyncClient(proxy=f'http://127.0.0.1:{eng.settings.proxy_port}', verify=verify, http2=True) as client:
            response = await client.get(url)
            assert response.text == expected
        replayed = await eng.replay.send(build_flow(url=url))
        assert replayed.response_body.decode() == expected
        assert replayed.http_mode == mode
        assert received == [(expected, b''), (expected, b'')]
        assert eng.store.get_setting(SETTING) == mode


@pytest.mark.asyncio
async def test_mcp_override_and_project_setting(tmp_path):
    async with origin(tmp_path) as (eng, url, received):
        server = build_server(eng.store, eng)
        assert await call(server, 'get_http_mode') == {'mode': 'auto'}
        assert await call(server, 'set_http_mode', mode='http1.0') == {'mode': 'http1.0'}
        inherited = await call(server, 'send_request', url=url)
        assert inherited['upstream_http_version'] == 'HTTP/1.0'
        forced = await call(server, 'send_request', url=url, http_mode='http2')
        assert forced['upstream_http_version'] == 'HTTP/2.0'
        replayed = await call(server, 'replay_flow', flow_id=forced['id'], http_mode='http1.1')
        assert replayed['upstream_http_version'] == 'HTTP/1.1'


def test_rest_modes_and_project_roundtrip(tmp_path):
    eng = engine(tmp_path, free_port())
    eng.store.close()
    with TestClient(create_app(eng.settings)) as client:
        assert client.get('/api/http-protocol').json() == {'mode': 'auto'}
        assert client.put('/api/http-protocol', json={'mode': 'h2'}).status_code == 422
        assert client.post('/api/replay/send', json={'url': 'https://example.invalid', 'http_mode': 'bad'}).status_code == 422
        assert client.put('/api/http-protocol', json={'mode': 'http1.1'}).json() == {'mode': 'http1.1'}
        exported = client.get('/api/project/export?include_flows=false').json()
        assert exported['settings'][SETTING] == 'http1.1'
        client.put('/api/http-protocol', json={'mode': 'auto'})
        assert client.post('/api/project/import', json=exported).status_code == 200
        assert client.get('/api/http-protocol').json() == {'mode': 'http1.1'}


@pytest.mark.asyncio
@pytest.mark.parametrize('scheme', ['http', 'https'])
async def test_forced_modes_follow_upstream_connect_route(tmp_path, scheme):
    async with origin(tmp_path) as (eng, url, received):
        connects = []
        tasks = set()
        async def tunnel(reader, writer):
            task = asyncio.current_task()
            tasks.add(task)
            target_writer = None
            try:
                if scheme == 'https':
                    assert writer.get_extra_info('ssl_object').selected_alpn_protocol() == 'http/1.1'
                header = await reader.readuntil(b'\r\n\r\n')
                method, address, _ = header.split(b'\r\n', 1)[0].split()
                assert method == b'CONNECT'
                connects.append(address)
                host, port = address.decode().rsplit(':', 1)
                target_reader, target_writer = await asyncio.open_connection(host, int(port))
                writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                await writer.drain()
                async def copy(source, dest):
                    try:
                        while data := await source.read(65536):
                            dest.write(data)
                            await dest.drain()
                    finally:
                        dest.close()
                await asyncio.gather(copy(reader, target_writer), copy(target_reader, writer))
            except (ConnectionError, asyncio.IncompleteReadError):
                pass
            finally:
                writer.close()
                if target_writer:
                    target_writer.close()
                tasks.discard(task)
        proxy_tls = None
        if scheme == 'https':
            proxy_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            proxy_tls.load_cert_chain(tmp_path / 'server.pem', tmp_path / 'key.pem')
            proxy_tls.set_alpn_protocols(['h2', 'http/1.1'])
        proxy = await asyncio.start_server(tunnel, '127.0.0.1', 0, ssl=proxy_tls)
        try:
            await eng.set_upstream([f'{scheme}://localhost:{proxy.sockets[0].getsockname()[1]}'])
            for mode, version in [('http1.0', b'HTTP/1.0'), ('http1.1', b'HTTP/1.1'), ('http2', b'HTTP/2.0')]:
                result = await eng.replay.send(build_flow(url=url), http_mode=mode)
                assert result.error is None
                assert result.response_body == version
            assert len(connects) == 3
        finally:
            proxy.close()
            await proxy.wait_closed()
            for task in list(tasks):
                task.cancel()
            await asyncio.gather(*list(tasks), return_exceptions=True)


@pytest.mark.asyncio
async def test_fuzzer_mode_is_frozen_and_roundtrips(tmp_path):
    async with origin(tmp_path) as (eng, url, received):
        run = await eng.fuzzer.start(url=url, template='POST /{{x}} HTTP/1.1\nHost: localhost\n\npayload', payload_sets=[['a', 'b']], http_mode='http2')
        await eng.fuzzer._tasks[run.id]
        saved = next(item for item in eng.store.list_fuzzer_runs() if item['id'] == run.id)
        assert saved['http_mode'] == 'http2'
        assert len(saved['results']) == 2
        assert received == [('HTTP/2.0', b'payload')] * 2
        eng.fuzzer.reload()
        assert eng.fuzzer.get(run.id).http_mode == 'http2'


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['auto', 'http1.0', 'http1.1', 'http2'])
async def test_modes_preserve_lockdown_scope_guard_before_network(tmp_path, mode):
    from unittest.mock import patch
    eng = engine(tmp_path, free_port())
    eng.lockdown.set_project(True)
    eng.lockdown.set_scope_egress(True)
    eng.scope.add_rule(host='allowed.test')
    await eng.start()
    try:
        with patch('asyncio.open_connection', side_effect=AssertionError('out of scope socket')):
            result = await eng.replay.send(build_flow(url='https://blocked.invalid/path'), http_mode=mode)
        assert result.error
        assert result.upstream_http_version is None
    finally:
        await eng.stop()
        eng.store.close()


@pytest.mark.asyncio
async def test_mode_change_cancels_active_send_and_replaces_existing_connections(tmp_path):
    from app.addons.replay import ReplayError
    hold = asyncio.Event()
    async with origin(tmp_path, hold=hold) as (eng, url, received):
        verify = ssl.create_default_context(cafile=str(tmp_path / 'mitm/mitmproxy-ca-cert.pem'))
        async with httpx.AsyncClient(proxy=f'http://127.0.0.1:{eng.settings.proxy_port}', verify=verify, http2=True) as browser:
            assert (await browser.get(url)).text == 'HTTP/2.0'
            slow = asyncio.create_task(eng.replay.send(build_flow(url=url+'/slow'), http_mode='http1.1'))
            async with asyncio.timeout(5):
                while ('HTTP/1.1', b'') not in received:
                    await asyncio.sleep(0.01)
            old_connections = [transport for handler in eng.master.addons.get('proxyserver').connections.values()
                               for transport in handler.transports.values()]
            await eng.set_http_protocol('http1.0')
            with pytest.raises(ReplayError, match='proxy connection settings change'):
                await slow
            assert all(transport.handler is None or transport.handler.done() for transport in old_connections)
            # HTTP clients differ in whether they retry a closed HTTP/2 pool.
            # A fresh browser connection must negotiate the new policy.
            async with httpx.AsyncClient(proxy=f'http://127.0.0.1:{eng.settings.proxy_port}', verify=verify, http2=True) as reconnected:
                assert (await reconnected.get(url)).text == 'HTTP/1.0'
            hold.set()
            assert eng.replay._active == set()


@pytest.mark.asyncio
async def test_plain_http1_modes_send_exact_versions_and_body_length(tmp_path):
    received = []
    async def respond(reader, writer):
        try:
            head = await reader.readuntil(b'\r\n\r\n')
            received.append(head)
            assert b'content-length: 7' in head.lower()
            assert await reader.readexactly(7) == b'payload'
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            await writer.drain()
        finally:
            writer.close()
    server = await asyncio.start_server(respond, '127.0.0.1', 0)
    eng = engine(tmp_path, free_port())
    await eng.start()
    try:
        url = f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}'
        for mode, version in [('http1.0', 'HTTP/1.0'), ('http1.1', 'HTTP/1.1')]:
            record = await eng.replay.send(build_flow(url=url, method='POST', body='payload', http_version='HTTP/2.0'), http_mode=mode)
            assert record.error is None
            assert record.upstream_http_version == version
            assert received[-1].startswith(f'POST / {version}\r\n'.encode())
    finally:
        await eng.stop()
        eng.store.close()
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_force_http10_buffers_streamed_upload_before_version_and_framing(tmp_path):
    async with origin(tmp_path) as (eng, url, received):
        await eng.set_http_protocol('http1.0')
        class StreamUploads:
            def requestheaders(self, flow):
                flow.request.stream = True
        eng.master.addons.add(StreamUploads())
        eng._reorder_capture_last()
        verify = ssl.create_default_context(cafile=str(tmp_path / 'mitm/mitmproxy-ca-cert.pem'))
        async def chunks():
            yield b'pay'
            yield b'load'
        async with httpx.AsyncClient(proxy=f'http://127.0.0.1:{eng.settings.proxy_port}', verify=verify) as browser:
            response = await browser.post(url, content=chunks())
        assert response.text == 'HTTP/1.0'
        assert received == [('HTTP/1.0', b'payload')]
