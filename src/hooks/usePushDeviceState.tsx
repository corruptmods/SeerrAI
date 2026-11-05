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
import axios from 'axios';
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
  /** Stops this device's notifications for the signed-in user. */
  unsubscribe: () => Promise<boolean>;
  revalidate: () => void;
}

/**
 * Computes the device's push state. Used only by PushDeviceProvider; others
 * read it via usePushDeviceState, so the subscription lookup runs once per page.
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
      // Registered, so they opted in on this device at some point.
      setPushOptIn(user.id, true);
      setState('registered');
      return;
    }

    const optedIn = getPushOptIn(user.id) === true;

    // Subscribed, but for a previous user: unsubscribe so their notifications
    // stop arriving here (the server drops it once the push service reports
    // it gone). Only when the device list loaded, since a failed lookup looks
    // the same.
    if (subscription && !optedIn && !devicesError) {
      try {
        await subscription.unsubscribe();
      } catch {
        // Retried next visit.
      }
    }

    // Auto-subscribe only users who opted in on this device: browser
    // permission is per device, not per user.
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

  const unsubscribe = useCallback(async () => {
    if (!user?.id) {
      return false;
    }

    try {
      const { subscription } = await getPushSubscription();
      const endpoint = subscription?.endpoint;

      // Only delete their own; another user's leftover subscription is
      // dropped above, not removed from the server under this user's name.
      if (
        subscription &&
        endpoint &&
        (devices ?? []).some((device) => device.endpoint === endpoint)
      ) {
        await subscription.unsubscribe();
        try {
          await axios.delete(
            `/api/v1/user/${user.id}/pushSubscription/${encodeURIComponent(
              endpoint
            )}`
          );
        } catch {
          // The server drops it once the push service reports it gone.
        }
      }

      // Stored, so the device doesn't auto-resubscribe.
      setPushOptIn(user.id, false);
      await mutate();
      setState('prompt');
      return true;
    } catch {
      return false;
    }
  }, [user?.id, devices, mutate]);

  return { state, subscribe, unsubscribe, revalidate: mutate };
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
