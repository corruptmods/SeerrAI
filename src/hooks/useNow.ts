import { useEffect, useState } from 'react';

/** The time, once a second while `on`: for a clock that counts up. */
const useNow = (on: boolean): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!on) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);

  return now;
};

/** How long since `since`, as a clock: 4:05, or 1:02:33. */
export const elapsed = (since: string | undefined, now: number): string => {
  const start = Date.parse(since ?? '');
  const seconds = Number.isFinite(start)
    ? Math.max(0, Math.floor((now - start) / 1000))
    : 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

export default useNow;
