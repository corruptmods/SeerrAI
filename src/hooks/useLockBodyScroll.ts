import { lockBodyScroll } from '@app/utils/bodyScrollLock';
import { useEffect } from 'react';

/**
 * Stops the page scrolling behind a panel or dialog while isLocked is true
 * and the component is mounted. Several can be locked at once; the page
 * scrolls again when the last lets go, whatever order they close in.
 *
 * @param isLocked Toggle the scroll lock
 * @param disabled Disables the entire hook (allows conditional skipping of the lock)
 */
export const useLockBodyScroll = (
  isLocked: boolean,
  disabled?: boolean
): void => {
  useEffect(() => {
    if (!isLocked || disabled) {
      return;
    }
    return lockBodyScroll(document.body);
  }, [isLocked, disabled]);
};
