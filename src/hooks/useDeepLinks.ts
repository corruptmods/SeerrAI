import type { PlayLink } from '@app/utils/playLinks';
import { isAppleTouchDevice, withAppLinks } from '@app/utils/playLinks';
import { useEffect, useMemo, useState } from 'react';

/**
 * Play links for this device: Plex app links on iPhone/iPad. The first render
 * has web links, since the device is only known in the browser.
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
