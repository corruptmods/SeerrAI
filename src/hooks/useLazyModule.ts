import { useEffect, useState } from 'react';

type Loader<T> = () => Promise<T>;

/*
 * On-demand modules, cached once loaded. Failures aren't cached, so the next
 * attempt retries; next/dynamic keeps failures until reload, and installed
 * phone apps have no reload button.
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

/** Preloads the module when idle; failures are silent. */
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
 * The module once `wanted` and loaded; undefined until then. `onError` runs
 * on failure so the caller can report it and close what was waiting.
 */
const useLazyModule = <T>(
  loader: Loader<T>,
  wanted: boolean,
  onError: () => void
): T | undefined => {
  // Stored with its loader, so switching loaders never returns the old module.
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
