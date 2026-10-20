import Button from '@app/components/Common/Button';
import ImportThemeButton from '@app/components/Themes/ImportThemeButton';
import LookSwatch from '@app/components/Themes/LookSwatch';
import { useDropThemeFileOnChange } from '@app/components/Themes/useThemeFile';
import defineMessages from '@app/utils/defineMessages';
import { isSafeMode } from '@app/utils/theme/safeMode';
import {
  THEME_GALLERY,
  appearanceWithThemeFile,
  exportThemeFile,
  galleryLookIn,
} from '@app/utils/theme/themeFile';
import { ArrowDownTrayIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { Appearance } from '@server/constants/theme';
import { appearanceFromDefaults } from '@server/constants/theme';
import { useFormikContext } from 'formik';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Themes.ThemeChoices', {
  themes: 'Themes',
  description:
    'Ready-made looks, or one shared with you. Updates can’t break theme files.',
  classic: 'Seerr Classic',
  midnight: 'Midnight',
  daylight: 'Daylight',
  ember: 'Ember',
  builtIn: 'Built in',
  exportTheme: 'Export My Theme',
  myTheme: 'My Seerr AI theme',
  usingFile: 'Using the theme file {name}',
  usingFileBy: 'Using the theme file {name}, by {author}',
  saveToKeep: 'Save Changes to keep it.',
  stopUsing: 'Stop Using It',
  safeMode:
    'Safe mode is on in this tab, so theme files aren’t shown. Your choice is still saved.',
});

/** The gallery's names, by id. */
const GALLERY_NAMES = {
  classic: messages.classic,
  midnight: messages.midnight,
  daylight: messages.daylight,
  ember: messages.ember,
} as const;

/** A theme file's name made safe to save a file as. */
const fileName = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'theme'
  }.seerr-theme.json`;

/**
 * Profile → Settings → Appearance → Themes: the built-in looks, importing
 * a theme file (with a preview first) and exporting one's own. Part of the
 * Appearance form: a choice shows at once and is kept on Save.
 */
const ThemeChoices = ({ isOwn }: { isOwn: boolean }) => {
  const intl = useIntl();
  const { values, setValues, setFieldValue } = useFormikContext<Appearance>();
  const [imported, setImported] = useState(false);
  const [safe, setSafe] = useState(false);

  useDropThemeFileOnChange();
  useEffect(() => setSafe(isSafeMode()), []);
  useEffect(() => {
    if (!values.theme) {
      setImported(false);
    }
  }, [values.theme]);

  const current = galleryLookIn(values);

  const download = () => {
    const file = exportThemeFile(values, intl.formatMessage(messages.myTheme));
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(file, null, 2)}\n`], {
        type: 'application/json',
      })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName(file.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section
      aria-labelledby="appearance-themes"
      className="flex flex-col gap-3"
      data-seerr="setting-section"
    >
      <h2 id="appearance-themes" className="text-lg font-semibold text-strong">
        {intl.formatMessage(messages.themes)}
      </h2>
      <p className="text-sm text-muted">
        {intl.formatMessage(messages.description)}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {THEME_GALLERY.map((entry) => {
          const look = appearanceFromDefaults({
            ...values,
            ...entry.look,
            theme: undefined,
          });
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={current?.id === entry.id}
              onClick={() =>
                setValues({ ...values, ...entry.look, theme: undefined })
              }
              className={`flex flex-col gap-2 rounded-xl border-2 bg-surface p-2.5 text-left text-sm font-semibold text-strong transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                current?.id === entry.id
                  ? 'border-accent'
                  : 'border-subtle hover:border-strong'
              }`}
            >
              <LookSwatch
                look={look}
                mode={look.mode === 'light' ? 'light' : 'dark'}
              />
              <span>{intl.formatMessage(GALLERY_NAMES[entry.id])}</span>
              <span className="-mt-1.5 text-xs font-normal text-muted">
                {intl.formatMessage(messages.builtIn)}
              </span>
            </button>
          );
        })}
      </div>
      {values.theme && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent bg-accent-soft/10 p-3">
          <div className="min-w-0 text-sm text-strong">
            <span className="font-semibold">
              {values.theme.author
                ? intl.formatMessage(messages.usingFileBy, {
                    name: values.theme.name,
                    author: values.theme.author,
                  })
                : intl.formatMessage(messages.usingFile, {
                    name: values.theme.name,
                  })}
            </span>
            {imported && (
              <span className="ml-1 text-muted">
                {intl.formatMessage(messages.saveToKeep)}
              </span>
            )}
          </div>
          <Button
            type="button"
            buttonSize="sm"
            onClick={() => setFieldValue('theme', undefined)}
          >
            <XMarkIcon />
            <span>{intl.formatMessage(messages.stopUsing)}</span>
          </Button>
        </div>
      )}
      {safe && isOwn && (
        <p className="text-sm text-muted">
          {intl.formatMessage(messages.safeMode)}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <ImportThemeButton
          base={values}
          onApply={(theme) => {
            setValues(appearanceWithThemeFile(values, theme));
            setImported(true);
          }}
        />
        <Button type="button" onClick={download}>
          <ArrowDownTrayIcon />
          <span>{intl.formatMessage(messages.exportTheme)}</span>
        </Button>
      </div>
    </section>
  );
};

export default ThemeChoices;
