import type { PlayLink } from '@app/utils/playLinks';
import { isAppleTouchDevice, withAppLinks } from '@app/utils/playLinks';
import { useEffect, useMemo, useState } from 'react';

/**
 * A title's play links as this device should open them: on an iPhone or
 * iPad, each Plex link opens Plex's app. The device is only known once the
 * page runs in the browser, so the first render has the web links.
 */
const useDeepLinks = (links: PlayLink[]): PlayLink[] => {
  const [appleTouch, setAppleTouch] = useState(false);

  useEffect(() => {
    setAppleTouch(isAppleTouchDevice(navigator));
  }, []);

  return useMemo(
    () => (appleTouch ? links.map(withAppLinks) : links),
    [appleTouch, links]
  );
};

export default useDeepLinks;
