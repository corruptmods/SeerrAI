import axios from 'axios';
import { useEffect, useRef, useState } from 'react';

/*
 * What titles on a page can be filtered by — cast, characters, who made them
 * — fetched only while a filter is in use, in batches, and remembered for the
 * rest of the visit so paging back and forth never asks twice.
 *
 * The server answers within a few seconds with what it has and says which
 * titles it is still looking up; those are asked for again shortly. A request
 * that fails is retried a few times before its titles fall back to matching
 * by name.
 */

const BATCH = 30;
/** Batches in flight at once. */
const CONCURRENCY = 2;
/** How soon to ask again about titles the server is still looking up. */
const PENDING_RETRY_MS = 1500;
/** Attempts after a failed request before matching those titles by name. */
const FAILURE_RETRIES = 3;

const known = new Map<string, string>();
const inFlight = new Set<string>();
/** Titles the server could not describe: matched by name alone. */
const unavailable = new Set<string>();
/** Not to be asked about again before this time. */
const notBefore = new Map<string, number>();
const failures = new Map<string, number>();

/**
 * Searchable text for the titles given, keyed as "movie:603". `pending` is
 * true while any of them is still being looked up.
 */
const useSearchText = (
  keys: string[],
  enabled: boolean
): { text: Map<string, string>; pending: boolean } => {
  const [, setVersion] = useState(0);
  // A batch outlives the render that started it (the next render no longer
  // counts its titles as wanted), so only leaving the page stops the update.
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

  // Titles waiting out a retry delay: look again when the earliest is due.
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
                  // params, and Seerr's API validator refuses a query with
                  // reserved characters (400), so no request ever succeeded.
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
