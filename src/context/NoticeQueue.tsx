import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/*
 * One notice at a time. Prompting banners and pop-ups (app updated, Plex
 * sign-in expired, watch suggestions, notifications, passkeys, a season
 * starting) report whether they want to show; only the highest priority
 * shows, and the next follows once it's dismissed. Dialogs never stack.
 */

/** Lower comes first. */
export const NOTICE_PRIORITY = {
  appUpdated: 0,
  accountWarning: 10,
  watchSuggestions: 20,
  pushOptIn: 30,
  passkey: 40,
  seasonal: 50,
} as const;

export type NoticeId = keyof typeof NOTICE_PRIORITY;

/**
 * `pending`: still loading. It holds back lower notices for a few seconds so
 * one doesn't flash up only to be replaced.
 */
export type NoticeState = 'pending' | 'show' | 'hide';

const PENDING_HOLD_MS = 3000;

interface Entry {
  state: NoticeState;
  since: number;
}

interface NoticeQueueValue {
  report: (id: NoticeId, state: NoticeState) => void;
  current?: NoticeId;
}

const NoticeQueueContext = createContext<NoticeQueueValue | null>(null);

/** The notice to show, given each one's state. */
export const pickNotice = (
  entries: Partial<Record<NoticeId, Entry>>,
  current: NoticeId | undefined,
  now: number
): { next?: NoticeId; recheckIn?: number } => {
  // An update blocks the app until reload, so it always wins.
  if (entries.appUpdated?.state === 'show') {
    return { next: 'appUpdated' };
  }
  // Otherwise the current notice stays until dismissed, so none is pulled
  // out from under a tap.
  if (current && entries[current]?.state === 'show') {
    return { next: current };
  }

  const order = (Object.keys(NOTICE_PRIORITY) as NoticeId[]).sort(
    (a, b) => NOTICE_PRIORITY[a] - NOTICE_PRIORITY[b]
  );
  for (const id of order) {
    const entry = entries[id];
    if (!entry || entry.state === 'hide') {
      continue;
    }
    if (entry.state === 'show') {
      return { next: id };
    }
    const waited = now - entry.since;
    if (waited < PENDING_HOLD_MS) {
      return { recheckIn: PENDING_HOLD_MS - waited };
    }
  }
  return {};
};

export const NoticeQueueProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [entries, setEntries] = useState<Partial<Record<NoticeId, Entry>>>({});
  const [current, setCurrent] = useState<NoticeId>();
  const [tick, setTick] = useState(0);

  const report = useCallback((id: NoticeId, state: NoticeState) => {
    setEntries((previous) =>
      previous[id]?.state === state
        ? previous
        : { ...previous, [id]: { state, since: Date.now() } }
    );
  }, []);

  useEffect(() => {
    const { next, recheckIn } = pickNotice(entries, current, Date.now());
    setCurrent(next);
    if (recheckIn !== undefined) {
      const timer = setTimeout(() => setTick((t) => t + 1), recheckIn);
      return () => clearTimeout(timer);
    }
  }, [entries, current, tick]);

  const value = useMemo(() => ({ report, current }), [report, current]);

  return (
    <NoticeQueueContext.Provider value={value}>
      {children}
    </NoticeQueueContext.Provider>
  );
};

/** Reports a notice's state; true when it should show. Always true outside a queue. */
export const useNotice = (id: NoticeId, state: NoticeState): boolean => {
  const queue = useContext(NoticeQueueContext);
  const report = queue?.report;

  useEffect(() => {
    report?.(id, state);
  }, [report, id, state]);

  // Unmounting hides it.
  useEffect(() => () => report?.(id, 'hide'), [report, id]);

  if (!queue) {
    return state === 'show';
  }
  return state === 'show' && queue.current === id;
};
