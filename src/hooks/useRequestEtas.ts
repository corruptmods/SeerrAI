import useFeature from '@app/hooks/useFeature';
import useSWR from 'swr';

export type RequestEta =
  | { stage: 'awaiting_approval' }
  | {
      stage: 'unreleased';
      date: string;
      kind: 'cinemas' | 'digital' | 'physical' | 'airs';
    }
  | {
      stage: 'searching';
      typicalDays?: number;
      released?: boolean;
      releasedAs?: 'digital' | 'physical' | 'cinemas' | 'aired';
    }
  | {
      stage: 'downloading';
      minutesLeft?: number;
      phase?:
        | 'waiting'
        | 'stalled'
        | 'details'
        | 'queued'
        | 'paused'
        | 'finishing'
        | 'importing'
        | 'held'
        | 'retrying';
    }
  | { stage: 'available' }
  | { stage: 'unknown' };

/** While a title downloads, its estimate moves quickly. */
const DOWNLOADING_MS = 10_000;
/** Otherwise, without hammering Radarr or Sonarr. */
const SETTLED_MS = 5 * 60 * 1000;

/**
 * Poll interval: seconds while downloading, to keep pace with the status
 * badge; minutes otherwise.
 */
export const etaRefreshInterval = (etas: (RequestEta | undefined)[]): number =>
  etas.some((eta) => eta?.stage === 'downloading')
    ? DOWNLOADING_MS
    : SETTLED_MS;

/** Estimates for several requests in one call, so a page of cards asks once. */
const useRequestEtas = (ids: number[]) => {
  const on = useFeature('arrivalEstimates');
  const key =
    on && ids.length
      ? `/api/v1/request/eta?ids=${[...ids].sort((a, b) => a - b).join(',')}`
      : null;
  const { data } = useSWR<Record<string, RequestEta>>(key, {
    refreshInterval: (latest) =>
      etaRefreshInterval(Object.values(latest ?? {})),
    revalidateOnFocus: false,
  });

  return (id: number): RequestEta | undefined => data?.[String(id)];
};

export default useRequestEtas;
