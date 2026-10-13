import SlideOver from '@app/components/Common/SlideOver';
import useAi, { aiErrorMessage } from '@app/hooks/useAi';
import defineMessages from '@app/utils/defineMessages';
import { useCallback, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.AiPanel', {
  thinking: 'Thinking…',
  failed: 'That did not work. Try again.',
  remaining: '{count, plural, one {# answer} other {# answers}} left today',
});

/**
 * Asking the model something from a page: whether it is busy, the answer,
 * or why there is none, and the count left today kept up to date.
 */
export const useAiAnswer = <T,>() => {
  const intl = useIntl();
  const { refresh } = useAi();
  const [state, setState] = useState<{
    busy: boolean;
    answer?: T;
    error?: string;
  }>({ busy: false });

  const ask = useCallback(
    async (run: () => Promise<T>) => {
      setState({ busy: true });
      try {
        setState({ busy: false, answer: await run() });
      } catch (e) {
        setState({
          busy: false,
          error: aiErrorMessage(e, intl.formatMessage(messages.failed), intl),
        });
      } finally {
        refresh();
      }
    },
    [intl, refresh]
  );

  return { ...state, ask, reset: () => setState({ busy: false }) };
};

/** The side panel an AI answer is shown in, with its busy and error states. */
const AiPanel = ({
  show,
  title,
  onClose,
  busy,
  error,
  children,
}: {
  show: boolean;
  title: string;
  onClose: () => void;
  busy: boolean;
  error?: string;
  children?: React.ReactNode;
}) => {
  const intl = useIntl();
  const { remaining } = useAi();
  return (
    <SlideOver
      show={show}
      title={title}
      subText={
        remaining === null
          ? undefined
          : intl.formatMessage(messages.remaining, { count: remaining })
      }
      onClose={onClose}
    >
      <div className="space-y-4 text-sm text-gray-200" data-testid="ai-panel">
        {busy && (
          <div className="animate-pulse text-gray-400">
            {intl.formatMessage(messages.thinking)}
          </div>
        )}
        {error && (
          <div
            className="rounded-lg border border-red-700 bg-red-900/40 px-3 py-2 text-red-100"
            role="alert"
          >
            {error}
          </div>
        )}
        {children}
      </div>
    </SlideOver>
  );
};

export default AiPanel;
