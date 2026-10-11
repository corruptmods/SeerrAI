import { useEffect, useRef, useState } from 'react';

/**
 * Whether an element has come within `margin` of the screen, as the page is
 * scrolled; once it has, it stays so. Used to start loading what is about to
 * be seen rather than waiting for it to arrive on screen.
 */
const useNearViewport = <T extends Element>(margin = '1000px 0px') => {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (near || !element) {
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, margin]);

  return { ref, near };
};

export default useNearViewport;
