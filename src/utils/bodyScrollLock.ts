interface Lockable {
  style: { overflow: string; touchAction: string };
}

interface LockState {
  holders: number;
  /** The page's styles before the first lock. */
  saved: { overflow: string; touchAction: string };
}

const states = new WeakMap<Lockable, LockState>();

/**
 * Locks page scroll behind a panel or dialog; returns the release function.
 * Locks are counted: the first saves the page's styles and the last release
 * restores them, in any order, so overlapping locks can't leave the page
 * stuck unscrollable.
 */
export const lockBodyScroll = (body: Lockable): (() => void) => {
  let state = states.get(body);
  if (!state || state.holders === 0) {
    state = {
      holders: 0,
      saved: {
        overflow: body.style.overflow,
        touchAction: body.style.touchAction,
      },
    };
    states.set(body, state);
    body.style.overflow = 'hidden';
    body.style.touchAction = 'none';
  }
  state.holders += 1;
  const held = state;

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    held.holders -= 1;
    if (held.holders === 0) {
      body.style.overflow = held.saved.overflow;
      body.style.touchAction = held.saved.touchAction;
    }
  };
};

/** Whether any scroll lock is held. */
export const isBodyScrollLocked = (body: Lockable): boolean =>
  (states.get(body)?.holders ?? 0) > 0;
