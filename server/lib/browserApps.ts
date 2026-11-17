import { getSettings } from '@server/lib/settings';

/*
 * Browser apps (Settings → Network): web apps on other sites, such as Pluet
 * at watch.pluet.app, may call the API from a visitor's browser.
 *
 * Only with a personal API key in X-Api-Key, never with the session cookie:
 * answers never allow credentials, so a browser neither sends the cookie
 * with them nor lets the page read what comes back with it. The server's own
 * key is refused from these sites, so a page there can never act as admin.
 * See middleware/browserApps for the headers and routes/appLink for how an
 * app gets its key.
 */

/**
 * The site a request comes from, when browser apps are on and it is one of
 * the allowed sites; undefined otherwise.
 */
export const allowedBrowserOrigin = (
  origin: string | undefined
): string | undefined => {
  const { enabled, origins } = getSettings().network.browserApps;
  return enabled && origin !== undefined && origins.includes(origin)
    ? origin
    : undefined;
};
