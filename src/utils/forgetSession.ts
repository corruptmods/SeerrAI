/**
 * Clears what one person's session leaves on a device that the next person
 * could see: search text typed into page filters (kept for the tab), the
 * service worker's copy of their home page rows, and their notifications and
 * app badge. Used both when someone signs out and when a session ends on its
 * own. Every part is best effort, and the whole is bounded in time so it can
 * never hold up getting to the sign-in page.
 */
const forgetSession = async (): Promise<void> => {
  const work = async () => {
    try {
      sessionStorage.clear();
    } catch {
      // Storage unavailable: nothing was kept.
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
