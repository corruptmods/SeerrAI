import type { ThemeDefaults } from '@server/constants/theme';
import { useFormikContext } from 'formik';
import { useEffect, useRef } from 'react';

/**
 * Clears the theme file when the accent, or the background of a file with
 * dark colours, is changed by hand, since the file would hide the choice.
 * Importing sets them together and keeps it.
 */
export const useDropThemeFileOnChange = (): void => {
  const { values, setFieldValue } = useFormikContext<ThemeDefaults>();
  const { accent, customAccent, background, theme } = values;
  const last = useRef({ accent, customAccent, background, theme });

  useEffect(() => {
    const before = last.current;
    last.current = { accent, customAccent, background, theme };
    if (!theme || theme !== before.theme) {
      return;
    }
    const accentChanged =
      accent !== before.accent || customAccent !== before.customAccent;
    const backgroundChanged = !!theme.dark && background !== before.background;
    if (accentChanged || backgroundChanged) {
      setFieldValue('theme', undefined);
    }
  }, [accent, customAccent, background, theme, setFieldValue]);
};
