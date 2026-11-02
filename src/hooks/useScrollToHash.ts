import { useEffect, useRef } from 'react';

/**
 * Scrolls to the part of the page the address names (`#review`), once the
 * page has drawn it. A link from a notification opens a page whose data is
 * still loading, so the browser finds nothing to scroll to at first; this
 * goes there when `ready` turns true, once a visit.
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
    // After this render's layout, so what's above it has its height.
    window.requestAnimationFrame(() =>
      target.scrollIntoView({ block: 'start' })
    );
  }, [ready]);
};

export default useScrollToHash;
