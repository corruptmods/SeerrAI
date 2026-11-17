// Browser apps (Settings → Network), shared by the server and pages. See
// lib/browserApps for how requests from them are answered.

/** Pluet's browser app, offered first when browser apps are turned on. */
export const PLUET_BROWSER_ORIGIN = 'https://watch.pluet.app';

/** The most sites that may be allowed. */
export const MOST_BROWSER_APP_SITES = 20;

/**
 * The exact origin an admin means (`https://watch.pluet.app`, with a port if
 * not the usual one), as browsers send it, or undefined for anything else:
 * a path, a wildcard, a user name, or a scheme other than http and https.
 */
export const browserOriginFrom = (entry: string): string | undefined => {
  const value = entry.trim().replace(/\/$/, '');
  if (!/^https?:\/\/[^/?#*\s@\\]+$/i.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.hostname ? url.origin : undefined;
  } catch {
    return undefined;
  }
};
