import { useEffect } from 'react';

/** Calls `callback` on clicks outside `ref`. */
const useClickOutside = (
  ref: React.RefObject<HTMLElement | null>,
  callback: (e: MouseEvent) => void
): void => {
  useEffect(() => {
    const handleBodyClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callback(e);
      }
    };
    document.body.addEventListener('click', handleBodyClick, { capture: true });

    return () => {
      document.body.removeEventListener('click', handleBodyClick);
    };
  }, [ref, callback]);
};

export default useClickOutside;
