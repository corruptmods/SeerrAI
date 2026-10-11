import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/*
 * One notice at a time. Banners and pop-ups that ask something of you (the
 * app was updated, your Plex sign-in expired, finished-watching suggestions,
 * turning on notifications, adding a passkey) each report whether they have
 * something to say; only the most important one is shown, and the next takes
 * its place once it is dealt with. Nothing stacks, and two dialogs never
 * open over each other.
 */

/** Lower comes first. */
export const NOTICE_PRIORITY = {
  appUpdated: 0,
  accountWarning: 10,
  watchSuggestions: 20,
  pushOptIn: 30,
  passkey: 40,
} as const;

export type NoticeId = keyof typeof NOTICE_PRIORITY;

/**
 * `pending`: still finding out (loading). A notice that is pending holds back
 * the ones after it, so a less important one never flashes up only to be
 * replaced; after a few seconds it stops holding them back.
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

/** Which notice should be showing, given what each has reported. */
export const pickNotice = (
  entries: Partial<Record<NoticeId, Entry>>,
  current: NoticeId | undefined,
  now: number
): { next?: NoticeId; recheckIn?: number } => {
  // An update blocks the app until it reloads, so it goes first regardless.
  if (entries.appUpdated?.state === 'show') {
    return { next: 'appUpdated' };
  }
  // Otherwise whatever is showing stays until it is dealt with, even if
  // something more important turns up: no notice is pulled out from under a
  // tap.
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

/**
 * Report what this notice has to say; true when it is its turn to show.
 * Outside a queue (a page rendered on its own) it simply shows.
 */
export const useNotice = (id: NoticeId, state: NoticeState): boolean => {
  const queue = useContext(NoticeQueueContext);
  const report = queue?.report;

  useEffect(() => {
    report?.(id, state);
  }, [report, id, state]);

  // Leaving the page counts as having nothing to say.
  useEffect(() => () => report?.(id, 'hide'), [report, id]);

  if (!queue) {
    return state === 'show';
  }
  return state === 'show' && queue.current === id;
};
