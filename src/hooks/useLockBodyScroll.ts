import { lockBodyScroll } from '@app/utils/bodyScrollLock';
import { useEffect } from 'react';

/**
 * Locks page scroll while `isLocked` and mounted. Locks stack; the page
 * scrolls again when the last releases, in any order.
 *
 * @param disabled Skips the hook entirely
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
