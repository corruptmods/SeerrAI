/*
 * How often the agent's pages ask again, in milliseconds, by the status of
 * the runs on show. A working run changes by the second. A held run (a
 * reported title, waiting on Sonarr's or Radarr's search and Backfill's)
 * starts on its own once they are over, so it is checked every 10 seconds
 * to show that without a reload.
 */
export const runRefreshMs = (
  statuses: string[],
  { working, idle }: { working: number; idle: number }
): number => {
  if (statuses.some((s) => s === 'running' || s === 'queued')) return working;
  if (statuses.includes('held')) return 10_000;
  return idle;
};
