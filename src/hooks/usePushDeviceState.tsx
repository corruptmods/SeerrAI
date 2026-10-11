import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import {
  canSubscribeToPush,
  getNotificationPermission,
  isAppleMobile,
  isInAppBrowser,
  isStandalone,
} from '@app/utils/pushPlatform';
import {
  getPushOptIn,
  getPushSubscription,
  setPushOptIn,
  subscribeToPushNotifications,
} from '@app/utils/pushSubscriptionHelpers';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import useSWR from 'swr';

export type PushDeviceState =
  | 'loading'
  | 'disabled'
  | 'registered'
  | 'prompt'
  | 'denied'
  | 'blocked-by-browser'
  | 'needs-install'
  | 'webview'
  | 'unsupported';

interface PushSubscriptionRecord {
  endpoint: string;
}

interface UsePushDeviceState {
  state: PushDeviceState;
  subscribe: () => Promise<boolean>;
  revalidate: () => void;
}

/**
 * Computes the device's push state. Used once, by PushDeviceProvider; every
 * consumer reads the shared result through usePushDeviceState so the
 * service-worker subscription lookup happens once per page, not once per
 * component that happens to need it.
 */
const usePushDeviceStateInternal = (): UsePushDeviceState => {
  const { user } = useUser();
  const { currentSettings } = useSettings();
  const [state, setState] = useState<PushDeviceState>('loading');
  const [browserRejected, setBrowserRejected] = useState(false);

  const {
    data: devices,
    error: devicesError,
    mutate,
  } = useSWR<PushSubscriptionRecord[]>(
    user?.id ? `/api/v1/user/${user.id}/pushSubscriptions` : null
  );

  const resolve = useCallback(async () => {
    if (!user?.id || !currentSettings.enablePushRegistration) {
      setState('disabled');
      return;
    }

    if (!canSubscribeToPush()) {
      if (isAppleMobile() && !isStandalone()) {
        setState('needs-install');
      } else if (isInAppBrowser()) {
        setState('webview');
      } else {
        setState('unsupported');
      }
      return;
    }

    if (getNotificationPermission() === 'denied') {
      setState('denied');
      return;
    }

    if (browserRejected) {
      setState('blocked-by-browser');
      return;
    }

    if (!devices && !devicesError) {
      return;
    }

    const knownDevices = devices ?? [];

    const { subscription } = await getPushSubscription();
    const isRegistered =
      !!subscription &&
      knownDevices.some((device) => device.endpoint === subscription.endpoint);

    if (isRegistered) {
      // Registered, so at some point they said yes on this device.
      setPushOptIn(user.id, true);
      setState('registered');
      return;
    }

    const optedIn = getPushOptIn(user.id) === true;

    // This device is still subscribed, but not for the person now signed in:
    // it belongs to whoever used it before. Let it go, so their
    // notifications stop arriving here (the server drops a subscription once
    // the push service reports it gone). Only when the list of this person's
    // devices actually loaded, or a failed lookup would look the same.
    if (subscription && !optedIn && !devicesError) {
      try {
        await subscription.unsubscribe();
      } catch {
        // Tried again on the next visit.
      }
    }

    // Subscribe without asking only someone who chose it on this device
    // before: the browser's permission is the device's, not the person's.
    if (optedIn && getNotificationPermission() === 'granted') {
      try {
        const subscribed = await subscribeToPushNotifications(
          user.id,
          currentSettings
        );

        if (subscribed) {
          await mutate();
          setState('registered');
          return;
        }
      } catch {
        setBrowserRejected(true);
        setState('blocked-by-browser');
        return;
      }
    }

    setState('prompt');
  }, [
    user?.id,
    currentSettings,
    devices,
    devicesError,
    browserRejected,
    mutate,
  ]);

  useEffect(() => {
    resolve();
  }, [resolve]);

  const subscribe = useCallback(async () => {
    if (!user?.id) {
      return false;
    }

    try {
      const subscribed = await subscribeToPushNotifications(
        user.id,
        currentSettings
      );

      if (!subscribed) {
        setBrowserRejected(true);
        setState('blocked-by-browser');
        return false;
      }

      setPushOptIn(user.id, true);
      await mutate();
      setState('registered');
      return true;
    } catch {
      if (getNotificationPermission() === 'denied') {
        setState('denied');
      } else {
        setBrowserRejected(true);
        setState('blocked-by-browser');
      }
      return false;
    }
  }, [user?.id, currentSettings, mutate]);

  return { state, subscribe, revalidate: mutate };
};

const PushDeviceContext = createContext<UsePushDeviceState | null>(null);

export const PushDeviceProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const value = usePushDeviceStateInternal();

  return (
    <PushDeviceContext.Provider value={value}>
      {children}
    </PushDeviceContext.Provider>
  );
};

const usePushDeviceState = (): UsePushDeviceState => {
  const context = useContext(PushDeviceContext);

  if (!context) {
    throw new Error(
      'usePushDeviceState must be used within PushDeviceProvider'
    );
  }

  return context;
};

export default usePushDeviceState;
