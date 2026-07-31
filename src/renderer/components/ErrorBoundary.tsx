import React from 'react';
import { useStore } from '../store';
import { translate, isLanguage } from '../i18n';

/**
 * ErrorBoundary — stops one broken subtree from taking down the whole window.
 *
 * React unmounts the entire tree when a render throws and nothing catches it.
 * In an Electron app that means a blank window painted in the background
 * colour — indistinguishable from a hang, and only a restart clears it. wmux
 * renders data it does not own (orchestration state.json written by the
 * plugin, session snapshots, agent metadata), so a malformed payload must
 * degrade to a broken panel, never a dead app.
 *
 * Wrap the root as a last-resort net, and wrap individual data-driven panels
 * so the rest of the UI keeps working when one of them fails.
 */

interface Props {
  children: React.ReactNode;
  /** Shown in the fallback and in the console, e.g. "orchestration panel". */
  label?: string;
  /** Render nothing instead of the fallback card (for non-essential panels). */
  silent?: boolean;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      `[error-boundary] ${this.props.label ?? 'component'} crashed:`,
      error,
      info.componentStack,
    );
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.silent) return null;

    // Class component: no hooks, so read the language directly off the store
    // instead of `useT()`. Fine here — an error card re-rendering a beat late
    // after a language switch is not a concern.
    const lang = useStore.getState().language;
    const t = (key: Parameters<typeof translate>[1], fallback?: string) =>
      translate(isLanguage(lang) ? lang : 'en', key, fallback);

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary__title">
          {this.props.label
            ? t('errorBoundary.labelFailed', '{label} failed').replace('{label}', this.props.label)
            : t('errorBoundary.somethingWrong', 'Something went wrong')}
        </div>
        <div className="error-boundary__message">{error.message}</div>
        <button className="error-boundary__retry" onClick={this.reset}>
          {t('errorBoundary.retry', 'retry')}
        </button>
      </div>
    );
  }
}
