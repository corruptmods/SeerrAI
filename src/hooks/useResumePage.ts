import { dismissBootScreen } from '@app/components/BootScreen';
import { isStandalone } from '@app/utils/pushPlatform';
import type { NextRouter } from 'next/router';
import { useEffect } from 'react';

/*
 * iOS throws an installed app out of memory while it is in the background,
 * and opening it again starts it afresh, on the home page. The page it was
 * on is kept here, so a fresh start of the installed app goes back to it,
 * behind the startup screen. Only in the installed app, and only for a page
 * left in the last 12 hours.
 */

const KEY = 'seerr-last-page';
const FRESH_MS = 12 * 60 * 60_000;
/** Pages not to come back to. */
const SKIP = /^\/(login|setup|resetpassword)(\/|\?|$)/;

const resumable = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.startsWith('/') &&
  !path.startsWith('//') &&
  path !== '/' &&
  !SKIP.test(path);

const remember = (path: string) => {
  if (SKIP.test(path)) {
    return;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    // Storage refused: the app just starts on the home page.
  }
};

const lastPage = (): string | undefined => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
      path?: unknown;
      at?: unknown;
    } | null;
    return saved &&
      typeof saved.at === 'number' &&
      Date.now() - saved.at < FRESH_MS &&
      resumable(saved.path)
      ? saved.path
      : undefined;
  } catch {
    return undefined;
  }
};

/** Goes back to the page the installed app was on; then the app is shown. */
const useResumePage = (router: NextRouter) => {
  useEffect(() => {
    const onPage = (url: string) => remember(url);
    router.events.on('routeChangeComplete', onPage);

    const back =
      isStandalone() && router.asPath === '/' ? lastPage() : undefined;
    let undo = () => undefined as void;
    if (back) {
      router
        .replace(back)
        .catch(() => undefined)
        .finally(() => {
          undo = dismissBootScreen();
        });
    } else {
      remember(router.asPath);
      undo = dismissBootScreen();
    }

    return () => {
      router.events.off('routeChangeComplete', onPage);
      undo();
    };
    // Once, when the app starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};

export default useResumePage;
