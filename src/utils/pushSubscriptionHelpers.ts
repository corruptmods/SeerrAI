import type { UserPushSubscription } from '@server/entity/UserPushSubscription';
import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import axios from 'axios';

// Taken from https://www.npmjs.com/package/web-push
function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i)
    outputArray[i] = rawData.charCodeAt(i);

  return outputArray;
}

/*
 * Whether a person chose push notifications on this device. Kept per person:
 * a device can change hands, and one person's yes is not the next person's.
 * (It was once one flag for the whole device.)
 */
const optInKey = (userId: number) => `pushNotificationsEnabled:${userId}`;

export const getPushOptIn = (userId?: number): boolean | null => {
  if (!userId) {
    return null;
  }
  try {
    localStorage.removeItem('pushNotificationsEnabled');
    const value = localStorage.getItem(optInKey(userId));
    return value === null ? null : value === 'true';
  } catch {
    return null;
  }
};

export const setPushOptIn = (userId: number | undefined, on: boolean) => {
  if (!userId) {
    return;
  }
  try {
    localStorage.setItem(optInKey(userId), String(on));
  } catch {
    // Not remembered on this device; they will be asked again.
  }
};

export const getPushSubscription = async () => {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return { registration, subscription };
};

export const verifyPushSubscription = async (
  userId: number | undefined,
  currentSettings: PublicSettingsResponse
): Promise<boolean> => {
  if (!('serviceWorker' in navigator) || !userId) {
    return false;
  }

  try {
    const { subscription } = await getPushSubscription();

    if (!subscription) {
      return false;
    }

    const appServerKey = subscription.options?.applicationServerKey;
    if (!(appServerKey instanceof ArrayBuffer)) {
      return false;
    }

    const currentServerKey = new Uint8Array(appServerKey).toString();
    const expectedServerKey = urlBase64ToUint8Array(
      currentSettings.vapidPublic
    ).toString();

    if (currentServerKey !== expectedServerKey) {
      return false;
    }

    const endpoint = subscription.endpoint;

    const { data } = await axios.get<UserPushSubscription>(
      `/api/v1/user/${userId}/pushSubscription/${encodeURIComponent(endpoint)}`
    );

    return data.endpoint === endpoint;
  } catch {
    return false;
  }
};

export const verifyAndResubscribePushSubscription = async (
  userId: number | undefined,
  currentSettings: PublicSettingsResponse
): Promise<boolean> => {
  if (!('serviceWorker' in navigator) || !userId) {
    return false;
  }

  const { subscription } = await getPushSubscription();
  const isValid = await verifyPushSubscription(userId, currentSettings);

  if (isValid) {
    return true;
  }

  if (!currentSettings.enablePushRegistration) {
    return false;
  }

  try {
    // If a browser-level subscription exists but doesn't belong to this
    // user (or has stale VAPID keys), tear it down before resubscribing.
    const oldEndpoint = subscription
      ? await unsubscribeToPushNotifications(userId)
      : null;

    await subscribeToPushNotifications(userId, currentSettings);

    if (oldEndpoint) {
      try {
        await axios.delete(
          `/api/v1/user/${userId}/pushSubscription/${encodeURIComponent(
            oldEndpoint
          )}`
        );
      } catch {
        // Ignore errors when deleting old endpoint (it might not exist)
      }
    }

    return true;
  } catch (error) {
    throw new Error(`[SW] Resubscribe failed: ${error.message}`, {
      cause: error,
    });
  }
};

// Several parts of the app can decide to subscribe at the same moment — the
// device-state hook and the worker setup both react to a missing subscription
// after a storage reset. Sharing one in-flight attempt means a single browser
// subscription and a single registration request, rather than a race that
// trips the server's unique constraint.
let inFlightSubscribe: Promise<boolean> | null = null;

export const subscribeToPushNotifications = async (
  userId: number | undefined,
  currentSettings: PublicSettingsResponse
): Promise<boolean> => {
  if (inFlightSubscribe) {
    return inFlightSubscribe;
  }

  inFlightSubscribe = subscribeToPushNotificationsOnce(
    userId,
    currentSettings
  ).finally(() => {
    inFlightSubscribe = null;
  });

  return inFlightSubscribe;
};

const subscribeToPushNotificationsOnce = async (
  userId: number | undefined,
  currentSettings: PublicSettingsResponse
): Promise<boolean> => {
  if (
    !('serviceWorker' in navigator) ||
    !userId ||
    !currentSettings.enablePushRegistration
  ) {
    return false;
  }

  try {
    const { registration } = await getPushSubscription();

    if (!registration) {
      return false;
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: currentSettings.vapidPublic,
    });

    const { endpoint, keys } = subscription.toJSON();

    if (keys?.p256dh && keys?.auth) {
      await axios.post('/api/v1/user/registerPushSubscription', {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: navigator.userAgent,
      });

      return true;
    }

    return false;
  } catch (error) {
    throw new Error(
      `Issue subscribing to push notifications: ${error.message}`,
      { cause: error }
    );
  }
};

export const unsubscribeToPushNotifications = async (
  userId: number | undefined,
  endpoint?: string
): Promise<string | null> => {
  if (!('serviceWorker' in navigator) || !userId) {
    return null;
  }

  try {
    const { subscription } = await getPushSubscription();

    if (!subscription) {
      return null;
    }

    const { endpoint: currentEndpoint } = subscription.toJSON();

    if (!endpoint || endpoint === currentEndpoint) {
      await subscription.unsubscribe();
      return currentEndpoint ?? null;
    }

    return null;
  } catch (error) {
    throw new Error(
      `Issue unsubscribing to push notifications: ${error.message}`,
      { cause: error }
    );
  }
};
