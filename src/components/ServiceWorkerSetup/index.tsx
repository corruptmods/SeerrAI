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
    // Cached assets are evicted at the browser's discretion unless storage is
    // marked persistent. Installed web apps are hit hardest by this: the app
    // goes cold and re-downloads the whole bundle. Safari only grants the
    // request once notification permission exists, so ask after that is known.
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
        // Persistence is an optimisation; carry on without it.
      }
    };

    if ('serviceWorker' in navigator && user?.id) {
      requestPersistentStorage();

      // Installed web apps on iOS do not reliably run the update check on
      // launch, so ask for one explicitly now and every time the app returns
      // to the foreground.
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

          // Ask the worker to warm its chunk cache, but only once the page has
          // settled. Doing it on activation meant a megabyte of downloads
          // competing with the data the page needs to render, which on a cold
          // start left the app spinning.
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

          // Reset the notifications flag if permissions were revoked
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

          // Bypass resubscribing if we have manually disabled push notifications
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
