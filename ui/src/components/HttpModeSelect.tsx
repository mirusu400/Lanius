import type { HttpMode } from '../api/types';
import { useT } from '../i18n';

export function HttpModeSelect({ value, onChange, inherit = true, disabled = false }: {
  value?: HttpMode | null;
  onChange: (mode: HttpMode | null) => void;
  inherit?: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  return <select aria-label={t('httpProtocol.section')} title={t('httpProtocol.requestHelp')}
    value={value ?? ''} disabled={disabled}
    onChange={(event) => onChange((event.target.value || null) as HttpMode | null)}>
    {inherit && <option value="">{t('httpProtocol.inherit')}</option>}
    <option value="auto">{t('httpProtocol.auto')}</option>
    <option value="http1.0">{t('httpProtocol.http10')}</option>
    <option value="http1.1">{t('httpProtocol.http11')}</option>
    <option value="http2">{t('httpProtocol.http2')}</option>
  </select>;
}
