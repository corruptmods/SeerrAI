import axios from 'axios';
import { useEffect, useRef, useState } from 'react';

/*
 * Filterable text for titles (cast, characters, crew), fetched in batches
 * only while a filter is active and cached for the visit.
 *
 * The server returns what it has within seconds and lists titles still being
 * looked up, which are re-asked shortly. Failed batches retry a few times,
 * then fall back to name matching.
 */

const BATCH = 30;
/** Concurrent batches. */
const CONCURRENCY = 2;
/** Delay before re-asking for titles still being looked up. */
const PENDING_RETRY_MS = 1500;
/** Retries after a failure before falling back to name matching. */
const FAILURE_RETRIES = 3;

const known = new Map<string, string>();
const inFlight = new Set<string>();
/** Titles the server couldn't describe; matched by name only. */
const unavailable = new Set<string>();
/** Earliest time each title may be re-asked. */
const notBefore = new Map<string, number>();
const failures = new Map<string, number>();

/** Searchable text per title, keyed "movie:603". `pending` while any is still being looked up. */
const useSearchText = (
  keys: string[],
  enabled: boolean
): { text: Map<string, string>; pending: boolean } => {
  const [, setVersion] = useState(0);
  // A batch outlives its render, so only unmounting cancels its update.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const now = Date.now();
  const outstanding = enabled
    ? keys.filter((key) => !known.has(key) && !unavailable.has(key))
    : [];
  const wanted = outstanding.filter(
    (key) => !inFlight.has(key) && (notBefore.get(key) ?? 0) <= now
  );
  const wantedKey = wanted.join(',');

  // Re-check when the earliest retry delay ends.
  const nextDue = Math.min(
    ...outstanding
      .filter((key) => !inFlight.has(key) && (notBefore.get(key) ?? 0) > now)
      .map((key) => notBefore.get(key) ?? 0)
  );
  useEffect(() => {
    if (!Number.isFinite(nextDue)) {
      return;
    }
    const timer = setTimeout(
      () => mounted.current && setVersion((v) => v + 1),
      Math.max(0, nextDue - Date.now())
    );
    return () => clearTimeout(timer);
  }, [nextDue]);

  useEffect(() => {
    if (!wantedKey) {
      return;
    }
    const list = wantedKey.split(',');
    const batches: string[][] = [];
    for (let i = 0; i < list.length; i += BATCH) {
      batches.push(list.slice(i, i + BATCH));
    }
    list.forEach((key) => inFlight.add(key));

    const run = async () => {
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENCY, batches.length) },
          async () => {
            while (next < batches.length) {
              const batch = batches[next++];
              try {
                const response = await axios.get<{
                  text: Record<string, string>;
                  pending?: string[];
                  // Built by hand: axios leaves ":" and "," unescaped in
                  // params, which the API validator rejects (400).
                }>(
                  `/api/v1/discover/search-text?ids=${encodeURIComponent(
                    batch.join(',')
                  )}`
                );
                const pending = new Set(response.data.pending ?? []);
                for (const key of batch) {
                  const text = response.data.text[key];
                  if (text !== undefined) {
                    known.set(key, text);
                  } else if (pending.has(key)) {
                    notBefore.set(key, Date.now() + PENDING_RETRY_MS);
                  } else {
                    unavailable.add(key);
                  }
                }
              } catch {
                for (const key of batch) {
                  const count = (failures.get(key) ?? 0) + 1;
                  failures.set(key, count);
                  if (count > FAILURE_RETRIES) {
                    unavailable.add(key);
                  } else {
                    notBefore.set(key, Date.now() + 2000 * count);
                  }
                }
              } finally {
                batch.forEach((key) => inFlight.delete(key));
                if (mounted.current) {
                  setVersion((v) => v + 1);
                }
              }
            }
          }
        )
      );
    };
    run();
  }, [wantedKey]);

  return {
    text: known,
    pending: outstanding.length > 0,
  };
};

export default useSearchText;
