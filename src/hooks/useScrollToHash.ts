import { useEffect, useRef } from 'react';

/**
 * Scrolls to the URL hash (`#review`) once `ready`, once per visit. The
 * browser can't, since notification links open pages still loading data.
 */
const useScrollToHash = (ready: boolean): void => {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    done.current = true;
    // After layout, so content above has its height.
    window.requestAnimationFrame(() =>
      target.scrollIntoView({ block: 'start' })
    );
  }, [ready]);
};

export default useScrollToHash;
