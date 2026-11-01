import { FormikContext } from 'formik';
import { useContext, useEffect, useRef, useState } from 'react';

interface SaveBarProps {
  /** Whether there are unsaved changes, when the page knows it itself. */
  dirty?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * A page's Save area. While there are unsaved changes it floats at the
 * bottom of the screen (above the phone's tab bar), wherever the page is
 * scrolled to, so saving never means scrolling to the end; saved, it sits
 * back in its place.
 *
 * Unsaved is what the page says (dirty), else what its Formik form says
 * (changed since loaded, and since the last Save), else any change typed
 * or chosen in the form around it since the last click on the bar.
 */
const SaveBar = ({ dirty, className = '', children }: SaveBarProps) => {
  const formik = useContext(FormikContext);
  const ref = useRef<HTMLDivElement>(null);
  const [touched, setTouched] = useState(false);
  // Formik forms that don't reload what they saved stay "dirty" after a
  // Save: the values saved last count as saved.
  const [savedValues, setSavedValues] = useState<string | null>(null);
  const values = formik ? JSON.stringify(formik.values) : null;
  const submitting = !!formik?.isSubmitting;

  useEffect(() => {
    if (formik && !submitting && formik.submitCount > 0) {
      setSavedValues(values);
    }
    // Only when a submit finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting]);

  useEffect(() => {
    if (dirty !== undefined || formik) return;
    // Its own form, else its own section: a change elsewhere on the page is
    // another Save's.
    const scope =
      ref.current?.closest('form') ??
      ref.current?.closest('section') ??
      ref.current?.closest('main') ??
      null;
    if (!scope) return;
    const mark = () => setTouched(true);
    scope.addEventListener('input', mark);
    scope.addEventListener('change', mark);
    return () => {
      scope.removeEventListener('input', mark);
      scope.removeEventListener('change', mark);
    };
  }, [dirty, formik]);

  const unsaved =
    dirty !== undefined
      ? dirty
      : formik
        ? formik.dirty && values !== savedValues
        : touched;

  // Whether it is held at the bottom of the screen, away from its place.
  // Where Save is already on screen, as at the end of a short page, or cut
  // off by an edge of the screen as the page scrolls past it, it looks as
  // it does saved.
  const [floating, setFloating] = useState(false);
  useEffect(() => {
    const bar = ref.current;
    if (!unsaved || !bar) {
      setFloating(false);
      return;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      // Where it is held: its distance from the bottom of the screen, which
      // changes with the screen's width (the phone's tab bar).
      const line =
        window.innerHeight - (parseFloat(getComputedStyle(bar).bottom) || 0);
      const box = bar.getBoundingClientRect();
      setFloating(Math.abs(box.bottom - line) < 1 && box.top < line);
    };
    const soon = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener('scroll', soon, { passive: true });
    window.addEventListener('resize', soon);
    // A page that grows or shrinks moves it without a scroll.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(soon);
    observer?.observe(document.body);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      observer?.disconnect();
    };
  }, [unsaved]);

  return (
    <div
      ref={ref}
      className={`actions ${unsaved ? 'actions-unsaved' : ''} ${
        unsaved && floating ? 'actions-floating' : ''
      } ${className}`}
      onClickCapture={
        dirty === undefined && !formik ? () => setTouched(false) : undefined
      }
    >
      {children}
    </div>
  );
};

export default SaveBar;
