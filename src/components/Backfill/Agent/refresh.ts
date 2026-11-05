/*
 * Poll interval in ms for the runs shown. A held run (waiting on the *arr and
 * Backfill searches) starts by itself, so it is polled every 10 s.
 */
export const runRefreshMs = (
  statuses: string[],
  { working, idle }: { working: number; idle: number }
): number => {
  if (statuses.some((s) => s === 'running' || s === 'queued')) return working;
  if (statuses.includes('held')) return 10_000;
  return idle;
};
