import { dismissBootScreen } from '@app/components/BootScreen';
import { markPageReturn, watchPageReturns } from '@app/utils/pageReturn';
import { isStandalone } from '@app/utils/pushPlatform';
import type { NextRouter } from 'next/router';
import { useEffect } from 'react';

/*
 * iOS evicts a backgrounded installed app and restarts it on the home page.
 * The current page is kept in sessionStorage so a restart returns to it
 * behind the startup screen; swiping the app away clears it. Installed app only.
 */

const KEY = 'seerr-last-page';
/** Don't resume a page left longer ago than this. */
const FRESH_MS = 12 * 60 * 60_000;
/** Pages never resumed. */
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
    sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    // Storage refused: start on the home page.
  }
};

const lastPage = (): string | undefined => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as {
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

/**
 * Returns the installed app to its last page, then reveals the app. Also
 * follows history steps, so pages know when they are returned to.
 */
const useResumePage = (router: NextRouter) => {
  useEffect(() => {
    const onPage = (url: string) => remember(url);
    router.events.on('routeChangeComplete', onPage);
    const unwatch = watchPageReturns(router.events);

    const back =
      isStandalone() && router.asPath === '/' ? lastPage() : undefined;
    let undo = () => undefined as void;
    if (back) {
      // Resumed where it was, like a step back.
      markPageReturn(back);
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
      unwatch();
      undo();
    };
    // Once, on app start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};

export default useResumePage;
