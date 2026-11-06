/*
 * Custom CSS and safe mode.
 *
 * Server CSS and personal CSS load as <link id="seerr-server-css"> and
 * <link id="seerr-personal-css"> after the app's styles, so they win. A look
 * with a theme file also carries an inactive copy without the file
 * (<style id="seerr-theme-safe" media="not all">).
 *
 * Safe mode drops all of that. `?safe` on any URL turns it on and the tab
 * keeps it (sessionStorage) until turned off. The server omits custom CSS
 * and theme files for ?safe requests; SAFE_MODE_SCRIPT removes them before
 * first paint on other pages in that tab.
 */
import { THEME_STYLE_ID } from './index';

export const SAFE_MODE_PARAM = 'safe';
export const SAFE_MODE_KEY = 'seerr-safe-mode';
export const SERVER_CSS_ID = 'seerr-server-css';
export const PERSONAL_CSS_ID = 'seerr-personal-css';
export const THEME_SAFE_STYLE_ID = 'seerr-theme-safe';

/*
 * Runs right after the custom stylesheets (pages/_document). In safe mode it
 * sets <html data-safe="on">, removes them, and swaps in the theme-file-free look.
 */
export const SAFE_MODE_SCRIPT = `(function(){var d=document,on=new URLSearchParams(location.search).has('${SAFE_MODE_PARAM}');try{var s=window.sessionStorage;if(on){s.setItem('${SAFE_MODE_KEY}','on')}else{on=s.getItem('${SAFE_MODE_KEY}')==='on'}}catch(e){}if(!on){return}try{d.documentElement.setAttribute('data-safe','on');var drop=function(id){var e=d.getElementById(id);if(e){e.parentNode.removeChild(e)}return e};drop('${SERVER_CSS_ID}');drop('${PERSONAL_CSS_ID}');var safe=d.getElementById('${THEME_SAFE_STYLE_ID}');if(safe){drop('${THEME_STYLE_ID}');safe.id='${THEME_STYLE_ID}';safe.removeAttribute('media')}}catch(e){}})()`;

/** Whether SAFE_MODE_SCRIPT put this page in safe mode. */
export const isSafeMode = (): boolean =>
  typeof document !== 'undefined' &&
  document.documentElement.getAttribute('data-safe') === 'on';

/** Turns safe mode off for the tab and reloads without it. */
export const turnOffSafeMode = (): void => {
  try {
    window.sessionStorage.removeItem(SAFE_MODE_KEY);
  } catch {
    // Nothing stored; only the URL had turned it on.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete(SAFE_MODE_PARAM);
  window.location.replace(url.toString());
};

/** An app path opened in safe mode. */
export const safeModeHref = (path: string): string =>
  `${path}${path.includes('?') ? '&' : '?'}${SAFE_MODE_PARAM}`;

/**
 * The custom stylesheets to load: Server CSS, plus the user's own when they
 * have some and personal CSS is allowed. URLs are versioned for caching.
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
 * Syncs the custom stylesheets with settings and user, always after the
 * app's styles. None in safe mode.
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

export const CSS_PREVIEW_ID = {
  server: 'seerr-server-css-preview',
  personal: 'seerr-personal-css-preview',
} as const;

/**
 * Shows CSS being edited in place of the saved Server or Personal CSS, at the
 * same point in the page so it wins as the saved one would. Returns what puts
 * the saved one back. Nothing in safe mode.
 */
export const previewCustomCss = (
  kind: 'server' | 'personal',
  css: string
): (() => void) => {
  if (isSafeMode()) {
    return () => undefined;
  }
  const saved = document.getElementById(
    kind === 'server' ? SERVER_CSS_ID : PERSONAL_CSS_ID
  ) as HTMLLinkElement | null;
  const style = document.createElement('style');
  style.id = CSS_PREVIEW_ID[kind];
  style.textContent = css;
  if (saved) {
    saved.disabled = true;
    saved.after(style);
  } else {
    // Server CSS goes before personal CSS, which wins over it.
    const personal =
      kind === 'server' ? document.getElementById(PERSONAL_CSS_ID) : null;
    if (personal) {
      personal.before(style);
    } else {
      document.head.appendChild(style);
    }
  }
  return () => {
    style.remove();
    if (saved) {
      saved.disabled = false;
    }
  };
};
