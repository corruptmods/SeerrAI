import useSWR from 'swr';

interface Marker {
  tmdbId: number;
  mediaType: string;
}

interface MarkersResponse {
  lists: Marker[];
  notify: Marker[];
}

const key = (marker: Marker) => `${marker.mediaType}:${marker.tmdbId}`;

export const MARKERS_KEY = '/api/v1/list/markers';

/**
 * Titles the user has on a list or will be notified about. One shared SWR
 * key, so a grid costs one request.
 */
export const useMediaMarkers = () => {
  const { data } = useSWR<MarkersResponse>(MARKERS_KEY, {
    revalidateOnFocus: false,
  });

  const lists = new Set((data?.lists ?? []).map(key));
  const notify = new Set((data?.notify ?? []).map(key));

  return {
    isOnList: (tmdbId: number, mediaType: string) =>
      lists.has(`${mediaType}:${tmdbId}`),
    isNotified: (tmdbId: number, mediaType: string) =>
      notify.has(`${mediaType}:${tmdbId}`),
  };
};

export default useMediaMarkers;
