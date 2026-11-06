/*
 * Coming back to a page: back or forward, a reload, or the installed app
 * resuming it. What was on screen (pages loaded, scroll positions) then comes
 * back from this tab's sessionStorage; a fresh visit starts fresh. Next only
 * restores the window's scroll, and only while the page's data is in memory.
 */

/** Pages loaded again at most, so a long list doesn't hold up the page. */
export const MAX_RETURN_PAGES = 10;

/** Where a list page was left. */
export interface PageState {
  /** Window scroll, in pixels. */
  y: number;
  /** Pages of results loaded. */
  pages?: number;
}

interface Store {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

const sessionStore = (): Store | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
};

const PAGE_PREFIX = 'page-return:';
const ROW_PREFIX = 'row-return:';

const isPosition = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const read = (key: string, store: Store | undefined): unknown => {
  try {
    const text = store?.getItem(key);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

const write = (key: string, value: unknown, store: Store | undefined) => {
  try {
    if (value === undefined) {
      store?.removeItem(key);
    } else {
      store?.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Storage full or refused: the page just starts fresh next time.
  }
};

/** A page's saved state, if any and sound. Pages are capped. */
export const readPageState = (
  key: string,
  store = sessionStore()
): PageState | undefined => {
  const saved = read(PAGE_PREFIX + key, store) as Partial<PageState> | null;
  if (!saved || !isPosition(saved.y)) {
    return undefined;
  }
  const pages =
    Number.isInteger(saved.pages) && (saved.pages as number) > 0
      ? Math.min(saved.pages as number, MAX_RETURN_PAGES)
      : undefined;
  return { y: Math.round(saved.y), ...(pages && { pages }) };
};

export const savePageState = (
  key: string,
  state: PageState,
  store = sessionStore()
) => write(PAGE_PREFIX + key, state, store);

/** A row's saved sideways scroll, if any. */
export const readRowScroll = (
  key: string,
  store = sessionStore()
): number | undefined => {
  const saved = read(ROW_PREFIX + key, store);
  return isPosition(saved) && saved > 0 ? Math.round(saved) : undefined;
};

/** Saves a row's sideways scroll; at the start there's nothing to keep. */
export const saveRowScroll = (key: string, x: number, store = sessionStore()) =>
  write(
    ROW_PREFIX + key,
    isPosition(x) && x >= 1 ? Math.round(x) : undefined,
    store
  );

/** Whether this document was opened by a reload or by back or forward. */
export const openedByReturn = (
  entries: { type?: string }[] | undefined
): boolean =>
  entries?.[0]?.type === 'reload' || entries?.[0]?.type === 'back_forward';

/** An address without its #fragment. */
const withoutHash = (url: string) => url.split('#')[0];

/**
 * Tells returns from fresh visits. A history step (popstate) or a resume marks
 * its address; the page change to that address is a return, any other a fresh
 * visit. Before the first change, the document's own navigation decides.
 */
export const returnTracker = (opened: () => boolean) => {
  let marked: string | undefined;
  let current: boolean | undefined;
  return {
    /** A history step to `url`, or the installed app resuming it. */
    mark: (url: string) => {
      marked = withoutHash(url);
    },
    /** A page change to `url` begins. */
    routeStart: (url: string) => {
      current = marked !== undefined && marked === withoutHash(url);
      marked = undefined;
    },
    /** Whether the page now shown was returned to. */
    cameBack: () => current ?? opened(),
  };
};

const tracker = returnTracker(() => {
  try {
    return openedByReturn(
      performance.getEntriesByType(
        'navigation'
      ) as PerformanceNavigationTiming[]
    );
  } catch {
    return false;
  }
});

/** Whether the page now shown was returned to rather than freshly visited. */
export const cameBack = () => tracker.cameBack();

/** The installed app is about to resume `url`. */
export const markPageReturn = (url: string) => tracker.mark(url);

interface RouterEvents {
  on: (event: 'routeChangeStart', handler: (url: string) => void) => void;
  off: (event: 'routeChangeStart', handler: (url: string) => void) => void;
}

/** Follows history steps and page changes; once, on app start. */
export const watchPageReturns = (events: RouterEvents) => {
  const onPopState = (event: PopStateEvent) => {
    const as = (event.state as { as?: unknown } | null)?.as;
    if (typeof as === 'string') {
      tracker.mark(as);
    }
  };
  const onRouteStart = (url: string) => tracker.routeStart(url);
  // Capture, so the step is seen before Next acts on it.
  window.addEventListener('popstate', onPopState, true);
  events.on('routeChangeStart', onRouteStart);
  return () => {
    window.removeEventListener('popstate', onPopState, true);
    events.off('routeChangeStart', onRouteStart);
  };
};
