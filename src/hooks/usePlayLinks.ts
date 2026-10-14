import useDeepLinks from '@app/hooks/useDeepLinks';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import type { MediaPlayInfo } from '@app/utils/playLinks';
import {
  orderPlayLinks,
  pickPlayLink,
  playLinksOf,
} from '@app/utils/playLinks';
import { useMemo } from 'react';

/**
 * Where the viewer can play a title: every server's links, their own
 * servers first, for a title's page; and the one link to offer for it and
 * for its 4K version, for badges and cards.
 */
const usePlayLinks = (media: MediaPlayInfo | undefined) => {
  const { user } = useUser();
  const { currentSettings } = useSettings();

  const serverLinks = useMemo(
    () => playLinksOf(media, currentSettings.mediaServers),
    [media, currentSettings.mediaServers]
  );
  const deviceLinks = useDeepLinks(serverLinks);

  return useMemo(
    () => ({
      links: orderPlayLinks(deviceLinks, user),
      playLink: pickPlayLink(deviceLinks, user),
      playLink4k: pickPlayLink(deviceLinks, user, true),
    }),
    [deviceLinks, user]
  );
};

export default usePlayLinks;
