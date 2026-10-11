import axios from 'axios';
import { useEffect, useState } from 'react';

/*
 * The passkey library is only needed at the moment someone makes or uses a
 * passkey, so it is fetched then, not with every page. Whether the browser
 * can do passkeys at all is asked of the browser directly.
 */
const loadWebAuthn = () => import('@simplewebauthn/browser');

const browserSupportsWebAuthn = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential === 'function';

export interface Passkey {
  id: number;
  name: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Fetches the passkey library ahead of a passkey button being pressed. Safari
 * only allows a passkey prompt shortly after the tap that asked for it, so
 * the library should already be here by then.
 */
export const preloadPasskeys = (): void => {
  if (browserSupportsWebAuthn()) {
    loadWebAuthn().catch(() => undefined);
  }
};

/**
 * Whether this browser can use passkeys at all, and whether this device can
 * make one itself (Face ID, Touch ID, Windows Hello, a phone's screen lock).
 * Undefined until checked, which happens after mounting.
 */
export const usePasskeySupport = () => {
  const [support, setSupport] = useState<{
    supported?: boolean;
    onThisDevice?: boolean;
  }>({});

  useEffect(() => {
    let cancelled = false;
    const supported = browserSupportsWebAuthn();
    if (!supported) {
      setSupport({ supported: false, onThisDevice: false });
      return;
    }
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .catch(() => false)
      .then((onThisDevice) => {
        if (!cancelled) {
          setSupport({ supported: true, onThisDevice });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return support;
};

/**
 * Someone closing the system passkey sheet, or a device with no passkey for
 * this site, is not an error worth showing: the system already said so.
 */
export const isCancelled = (e: unknown): boolean => {
  // The library's WebAuthnError says why with a code, and carries the
  // browser's own error, named, as its cause.
  if (
    (e as { code?: unknown } | undefined)?.code === 'ERROR_CEREMONY_ABORTED'
  ) {
    return true;
  }
  const nameOf = (value: unknown) =>
    (value as { name?: unknown } | undefined)?.name;
  return [e, (e as { cause?: unknown } | undefined)?.cause]
    .map(nameOf)
    .some((name) => name === 'NotAllowedError' || name === 'AbortError');
};

/** Make a passkey on this device for whoever is signed in. */
export const addPasskey = async (): Promise<Passkey> => {
  const [{ startRegistration }, options] = await Promise.all([
    loadWebAuthn(),
    axios.post('/api/v1/auth/passkey/register/options'),
  ]);
  const response = await startRegistration({ optionsJSON: options.data });
  const saved = await axios.post<Passkey>('/api/v1/auth/passkey/register', {
    response,
  });
  return saved.data;
};

/** Sign in with whichever passkey the device offers for this site. */
export const signInWithPasskey = async (): Promise<void> => {
  const [{ startAuthentication }, options] = await Promise.all([
    loadWebAuthn(),
    axios.post('/api/v1/auth/passkey/login/options'),
  ]);
  const response = await startAuthentication({ optionsJSON: options.data });
  await axios.post('/api/v1/auth/passkey/login', { response });
};
