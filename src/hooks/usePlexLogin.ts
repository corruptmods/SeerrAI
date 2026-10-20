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
 * Signing in with Plex, for every page that does: in a Plex window where
 * one can be opened (the page stays as it is), otherwise in this tab, coming
 * back to the same page, which finishes what it started. Either way the
 * page gets the Plex token through `onAuthToken`, or a message saying in
 * plain words why not through `onError`.
 */
function usePlexLogin({
  purpose,
  onAuthToken,
  onError,
  enabled = true,
}: {
  /** What the sign-in is for: the page that starts it finishes it. */
  purpose: PlexSignInPurpose;
  /** False where this page is not signing in with Plex this time. */
  enabled?: boolean;
  onAuthToken: (authToken: string) => void;
  onError: (message: string) => void;
}) {
  const intl = useIntl();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const { currentSettings } = useSettings();
  const clientIdentifier = currentSettings.plexClientIdentifier;

  // The latest callbacks, so the return below runs once, not on each render.
  const onAuthTokenRef = useRef(onAuthToken);
  const onErrorRef = useRef(onError);
  onAuthTokenRef.current = onAuthToken;
  onErrorRef.current = onError;

  // The return last dealt with, so each is dealt with once.
  const handled = useRef<string | null>(null);

  const getPlexLogin = async () => {
    try {
      const authToken = await plexOAuth.login(clientIdentifier, purpose);
      if (authToken === undefined) {
        // On the way to Plex in this tab: the page is being left.
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
    // Opened straight from the tap, or the browser blocks it.
    plexOAuth.preparePopup();
    setLoading(true);
    setTimeout(() => getPlexLogin(), 1500);
  };

  // Back from Plex in this tab (or back from it without signing in): finish
  // the sign-in this tab started here.
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
    // By the PIN id in the address while it is still there (it leaves
    // shortly after), so a second look at the same return does nothing.
    const key = param ? `pin:${param}` : outcome.kind;
    if (handled.current === key) {
      return;
    }
    handled.current = key;

    // A PIN is used once, and its id leaves the address.
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
    // A page brought back by the browser's Back button keeps its state, so
    // the button would still be waiting for Plex.
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
