import type { SubtitleSearchModalProps } from '@app/components/Subtitles/SubtitleSearchModal';
import type { TranscribeModalProps } from '@app/components/Subtitles/TranscribeModal';
import useLazyModule from '@app/hooks/useLazyModule';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';

/*
 * The search and transcribe dialogs load only when opened: they matter to
 * the few who manage subtitles, on a page everyone opens.
 */

const messages = defineMessages('components.Subtitles.dialogs', {
  couldNotOpen:
    'That could not be opened. Check your connection and try again.',
});

const loadSearch = () =>
  import('@app/components/Subtitles/SubtitleSearchModal');
const loadTranscribe = () =>
  import('@app/components/Subtitles/TranscribeModal');

const Fade = ({ show, children }: { show: boolean; children: ReactNode }) => (
  <Transition
    as="div"
    show={show}
    enter="transition-opacity duration-300"
    enterFrom="opacity-0"
    enterTo="opacity-100"
    leave="transition-opacity duration-300"
    leaveFrom="opacity-100"
    leaveTo="opacity-0"
  >
    {children}
  </Transition>
);

const useCouldNotOpen = (onClose: () => void) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  return () => {
    addToast(intl.formatMessage(messages.couldNotOpen), {
      appearance: 'error',
      autoDismiss: true,
    });
    onClose();
  };
};

export const SearchDialog = ({
  open,
  ...props
}: SubtitleSearchModalProps & { open: boolean }) => {
  const loaded = useLazyModule(
    loadSearch,
    open,
    useCouldNotOpen(props.onClose)
  );
  const Dialog = loaded?.default;
  return <Fade show={open}>{Dialog && <Dialog {...props} />}</Fade>;
};

export const TranscribeDialog = ({
  open,
  ...props
}: TranscribeModalProps & { open: boolean }) => {
  const loaded = useLazyModule(
    loadTranscribe,
    open,
    useCouldNotOpen(props.onClose)
  );
  const Dialog = loaded?.default;
  return <Fade show={open}>{Dialog && <Dialog {...props} />}</Fade>;
};
