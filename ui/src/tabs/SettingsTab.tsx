import { useEffect, useState } from 'react';

import { caDownloadUrl, getCaInfo, getStatus, type CaInfo } from '../api/client';
import type { EngineStatus } from '../api/types';

export function SettingsTab() {
  const [ca, setCa] = useState<CaInfo | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCaInfo().then(setCa).catch((e) => setError((e as Error).message));
    getStatus().then(setStatus).catch(() => undefined);
  }, []);

  return (
    <div className="settings-tab">
      {error && <div className="banner error">{error}</div>}

      <section>
        <h3>프록시</h3>
        {status ? (
          <dl className="settings-grid mono">
            <dt>상태</dt>
            <dd className={status.proxy.running ? 'status-2xx' : 'status-5xx'}>
              {status.proxy.running ? 'running' : 'stopped'}
            </dd>
            <dt>주소</dt>
            <dd>
              {status.proxy.host}:{status.proxy.port}
            </dd>
            <dt>버전</dt>
            <dd>{status.version}</dd>
            <dt>프로젝트 DB</dt>
            <dd>{status.db_path}</dd>
            <dt>캡처된 flow</dt>
            <dd>{status.flows}</dd>
          </dl>
        ) : (
          <p className="muted">엔진에 연결할 수 없습니다.</p>
        )}
      </section>

      <section>
        <h3>CA 인증서</h3>
        <p className="muted">
          HTTPS를 가로채려면 이 CA를 기기의 신뢰 저장소에 설치해야 합니다.
          인증서는 최초 실행 시 자동 생성되며, 개인키는 절대 노출되지 않습니다.
        </p>
        {ca ? (
          <>
            <dl className="settings-grid mono">
              <dt>위치</dt>
              <dd>{ca.confdir}</dd>
              <dt>프록시</dt>
              <dd>{ca.proxy}</dd>
            </dl>
            <div className="ca-downloads">
              {Object.entries(ca.available).map(([format, exists]) => (
                <a
                  key={format}
                  className={exists ? 'ca-link' : 'ca-link disabled'}
                  href={exists ? caDownloadUrl(format) : undefined}
                  download
                >
                  .{format} 내려받기
                </a>
              ))}
            </div>
            <p className="muted">
              또는 프록시를 설정한 기기에서{' '}
              <a href={ca.install_url} target="_blank" rel="noreferrer">
                mitm.it
              </a>{' '}
              에 접속하면 플랫폼별 설치 안내가 표시됩니다.
            </p>
          </>
        ) : (
          <p className="muted">CA 정보를 불러오는 중…</p>
        )}
      </section>

      <section>
        <h3>브라우저 설정</h3>
        <pre className="mono settings-code">
{`# 프록시를 통해 트래픽 보내기
curl -x http://${status?.proxy.host ?? '127.0.0.1'}:${status?.proxy.port ?? 8080} http://example.com/

# 시스템/브라우저 프록시를 위 주소로 지정한 뒤 http://mitm.it 접속 → CA 설치`}
        </pre>
      </section>
    </div>
  );
}
