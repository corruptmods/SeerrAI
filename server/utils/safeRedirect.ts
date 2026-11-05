// Where to go after sign-in. The original page rides along as
// `/login?redirect=...` (or through an SSO provider and back), and is only
// honoured as a path on this site: anything else (another site, a script, the
// sign-in page itself) goes home.
//
// Shared by the sign-in page and the server, so both follow the same rules.

const BASE = 'http://localhost';

const isSignInPage = (pathname: string) => {
  const lower = pathname.toLowerCase();
  return lower === '/login' || lower.startsWith('/login/');
};

export const safeRedirect = (value: unknown): string => {
  // A same-site path starts with one slash. Two, or a backslash (which browsers
  // treat as a slash), starts another site's URL.
  if (typeof value !== 'string' || !/^\/(?![/\\])/.test(value)) {
    return '/';
  }

  try {
    // Tabs, backslashes and dot segments can still make a path-looking value
    // resolve to another site, so parse it as a browser would and check again.
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

/** The sign-in page URL, returning to `path` afterwards. */
export const loginUrl = (path?: string): string => {
  const target = safeRedirect(path);
  return target === '/'
    ? '/login'
    : `/login?redirect=${encodeURIComponent(target)}`;
};
