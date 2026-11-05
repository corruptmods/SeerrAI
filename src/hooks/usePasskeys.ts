import axios from 'axios';
import { useEffect, useState } from 'react';

/*
 * The passkey library loads on demand, not with every page. Support checks
 * ask the browser directly.
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
 * Preloads the passkey library. Safari only allows the prompt shortly after
 * the tap, so it must be loaded by then.
 */
export const preloadPasskeys = (): void => {
  if (browserSupportsWebAuthn()) {
    loadWebAuthn().catch(() => undefined);
  }
};

/**
 * Whether the browser supports passkeys and the device has a platform
 * authenticator (Face ID, Touch ID, Windows Hello…). Undefined until checked
 * after mount.
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

/** Whether the user cancelled or had no passkey; the system already said so, so don't show an error. */
export const isCancelled = (e: unknown): boolean => {
  // WebAuthnError has a code, and the browser's named error as its cause.
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

/** Registers a passkey on this device for the signed-in user. */
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

/** Signs in with whichever passkey the device offers. */
export const signInWithPasskey = async (): Promise<void> => {
  const [{ startAuthentication }, options] = await Promise.all([
    loadWebAuthn(),
    axios.post('/api/v1/auth/passkey/login/options'),
  ]);
  const response = await startAuthentication({ optionsJSON: options.data });
  await axios.post('/api/v1/auth/passkey/login', { response });
};
