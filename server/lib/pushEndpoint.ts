/*
 * The push services browsers hand out subscriptions on: Chrome, Edge's
 * Chromium builds, Opera, Brave and Samsung Internet (Google's FCM),
 * Firefox (Mozilla), Safari (Apple) and older Edge (Windows). Seerr posts
 * every web push notification to the address a browser registered, so an
 * address anywhere else (a machine on the home network, the server itself)
 * is refused rather than called.
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com'];
const PUSH_DOMAINS = [
  '.push.services.mozilla.com',
  '.push.apple.com',
  '.notify.windows.com',
];

/** Whether this is a browser push service's https address. */
export const isPushServiceEndpoint = (endpoint: unknown): boolean => {
  if (typeof endpoint !== 'string') {
    return false;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    PUSH_HOSTS.includes(host) ||
    PUSH_DOMAINS.some((domain) => host.endsWith(domain))
  );
};
