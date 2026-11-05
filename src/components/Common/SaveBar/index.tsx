import { FormikContext } from 'formik';
import { useContext, useEffect, useRef, useState } from 'react';

interface SaveBarProps {
  /** Unsaved changes, when the page tracks them itself. */
  dirty?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * A page's Save area. With unsaved changes it sticks to the bottom of the
 * screen (above the phone's tab bar); saved, it sits in its place.
 *
 * Unsaved comes from `dirty`, else the Formik form (changed since loaded and
 * since the last Save), else any input in the enclosing form since the last
 * click on the bar.
 */
const SaveBar = ({ dirty, className = '', children }: SaveBarProps) => {
  const formik = useContext(FormikContext);
  const ref = useRef<HTMLDivElement>(null);
  const [touched, setTouched] = useState(false);
  // Formik forms that don't reload after saving stay "dirty", so the last
  // saved values count as saved.
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
    // Its own form, else section: changes elsewhere belong to another Save.
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

  // Whether it is stuck to the screen's bottom, away from its place. In its
  // place on screen, or scrolling past an edge, it looks as when saved.
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
      // Its sticky offset from the bottom varies with width (phone tab bar).
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
    // Page resizes move it without a scroll event.
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
