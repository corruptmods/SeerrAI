/*
 * Where to go after signing in. The page someone was sent away from rides
 * along as `/login?redirect=...` (or through a single sign-on provider and
 * back), and only ever comes back as a path on this site: anything else
 * (another site, a script, the sign-in page itself) goes home instead.
 *
 * Shared by the sign-in page and the server, so both follow the same rules.
 */

const BASE = 'http://localhost';

const isSignInPage = (pathname: string) => {
  const lower = pathname.toLowerCase();
  return lower === '/login' || lower.startsWith('/login/');
};

export const safeRedirect = (value: unknown): string => {
  // A path on this site starts with one slash. Two, or a backslash, which
  // browsers read as a slash, starts another site's address.
  if (typeof value !== 'string' || !/^\/(?![/\\])/.test(value)) {
    return '/';
  }

  try {
    // Tabs, backslashes and dot segments can still make an address that
    // looked like a path resolve to another site, so it is read the way a
    // browser would and checked again.
    const url = new URL(value, BASE);
    if (
      url.origin !== BASE ||
      url.pathname.startsWith('//') ||
      isSignInPage(url.pathname)
    ) {
      return '/';
    }
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
};

/** The sign-in page, set to come back to `path` afterwards. */
export const loginUrl = (path?: string): string => {
  const target = safeRedirect(path);
  return target === '/'
    ? '/login'
    : `/login?redirect=${encodeURIComponent(target)}`;
};
