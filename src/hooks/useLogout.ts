import { useUser } from '@app/hooks/useUser';
import forgetSession from '@app/utils/forgetSession';
import { unsubscribeToPushNotifications } from '@app/utils/pushSubscriptionHelpers';
import axios from 'axios';

const PUSH_CLEANUP_REQUEST_TIMEOUT_MS = 3000;
// exceeds the request timeout so that fires first; the remainder covers the
// unsubscribe step, whose serviceWorker.ready never settles without an active
// registration
const PUSH_CLEANUP_TOTAL_TIMEOUT_MS = PUSH_CLEANUP_REQUEST_TIMEOUT_MS + 2000;

/**
 * Signs the current user out.
 *
 * Shared by the user menu and the expired-Plex-sign-in warning. It must stay
 * one implementation: signing out also unsubscribes this device from push, so
 * the next person to sign in on it does not receive the previous user's
 * notifications. A second, simpler copy would skip that.
 */
const useLogout = (): (() => Promise<void>) => {
  const { user, revalidate } = useUser();

  return async (): Promise<void> => {
    const cleanUpPushSubscription = async () => {
      try {
        const unsubscribedEndpoint = await unsubscribeToPushNotifications(
          user?.id
        );

        if (unsubscribedEndpoint) {
          await axios.delete(
            `/api/v1/user/${user?.id}/pushSubscription/${encodeURIComponent(
              unsubscribedEndpoint
            )}`,
            { timeout: PUSH_CLEANUP_REQUEST_TIMEOUT_MS }
          );
        }
      } catch {
        // continue logout regardless
      }
    };

    await Promise.race([
      cleanUpPushSubscription(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, PUSH_CLEANUP_TOTAL_TIMEOUT_MS);
      }),
    ]);

    // Their choice stays with their own id, for when they sign in again; the
    // device's subscription itself was just removed above.

    // A device can change hands: nothing of this session's should outlast
    // signing out.
    await forgetSession();

    const response = await axios.post('/api/v1/auth/logout');

    if (response.data?.status === 'ok') {
      revalidate();
    }
  };
};

export default useLogout;
