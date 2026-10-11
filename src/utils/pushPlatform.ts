const APPLE_MOBILE_UA = /iPad|iPhone|iPod/;

const IN_APP_BROWSER_UA =
  /FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|MicroMessenger|DiscordAndroid|GSA\/|; wv\)/;

export const isAppleMobile = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const ua = navigator.userAgent;

  if (APPLE_MOBILE_UA.test(ua)) {
    return true;
  }

  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
};

export const isStandalone = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
};

export const isInAppBrowser = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return IN_APP_BROWSER_UA.test(navigator.userAgent);
};

export const canSubscribeToPush = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
};

export const getNotificationPermission = (): NotificationPermission | null => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }

  return Notification.permission;
};
