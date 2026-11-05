import useSettings from '@app/hooks/useSettings';
import type { AnimeSignals } from '@server/utils/isAnime';
import { isAnime } from '@server/utils/isAnime';
import { useCallback } from 'react';

/**
 * Anime detection matching the server (utils/isAnime) and its excluded
 * countries, so the page agrees with request routing.
 */
const useIsAnime = (): ((media: AnimeSignals) => boolean) => {
  const { currentSettings } = useSettings();
  const leaveOut = currentSettings.animeExcludedCountries;

  return useCallback(
    (media: AnimeSignals) => isAnime(media, leaveOut ?? []),
    [leaveOut]
  );
};

export default useIsAnime;
