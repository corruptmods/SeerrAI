import { useEffect, useState } from 'react';

/**
 * Tracks a CSS media query.
 *
 * Use this when the two branches are expensive to render — CSS `hidden`
 * classes still mount both subtrees in React, so timers, effects and network
 * requests inside them all run twice.
 *
 * Returns false during SSR and on the first client render so both server and
 * client agree on the initial markup.
 */
const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia(query);

    setMatches(mediaQuery.matches);

    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);

    mediaQuery.addEventListener('change', onChange);

    return () => {
      mediaQuery.removeEventListener('change', onChange);
    };
  }, [query]);

  return matches;
};

export default useMediaQuery;
