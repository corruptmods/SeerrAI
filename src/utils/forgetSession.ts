/**
 * Clears session data the next user on the device could see: tab-stored
 * filter text, the service worker's Discover rows, notifications and the app
 * badge. Used on sign-out and on session expiry. Best effort and time-bounded
 * so it never delays reaching sign-in.
 */
const forgetSession = async (): Promise<void> => {
  const work = async () => {
    try {
      sessionStorage.clear();
    } catch {
      // Storage unavailable: nothing stored.
    }

    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('discover-'))
          .map((name) => caches.delete(name))
      );
    } catch {
      // The service worker also empties it on the next sign-in.
    }

    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      const shown = (await registration?.getNotifications()) ?? [];
      shown.forEach((notification) => notification.close());
    } catch {
      // No notifications to close.
    }

    try {
      await (
        navigator as unknown as { clearAppBadge?: () => Promise<void> }
      ).clearAppBadge?.();
    } catch {
      // No badge support.
    }
  };

  await Promise.race([
    work(),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);
};

export default forgetSession;
