import { useUser } from '@app/hooks/useUser';
import forgetSession from '@app/utils/forgetSession';
import { unsubscribeToPushNotifications } from '@app/utils/pushSubscriptionHelpers';
import axios from 'axios';

const PUSH_CLEANUP_REQUEST_TIMEOUT_MS = 3000;
// Longer than the request timeout so that fires first; the rest covers
// unsubscribing, whose serviceWorker.ready never settles without a registration.
const PUSH_CLEANUP_TOTAL_TIMEOUT_MS = PUSH_CLEANUP_REQUEST_TIMEOUT_MS + 2000;

/**
 * Signs the current user out.
 *
 * Keep this the only implementation: it also unsubscribes the device from
 * push, so the next user doesn't get the previous user's notifications.
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
        // Continue logout regardless.
      }
    };

    await Promise.race([
      cleanUpPushSubscription(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, PUSH_CLEANUP_TOTAL_TIMEOUT_MS);
      }),
    ]);

    // The push opt-in stays under their user id for next sign-in; the device
    // subscription was removed above. Nothing else of the session may outlast
    // sign-out on a shared device.
    await forgetSession();

    const response = await axios.post('/api/v1/auth/logout');

    if (response.data?.status === 'ok') {
      revalidate();
    }
  };
};

export default useLogout;
