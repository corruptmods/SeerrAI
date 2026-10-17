import Button from '@app/components/Common/Button';
import ImportThemeButton from '@app/components/Themes/ImportThemeButton';
import { useDropThemeFileOnChange } from '@app/components/Themes/useThemeFile';
import defineMessages from '@app/utils/defineMessages';
import { appearanceWithThemeFile } from '@app/utils/theme/themeFile';
import { XMarkIcon } from '@heroicons/react/24/outline';
import type { ThemeDefaults } from '@server/constants/theme';
import { appearanceFromDefaults } from '@server/constants/theme';
import { useFormikContext } from 'formik';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Themes.DefaultThemeFile', {
  themeFile: 'Theme file',
  themeFileTip: 'Or use a theme file, made for everyone',
  using: 'Everyone using the default gets the theme file {name}.',
  usingBy:
    'Everyone using the default gets the theme file {name}, by {author}.',
  saveToKeep: 'Save Changes to keep it.',
  stopUsing: 'Stop Using It',
});

/**
 * Settings → Appearance: a theme file as the server's default, in the
 * default's form. Importing one sets the mode and accent from it too; it
 * is kept on Save.
 */
const DefaultThemeFile = () => {
  const intl = useIntl();
  const { values, setValues, setFieldValue, initialValues } =
    useFormikContext<ThemeDefaults>();
  useDropThemeFileOnChange();
  const theme = values.theme;

  return (
    <div className="form-row">
      <span className="text-label group-label">
        {intl.formatMessage(messages.themeFile)}
        <span className="label-tip">
          {intl.formatMessage(messages.themeFileTip)}
        </span>
      </span>
      <div className="form-input-area flex flex-col items-start gap-3">
        {theme && (
          <p className="text-sm text-strong">
            {theme.author
              ? intl.formatMessage(messages.usingBy, {
                  name: theme.name,
                  author: theme.author,
                })
              : intl.formatMessage(messages.using, { name: theme.name })}
            {theme !== initialValues.theme && (
              <span className="ml-1 text-muted">
                {intl.formatMessage(messages.saveToKeep)}
              </span>
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <ImportThemeButton
            base={appearanceFromDefaults(values)}
            onApply={(file) => setValues(appearanceWithThemeFile(values, file))}
          />
          {theme && (
            <Button
              type="button"
              onClick={() => setFieldValue('theme', undefined)}
            >
              <XMarkIcon />
              <span>{intl.formatMessage(messages.stopUsing)}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default DefaultThemeFile;
