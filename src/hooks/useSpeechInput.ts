import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * Voice search on computers, via the browser's speech recognition; Seerr
 * records and sends nothing.
 *
 * Phones and tablets are excluded: their keyboards have dictation, and iOS
 * offers no speech recognition to Home Screen web apps.
 */

interface RecognitionAlternative {
  transcript: string;
}

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative;
}

interface RecognitionEvent {
  readonly results: {
    readonly length: number;
    [index: number]: RecognitionResult;
  };
}

interface RecognitionErrorEvent {
  readonly error: string;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type RecognitionConstructor = new () => Recognition;

const recognitionConstructor = (): RecognitionConstructor | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
};

/**
 * Whether this is a phone or tablet. Checks the device, not the pointer: a
 * touchscreen laptop is a computer, and an iPad reports as a Mac.
 */
export const isHandheld = (nav: {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
}): boolean =>
  nav.userAgentData?.mobile === true ||
  /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) ||
  (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1);

/** Why listening stopped early, in actionable terms. */
export type SpeechProblem =
  | 'unsupported'
  | 'blocked'
  | 'unavailable'
  | 'noSpeech'
  | 'noMicrophone'
  | 'network';

export const problemOf = (error: string): SpeechProblem | undefined => {
  switch (error) {
    case 'not-allowed':
      return 'blocked';
    case 'service-not-allowed':
    case 'language-not-supported':
      return 'unavailable';
    case 'no-speech':
      return 'noSpeech';
    case 'audio-capture':
      return 'noMicrophone';
    case 'network':
      return 'network';
    default:
      // 'aborted': stop pressed or field unmounted.
      return undefined;
  }
};

/** The transcript so far, and whether it is final. */
export const transcriptOf = (
  results: RecognitionEvent['results']
): { text: string; final: boolean } => {
  let text = '';
  let final = true;
  for (let i = 0; i < results.length; i++) {
    text += results[i][0]?.transcript ?? '';
    final = final && results[i].isFinal;
  }
  return { text: text.trim(), final };
};

interface SpeechInputOptions {
  /** BCP 47 language, e.g. en or pt-BR. */
  lang: string;
  /** Transcript so far; final once speech stops. */
  onText: (text: string, final: boolean) => void;
  onProblem: (problem: SpeechProblem) => void;
}

const useSpeechInput = ({ lang, onText, onProblem }: SpeechInputOptions) => {
  // Shown on any computer over HTTPS; unsupported browsers report it on
  // press rather than hiding the button.
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const callbacks = useRef({ onText, onProblem });

  useEffect(() => {
    callbacks.current = { onText, onProblem };
  });

  // After mount: the server can't know browser support.
  useEffect(() => {
    setAvailable(
      window.isSecureContext &&
        !isHandheld(
          navigator as Navigator & { userAgentData?: { mobile?: boolean } }
        )
    );
  }, []);

  // Stop listening on unmount.
  useEffect(() => () => recognition.current?.abort(), []);

  const stop = useCallback(() => {
    recognition.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      callbacks.current.onProblem('unsupported');
      return;
    }
    if (recognition.current) {
      return;
    }

    const listener = new Constructor();
    listener.lang = lang;
    listener.continuous = false;
    listener.interimResults = true;
    listener.maxAlternatives = 1;

    listener.onresult = (event) => {
      const { text, final } = transcriptOf(event.results);
      callbacks.current.onText(text, final);
    };
    listener.onerror = (event) => {
      const problem = problemOf(event.error);
      if (problem) {
        callbacks.current.onProblem(problem);
      }
    };
    listener.onend = () => {
      recognition.current = null;
      setListening(false);
    };

    try {
      listener.start();
      recognition.current = listener;
      setListening(true);
    } catch {
      // Already listening elsewhere, or refused.
      callbacks.current.onProblem('unavailable');
    }
  }, [lang]);

  return { available, listening, start, stop };
};

export default useSpeechInput;
