import { plexSignInMessage } from '@app/components/Login/plexSignInMessages';
import useSettings from '@app/hooks/useSettings';
import PlexOAuth, { PlexSignInError } from '@app/utils/plex';
import type { PlexSignInPurpose } from '@app/utils/plexSameTab';
import {
  PLEX_RETURN_PARAM,
  clearPendingPlexSignIn,
  plexReturnOf,
  readPendingPlexSignIn,
  sessionStore,
  withoutPlexReturn,
} from '@app/utils/plexSameTab';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const plexOAuth = new PlexOAuth();

/**
 * Plex sign-in: in a popup where possible, otherwise in this tab returning to
 * the same page. Delivers the token via `onAuthToken`, or a readable reason
 * via `onError`.
 */
function usePlexLogin({
  purpose,
  onAuthToken,
  onError,
  enabled = true,
}: {
  /** The sign-in's purpose; the page that starts it finishes it. */
  purpose: PlexSignInPurpose;
  /** False when this page isn't signing in with Plex. */
  enabled?: boolean;
  onAuthToken: (authToken: string) => void;
  onError: (message: string) => void;
}) {
  const intl = useIntl();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const { currentSettings } = useSettings();
  const clientIdentifier = currentSettings.plexClientIdentifier;

  // Latest callbacks, so the return handling runs once, not each render.
  const onAuthTokenRef = useRef(onAuthToken);
  const onErrorRef = useRef(onError);
  onAuthTokenRef.current = onAuthToken;
  onErrorRef.current = onError;

  // The last handled return, so each is handled once.
  const handled = useRef<string | null>(null);

  const getPlexLogin = async () => {
    try {
      const authToken = await plexOAuth.login(clientIdentifier, purpose);
      if (authToken === undefined) {
        // Navigating to Plex in this tab.
        return;
      }
      setLoading(false);
      onAuthTokenRef.current(authToken);
    } catch (e) {
      setLoading(false);
      onErrorRef.current(plexSignInMessage(intl, e));
    }
  };

  const login = () => {
    handled.current = null;
    // Must open synchronously from the tap, or the browser blocks it.
    plexOAuth.preparePopup();
    setLoading(true);
    setTimeout(() => getPlexLogin(), 1500);
  };

  // Back from Plex in this tab (signed in or not): finish this tab's sign-in.
  const finishReturn = useCallback(async () => {
    if (!enabled) return;
    const store = sessionStore();
    const param = new URLSearchParams(window.location.search).get(
      PLEX_RETURN_PARAM
    );
    const outcome = plexReturnOf(
      param,
      readPendingPlexSignIn(store),
      purpose,
      Date.now()
    );
    if (outcome.kind === 'none') {
      return;
    }
    // Keyed by the PIN id while it is in the URL, so a repeat check does nothing.
    const key = param ? `pin:${param}` : outcome.kind;
    if (handled.current === key) {
      return;
    }
    handled.current = key;

    // A PIN is single-use; its id is removed from the URL.
    clearPendingPlexSignIn(store);
    if (param) {
      router.replace(withoutPlexReturn(window.location.href), undefined, {
        shallow: true,
        scroll: false,
      });
    }

    if (outcome.kind !== 'check') {
      setLoading(false);
      onErrorRef.current(
        plexSignInMessage(intl, new PlexSignInError(outcome.kind))
      );
      return;
    }

    setLoading(true);
    try {
      const authToken = await plexOAuth.finishSameTab(
        clientIdentifier,
        outcome.pending
      );
      setLoading(false);
      onAuthTokenRef.current(authToken);
    } catch (e) {
      setLoading(false);
      onErrorRef.current(plexSignInMessage(intl, e));
    }
  }, [clientIdentifier, enabled, intl, purpose, router]);

  useEffect(() => {
    finishReturn();
    // A page restored by Back (bfcache) keeps its state, so the button would still be waiting.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setLoading(false);
        finishReturn();
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [finishReturn]);

  return { loading, login };
}

export default usePlexLogin;
