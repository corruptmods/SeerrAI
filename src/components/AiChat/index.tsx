import useAi from '@app/hooks/useAi';
import useLazyModule, { preloadModule } from '@app/hooks/useLazyModule';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { SparklesIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.AiChat', {
  open: 'AI',
  couldNotOpen:
    'The AI panel could not be opened. Check your connection and try again.',
});

// The panel and what it shows (title cards, the picker) are only needed once
// someone opens it: loaded then, or while the browser is idle, not with
// every page (FORK.md, rule 9).
const loadPanel = () =>
  import('@app/components/AiChat/AiChatPanel').then((m) => m.default);

/** The round AI button beside the search box. */
const AiChat = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { on } = useAi();
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false);
  const canSearch = on('aiChat');
  const canPick = on('aiPicker');
  const available = canSearch || canPick;

  useEffect(() => {
    if (available) {
      preloadModule(loadPanel);
    }
  }, [available]);

  const Panel = useLazyModule(loadPanel, wanted, () => {
    addToast(intl.formatMessage(messages.couldNotOpen), {
      appearance: 'error',
      autoDismiss: true,
    });
    setOpen(false);
    setWanted(false);
  });

  const close = useCallback(() => setOpen(false), []);

  if (!available) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setWanted(true);
          setOpen(true);
        }}
        className="ml-2 flex h-10 w-10 flex-none items-center justify-center rounded-full border border-gray-600 bg-gray-900/80 text-indigo-300 transition hover:border-gray-500 hover:text-indigo-200 focus:border-gray-500 focus:outline-none light:text-accent-text light:hover:text-accent-text"
        aria-label={intl.formatMessage(messages.open)}
        title={intl.formatMessage(messages.open)}
        data-testid="ai-chat-open"
      >
        <SparklesIcon className="h-5 w-5" />
      </button>
      {Panel && (
        <Panel
          open={open}
          onClose={close}
          canSearch={canSearch}
          canPick={canPick}
        />
      )}
    </>
  );
};

export default AiChat;
