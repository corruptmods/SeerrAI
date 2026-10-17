import type { SpeechProblem } from '@app/hooks/useSpeechInput';
import useSpeechInput from '@app/hooks/useSpeechInput';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { MicrophoneIcon } from '@heroicons/react/24/outline';
import { useCallback } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.VoiceInput', {
  speak: 'Speak instead of typing',
  stop: 'Stop listening',
  unsupported:
    'This browser can’t listen. Speaking a search works in Chrome, Edge and Safari.',
  blocked:
    'The microphone is blocked for this site. Allow it in the browser’s site settings to speak your search.',
  unavailable:
    'This browser can’t listen right now. On a Mac, Dictation needs to be turned on in System Settings.',
  noSpeech:
    'Didn’t hear anything. Try again a little closer to the microphone.',
  noMicrophone: 'No microphone was found.',
  network: 'The browser’s speech service couldn’t be reached.',
});

/**
 * Speech for a text field: what is heard is passed to `onText` as it comes,
 * and any trouble is shown as a toast.
 */
export const useVoiceInput = (
  onText: (text: string, final: boolean) => void
) => {
  const intl = useIntl();
  const { addToast } = useToasts();

  const onProblem = useCallback(
    (problem: SpeechProblem) =>
      addToast(intl.formatMessage(messages[problem]), {
        appearance: problem === 'noSpeech' ? 'info' : 'warning',
        autoDismiss: true,
      }),
    [addToast, intl]
  );

  const { available, listening, start, stop } = useSpeechInput({
    lang: intl.locale,
    onText,
    onProblem,
  });

  const toggle = useCallback(
    () => (listening ? stop() : start()),
    [listening, start, stop]
  );

  return { available, listening, toggle };
};

interface VoiceInputButtonProps {
  listening: boolean;
  onToggle: () => void;
  className?: string;
}

/** The microphone button beside a text field. */
const VoiceInputButton = ({
  listening,
  onToggle,
  className = '',
}: VoiceInputButtonProps) => {
  const intl = useIntl();
  const label = intl.formatMessage(listening ? messages.stop : messages.speak);

  return (
    <button
      type="button"
      onClick={onToggle}
      // Keeps focus, and the caret, in the field being spoken into.
      onMouseDown={(e) => e.preventDefault()}
      aria-label={label}
      aria-pressed={listening}
      title={label}
      className={`flex flex-none items-center justify-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
        listening
          ? 'animate-pulse bg-red-600 text-white'
          : 'text-gray-400 hover:text-strong'
      } ${className}`}
    >
      <MicrophoneIcon className="h-5 w-5" />
    </button>
  );
};

export default VoiceInputButton;
