import defineMessages from '@app/utils/defineMessages';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.RowBoundary', {
  failed: 'This row could not be shown.',
  retry: 'Try again',
});

const Failed = ({ error, onRetry }: { error: Error; onRetry: () => void }) => {
  const intl = useIntl();

  return (
    <div className="my-4 flex items-start gap-2 rounded-md border border-gray-700 bg-gray-800 p-3 text-sm text-gray-300">
      <ExclamationTriangleIcon className="h-5 w-5 flex-none text-warning-text" />
      <div className="min-w-0 flex-1">
        <p>{intl.formatMessage(messages.failed)}</p>
        {/* Said on screen: on a phone there is no console to read it from. */}
        <p className="mt-1 break-words text-xs text-gray-400">
          {`${error.name}: ${error.message}`.slice(0, 300)}
        </p>
      </div>
      <button
        className="flex-none text-indigo-400 hover:text-indigo-300 light:text-accent-text light:hover:text-accent-text"
        onClick={onRetry}
        type="button"
      >
        {intl.formatMessage(messages.retry)}
      </button>
    </div>
  );
};

interface RowBoundaryProps {
  /** What the row is, for the log. */
  name: string;
  children: ReactNode;
}

/**
 * Keeps one row that fails to draw from taking the whole page with it: the
 * row says what went wrong and the rest of the page carries on.
 */
class RowBoundary extends Component<RowBoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`Row "${this.props.name}" failed to draw`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <Failed
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }

    return this.props.children;
  }
}

export default RowBoundary;
