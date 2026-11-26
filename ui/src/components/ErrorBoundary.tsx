/** Keep a render error from blanking the whole window, and record it. */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportError } from '../errorReporting';
import { useT } from '../i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A caught render error never reaches window.onerror.
    reportError(error, 'render', info.componentStack ?? '');
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} retry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

function ErrorFallback({ error, retry }: { error: Error; retry: () => void }) {
  const t = useT();
  return (
    <div className="error-fallback" role="alert">
      <h2>{t('errorBoundary.title')}</h2>
      <p className="muted">{t('errorBoundary.help')}</p>
      <pre className="mono">{`${error.name}: ${error.message}`}</pre>
      <div className="settings-row">
        <button type="button" onClick={retry}>{t('errorBoundary.retry')}</button>
        <button type="button" onClick={() => window.location.reload()}>
          {t('errorBoundary.reload')}
        </button>
      </div>
    </div>
  );
}
