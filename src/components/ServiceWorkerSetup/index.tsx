/* eslint-disable no-console */

import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import {
  getPushOptIn,
  setPushOptIn,
  verifyAndResubscribePushSubscription,
} from '@app/utils/pushSubscriptionHelpers';
import { useEffect } from 'react';

const ServiceWorkerSetup = () => {
  const { user } = useUser();
  const { currentSettings } = useSettings();

  useEffect(() => {
    // Without persistent storage the browser may evict cached assets and an
    // installed app re-downloads the bundle. Safari grants it only after
    // notification permission, so ask once that is known.
    const requestPersistentStorage = async () => {
      if (!navigator.storage?.persist || !navigator.storage?.persisted) {
        return;
      }

      try {
        if (await navigator.storage.persisted()) {
          return;
        }

        await navigator.storage.persist();
      } catch {
        // Optional optimisation.
      }
    };

    if ('serviceWorker' in navigator && user?.id) {
      requestPersistentStorage();

      // iOS installed apps don't reliably check for updates on launch, so
      // check now and on every return to the foreground.
      let registrationRef: ServiceWorkerRegistration | undefined;
      const onVisible = () => {
        if (document.visibilityState === 'visible') {
          registrationRef?.update().catch(() => undefined);
        }
      };
      document.addEventListener('visibilitychange', onVisible);

      navigator.serviceWorker
        .register(`/sw.js?v=${process.env.commitTag ?? 'local'}`, {
          updateViaCache: 'none',
        })
        .then(async (registration) => {
          registrationRef = registration;
          registration.update().catch(() => undefined);

          // Warm the chunk cache only once the page has settled, so it
          // doesn't compete with the page's own data on a cold start.
          const warmChunkCache = () => {
            const target =
              navigator.serviceWorker.controller ?? registration.active;

            target?.postMessage({ type: 'PRECACHE_ROUTES' });
          };

          const whenIdle = (run: () => void) => {
            const idle = (
              window as unknown as {
                requestIdleCallback?: (cb: () => void, opts?: object) => void;
              }
            ).requestIdleCallback;

            if (idle) {
              idle(run, { timeout: 10000 });
            } else {
              window.setTimeout(run, 5000);
            }
          };

          if (document.readyState === 'complete') {
            whenIdle(warmChunkCache);
          } else {
            window.addEventListener('load', () => whenIdle(warmChunkCache), {
              once: true,
            });
          }
          console.log(
            '[SW] Registration successful, scope is:',
            registration.scope
          );

          const pushNotificationsEnabled = getPushOptIn(user.id) === true;

          // Reset the opt-in if permission was revoked.
          if (
            Notification.permission !== 'granted' &&
            pushNotificationsEnabled
          ) {
            setPushOptIn(user.id, false);
            console.warn(
              '[SW] Push permissions not granted — skipping resubscribe'
            );

            return;
          }

          // Don't resubscribe if push was turned off.
          if (!pushNotificationsEnabled) {
            return;
          }

          const subscription = await registration.pushManager.getSubscription();

          console.log(
            '[SW] Existing push subscription:',
            subscription?.endpoint
          );

          const verified = await verifyAndResubscribePushSubscription(
            user.id,
            currentSettings
          );

          if (verified) {
            console.log('[SW] Push subscription verified or refreshed.');
          } else {
            console.warn(
              '[SW] Push subscription verification failed or not available.'
            );
          }
        })
        .catch(function (error) {
          console.log('[SW] Service worker registration failed, error:', error);
        });

      return () => {
        document.removeEventListener('visibilitychange', onVisible);
      };
    }
  }, [currentSettings, user]);
  return null;
};

export default ServiceWorkerSetup;
