interface Lockable {
  style: { overflow: string; touchAction: string };
}

interface LockState {
  holders: number;
  /** The page's own styles, from before the first lock. */
  saved: { overflow: string; touchAction: string };
}

const states = new WeakMap<Lockable, LockState>();

/**
 * Stops the page behind a panel or dialog scrolling, and gives back the
 * function that lets it go. Locks are counted: the page's own styles are
 * kept by the first and put back only when the last is released, in
 * whatever order that happens. Each lock used to put back what it saw when
 * it locked, so two that overlapped (a dialog still fading out as the AI
 * panel opened, say) left the page unable to scroll once both were gone;
 * on an iPhone the bottom bar then sat part-way up the screen.
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

/** Whether a panel or dialog is holding the page still. */
export const isBodyScrollLocked = (body: Lockable): boolean =>
  (states.get(body)?.holders ?? 0) > 0;
