import type { ThemeDefaults } from '@server/constants/theme';
import { useFormikContext } from 'formik';
import { useEffect, useRef } from 'react';

/**
 * In a look's form: a theme file stops being used once someone picks
 * another accent by hand, or another dark background when the file has
 * its own dark colours, as the file's colours would otherwise hide the
 * choice. Importing a file, which sets them together with it, keeps it.
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
