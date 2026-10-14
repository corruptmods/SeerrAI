import useSettings from '@app/hooks/useSettings';
import type { AnimeSignals } from '@server/utils/isAnime';
import { isAnime } from '@server/utils/isAnime';
import { useCallback } from 'react';

/**
 * Anime detection as the server does it (utils/isAnime), with the server's
 * setting of which countries' anime is left out, so a page says the same
 * as where a request is sent.
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
