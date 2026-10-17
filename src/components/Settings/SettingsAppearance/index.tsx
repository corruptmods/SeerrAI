import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SettingsSeasons from '@app/components/Seasonal/SettingsSeasons';
import DefaultThemeFile from '@app/components/Themes/DefaultThemeFile';
import ServerCss from '@app/components/Themes/ServerCss';
import {
  ACCENT_NAMES,
  accentSchema,
  appearanceMessages,
  BACKGROUND_NAMES,
  CustomAccentField,
} from '@app/components/UserProfile/UserSettings/UserAppearanceSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { CUSTOM_ACCENT_START } from '@app/utils/theme/palette';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import type { ThemeDefaults } from '@server/constants/theme';
import {
  cleanHexColour,
  THEME_ACCENTS,
  THEME_BACKGROUNDS,
} from '@server/constants/theme';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsAppearance', {
  appearance: 'Appearance',
  description:
    'How Seerr AI looks for people who haven’t picked their own look, and on the sign-in page. Everyone can still choose their own in their profile.',
  defaultTheme: 'Default theme',
  mode: 'Mode',
  modeAuto: 'Match the person’s device',
  accent: 'Accent colour',
  background: 'Dark background',
  backgroundTip: 'Used whenever Seerr AI is dark.',
  saved: 'Appearance settings saved.',
  failed: 'Something went wrong while saving.',
  loadFailed: 'The appearance settings could not be loaded.',
});

interface AppearanceSettings {
  default: ThemeDefaults;
}

/**
 * Settings → Appearance: the look of everyone who has not chosen their own,
 * and of the sign-in page.
 */
const SettingsAppearance = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const { data, error, mutate } = useSWR<AppearanceSettings>(
    '/api/v1/settings/appearance'
  );

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.appearance),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.appearance)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {!data && !error ? (
        <LoadingSpinner />
      ) : !data ? (
        <Alert type="error" title={intl.formatMessage(messages.loadFailed)}>
          <Button buttonSize="sm" onClick={() => mutate()}>
            <ArrowPathIcon />
            <span>{intl.formatMessage(globalMessages.retry)}</span>
          </Button>
        </Alert>
      ) : (
        <Formik<ThemeDefaults>
          initialValues={data.default}
          enableReinitialize
          validationSchema={Yup.object().shape({
            customAccent: accentSchema(
              intl.formatMessage(appearanceMessages.validationColour)
            ),
          })}
          onSubmit={async (values) => {
            try {
              const response = await axios.post<AppearanceSettings>(
                '/api/v1/settings/appearance',
                {
                  default: {
                    mode: values.mode,
                    accent: values.accent,
                    background: values.background,
                    ...(values.accent === 'custom' && {
                      customAccent: cleanHexColour(values.customAccent),
                    }),
                    ...(values.theme && { theme: values.theme }),
                  },
                }
              );
              await mutate(response.data, { revalidate: false });
              // Everyone using the default reads it from the public settings.
              await globalMutate('/api/v1/settings/public');
              addToast(intl.formatMessage(messages.saved), {
                appearance: 'success',
                autoDismiss: true,
              });
            } catch {
              addToast(intl.formatMessage(messages.failed), {
                appearance: 'error',
                autoDismiss: true,
              });
            }
          }}
        >
          {({ values, errors, isSubmitting, isValid, setFieldValue }) => (
            <Form>
              <h4 className="text-lg font-semibold text-strong">
                {intl.formatMessage(messages.defaultTheme)}
              </h4>
              <div className="section">
                <div className="form-row">
                  <label htmlFor="mode" className="text-label">
                    {intl.formatMessage(messages.mode)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field as="select" id="mode" name="mode">
                        <option value="auto">
                          {intl.formatMessage(messages.modeAuto)}
                        </option>
                        <option value="dark">
                          {intl.formatMessage(appearanceMessages.modeDark)}
                        </option>
                        <option value="light">
                          {intl.formatMessage(appearanceMessages.modeLight)}
                        </option>
                      </Field>
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="accent" className="text-label">
                    {intl.formatMessage(messages.accent)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        as="select"
                        id="accent"
                        name="accent"
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                          setFieldValue('accent', e.target.value);
                          if (
                            e.target.value === 'custom' &&
                            !values.customAccent
                          ) {
                            setFieldValue('customAccent', CUSTOM_ACCENT_START);
                          }
                        }}
                      >
                        {THEME_ACCENTS.map((accent) => (
                          <option key={accent} value={accent}>
                            {intl.formatMessage(
                              appearanceMessages[ACCENT_NAMES[accent]]
                            )}
                          </option>
                        ))}
                      </Field>
                    </div>
                    {values.accent === 'custom' && (
                      <div className="mt-3 max-w-xl">
                        <CustomAccentField
                          value={values.customAccent ?? ''}
                          error={errors.customAccent}
                          onChange={(value) =>
                            setFieldValue('customAccent', value)
                          }
                        />
                      </div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="background" className="text-label">
                    {intl.formatMessage(messages.background)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.backgroundTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field as="select" id="background" name="background">
                        {THEME_BACKGROUNDS.map((background) => (
                          <option key={background} value={background}>
                            {intl.formatMessage(
                              appearanceMessages[BACKGROUND_NAMES[background]]
                            )}
                          </option>
                        ))}
                      </Field>
                    </div>
                  </div>
                </div>
                <DefaultThemeFile />
                <div className="actions">
                  <div className="flex justify-end">
                    <span className="ml-3 inline-flex rounded-md shadow-sm">
                      <Button
                        buttonType="primary"
                        type="submit"
                        disabled={isSubmitting || !isValid}
                      >
                        <ArrowDownOnSquareIcon />
                        <span>
                          {isSubmitting
                            ? intl.formatMessage(globalMessages.saving)
                            : intl.formatMessage(globalMessages.save)}
                        </span>
                      </Button>
                    </span>
                  </div>
                </div>
              </div>
            </Form>
          )}
        </Formik>
      )}
      <SettingsSeasons />
      {data && <ServerCss />}
    </>
  );
};

export default SettingsAppearance;
