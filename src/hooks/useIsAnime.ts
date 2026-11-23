import useSettings from '@app/hooks/useSettings';
import type { AnimeSignals } from '@server/utils/isAnime';
import { isAnime } from '@server/utils/isAnime';
import { useCallback } from 'react';

/**
 * Anime detection matching the server (utils/isAnime) and its excluded
 * countries, so the page agrees with request routing. Nothing is anime while
 * anime is off (Settings → Services → Anime).
 */
const useIsAnime = (): ((media: AnimeSignals) => boolean) => {
  const { currentSettings } = useSettings();
  const leaveOut = currentSettings.animeExcludedCountries;
  const enabled = currentSettings.animeEnabled;

  return useCallback(
    (media: AnimeSignals) => enabled && isAnime(media, leaveOut ?? []),
    [enabled, leaveOut]
  );
};

export default useIsAnime;
