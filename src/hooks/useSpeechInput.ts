import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * Speaking into a search box, on a computer. The browser's own speech
 * recognition does the listening: nothing is recorded or sent by Seerr.
 *
 * Phones and tablets are left out on purpose. Their keyboards already have a
 * microphone that types into any field, and the iPhone does not offer speech
 * recognition to web apps added to the Home Screen at all.
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
 * A phone or tablet, whose keyboard has its own microphone. Asked of the
 * device itself rather than the pointer: a touchscreen laptop is a computer,
 * and an iPad reports itself as a Mac.
 */
export const isHandheld = (nav: {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
}): boolean =>
  nav.userAgentData?.mobile === true ||
  /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) ||
  (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1);

/** Why listening stopped early, in terms the person can act on. */
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
      // 'aborted' is someone pressing stop, or the field going away.
      return undefined;
  }
};

/** Everything heard so far, and whether the browser has settled on it. */
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
  /** BCP 47 language to listen for, such as en or pt-BR. */
  lang: string;
  /** What has been heard so far; final once the person stops speaking. */
  onText: (text: string, final: boolean) => void;
  onProblem: (problem: SpeechProblem) => void;
}

const useSpeechInput = ({ lang, onText, onProblem }: SpeechInputOptions) => {
  // Shown on any computer over HTTPS; a browser that cannot listen says so
  // when the button is pressed, rather than the button silently missing.
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const callbacks = useRef({ onText, onProblem });

  useEffect(() => {
    callbacks.current = { onText, onProblem };
  });

  // Checked after mounting: the server cannot know what the browser offers.
  useEffect(() => {
    setAvailable(
      window.isSecureContext &&
        !isHandheld(
          navigator as Navigator & { userAgentData?: { mobile?: boolean } }
        )
    );
  }, []);

  // Leaving the page, or closing the panel, stops listening.
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
      // Already listening elsewhere on the page, or refused outright.
      callbacks.current.onProblem('unavailable');
    }
  }, [lang]);

  return { available, listening, start, stop };
};

export default useSpeechInput;
