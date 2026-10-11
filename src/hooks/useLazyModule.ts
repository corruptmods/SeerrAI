import { useEffect, useState } from 'react';

type Loader<T> = () => Promise<T>;

/*
 * Code loaded on demand (a dialog, an edit mode), remembered once it has
 * loaded. A failed load is not remembered: the next attempt tries again,
 * where next/dynamic would keep the failure until the page reloads — and an
 * installed app on a phone has no reload button.
 */
const loaded = new Map<Loader<unknown>, unknown>();
const loading = new Map<Loader<unknown>, Promise<unknown>>();

export const loadModule = <T>(loader: Loader<T>): Promise<T> => {
  if (loaded.has(loader)) {
    return Promise.resolve(loaded.get(loader) as T);
  }
  let pending = loading.get(loader) as Promise<T> | undefined;
  if (!pending) {
    pending = loader()
      .then((module) => {
        loaded.set(loader, module);
        return module;
      })
      .finally(() => loading.delete(loader));
    loading.set(loader, pending);
  }
  return pending;
};

/** Fetches the code while the browser is otherwise idle; failures are quiet. */
export const preloadModule = <T>(loader: Loader<T>): void => {
  if (loaded.has(loader) || loading.has(loader)) {
    return;
  }
  const load = () => {
    loadModule(loader).catch(() => undefined);
  };
  const idle = (
    window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: object) => void;
    }
  ).requestIdleCallback;
  if (idle) {
    idle(load, { timeout: 5000 });
  } else {
    window.setTimeout(load, 2000);
  }
};

/**
 * The module once `wanted` becomes true and it has loaded; undefined until
 * then. `onError` runs if it could not be loaded, so the caller can say so
 * and close whatever was waiting for it.
 */
const useLazyModule = <T>(
  loader: Loader<T>,
  wanted: boolean,
  onError: () => void
): T | undefined => {
  // Kept with the loader it came from, so a caller that switches to another
  // loader never gets the previous one's module.
  const [state, setState] = useState<{ loader: Loader<T>; module: T }>();
  const current =
    state?.loader === loader
      ? state.module
      : (loaded.get(loader) as T | undefined);

  useEffect(() => {
    if (!wanted || current) {
      return;
    }
    let active = true;
    loadModule(loader).then(
      (value) => active && setState({ loader, module: value }),
      () => active && onError()
    );
    return () => {
      active = false;
    };
    // onError is read when the load settles; a new one each render is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, wanted, current]);

  return current;
};

export default useLazyModule;
