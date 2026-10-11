import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Open dialogs, most recent last: only the top one answers the keyboard. */
const openDialogs: RefObject<HTMLElement | null>[] = [];

const focusableIn = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.closest('[aria-hidden="true"], [inert]') &&
      element.getClientRects().length > 0
  );

/**
 * What a dialog owes keyboard and screen reader users: focus moves into it
 * when it opens, Tab stays within it, Escape closes it, and focus goes back
 * to whatever opened it afterwards.
 */
const useDialogFocus = (
  ref: RefObject<HTMLElement | null>,
  {
    onEscape,
    ready = true,
  }: {
    /** Closes the dialog. Without it, Escape does nothing. */
    onEscape?: () => void;
    /** False while the dialog's panel is not shown yet (still loading). */
    ready?: boolean;
  } = {}
): void => {
  const escape = useRef(onEscape);

  useEffect(() => {
    escape.current = onEscape;
  });

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    openDialogs.push(ref);

    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = ref.current;
      if (!dialog || openDialogs[openDialogs.length - 1] !== ref) {
        return;
      }

      // A menu or picker inside the dialog closes itself on Escape and says
      // so by preventing the default; only an unclaimed Escape closes this.
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (escape.current) {
          event.preventDefault();
          escape.current();
        }
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = focusableIn(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = openDialogs.lastIndexOf(ref);
      if (index !== -1) {
        openDialogs.splice(index, 1);
      }
      if (opener && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [ref]);

  // Into the dialog once its panel is there, unless something in it (a
  // field marked autoFocus) has already taken focus. The dialog itself is
  // focused rather than its first control, so it is announced by its title
  // and nothing is pressed or ticked by accident.
  useEffect(() => {
    if (!ready) {
      return;
    }
    const settle = window.requestAnimationFrame(() => {
      const dialog = ref.current;
      if (dialog && !dialog.contains(document.activeElement)) {
        dialog.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(settle);
  }, [ref, ready]);
};

export default useDialogFocus;
