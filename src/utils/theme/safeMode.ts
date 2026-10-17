/*
 * Custom CSS on the page, and safe mode.
 *
 * Pages load the admin's Server CSS and the person's own as stylesheets
 * (<link id="seerr-server-css"> and <link id="seerr-personal-css">), after
 * the app's own so they win. A look with a theme file also carries a
 * second, unused copy of its variables without the file
 * (<style id="seerr-theme-safe" media="not all">).
 *
 * Safe mode opens Seerr AI without any of that: `?safe` on any address
 * (the sign-in page and the Appearance page link to it) turns it on, and
 * the tab remembers it (sessionStorage) until it is turned off. The server
 * leaves custom CSS and theme files out of a page asked for with ?safe;
 * for any other page in that tab, SAFE_MODE_SCRIPT takes them out before
 * anything is drawn.
 */
import { THEME_STYLE_ID } from './index';

export const SAFE_MODE_PARAM = 'safe';
export const SAFE_MODE_KEY = 'seerr-safe-mode';
export const SERVER_CSS_ID = 'seerr-server-css';
export const PERSONAL_CSS_ID = 'seerr-personal-css';
export const THEME_SAFE_STYLE_ID = 'seerr-theme-safe';

/*
 * Runs in the page right after the custom stylesheets (pages/_document).
 * In safe mode it marks <html data-safe="on">, removes the stylesheets, and
 * puts the copy of the look without its theme file in the look's place.
 */
export const SAFE_MODE_SCRIPT = `(function(){var d=document,on=new URLSearchParams(location.search).has('${SAFE_MODE_PARAM}');try{var s=window.sessionStorage;if(on){s.setItem('${SAFE_MODE_KEY}','on')}else{on=s.getItem('${SAFE_MODE_KEY}')==='on'}}catch(e){}if(!on){return}try{d.documentElement.setAttribute('data-safe','on');var drop=function(id){var e=d.getElementById(id);if(e){e.parentNode.removeChild(e)}return e};drop('${SERVER_CSS_ID}');drop('${PERSONAL_CSS_ID}');var safe=d.getElementById('${THEME_SAFE_STYLE_ID}');if(safe){drop('${THEME_STYLE_ID}');safe.id='${THEME_STYLE_ID}';safe.removeAttribute('media')}}catch(e){}})()`;

/** Whether this page is in safe mode (SAFE_MODE_SCRIPT has said so). */
export const isSafeMode = (): boolean =>
  typeof document !== 'undefined' &&
  document.documentElement.getAttribute('data-safe') === 'on';

/** Turns safe mode off for the tab, and loads the page again without it. */
export const turnOffSafeMode = (): void => {
  try {
    window.sessionStorage.removeItem(SAFE_MODE_KEY);
  } catch {
    // Nothing was kept; the address alone had turned it on.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete(SAFE_MODE_PARAM);
  window.location.replace(url.toString());
};

/** An address in this app, opened in safe mode. */
export const safeModeHref = (path: string): string =>
  `${path}${path.includes('?') ? '&' : '?'}${SAFE_MODE_PARAM}`;

/**
 * The custom stylesheets a page loads: the Server CSS if there is any, and
 * the signed-in person's own if they have some and people may add their
 * own. Each address carries its version, so browsers keep it until it
 * changes.
 */
export const customCssLinks = (
  settings: { customCss: { server: string | null; personal: boolean } },
  personalVersion: string | null | undefined
): { server?: string; personal?: string } => ({
  ...(settings.customCss.server && {
    server: `/api/v1/style/server.css?v=${settings.customCss.server}`,
  }),
  ...(settings.customCss.personal &&
    personalVersion && {
      personal: `/api/v1/style/personal.css?v=${personalVersion}`,
    }),
});

/**
 * Keeps the custom stylesheets on the page in step with the settings and
 * the person signed in: added, changed or removed, always after the app's
 * own styles. None in safe mode.
 */
export const applyCustomCss = (links: {
  server?: string;
  personal?: string;
}): void => {
  const safe = isSafeMode();
  for (const [id, href] of [
    [SERVER_CSS_ID, links.server],
    [PERSONAL_CSS_ID, links.personal],
  ] as const) {
    const existing = document.getElementById(id) as HTMLLinkElement | null;
    if (!href || safe) {
      existing?.remove();
    } else if (!existing) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
    } else if (existing.getAttribute('href') !== href) {
      existing.setAttribute('href', href);
    }
  }
};
