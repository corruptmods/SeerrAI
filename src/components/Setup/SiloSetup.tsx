import Button from '@app/components/Common/Button';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import Tooltip from '@app/components/Common/Tooltip';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { InformationCircleIcon } from '@heroicons/react/24/solid';
import { ApiErrorCode } from '@server/constants/error';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { FormattedMessage, useIntl } from 'react-intl';
import isEmail from 'validator/lib/isEmail';
import * as Yup from 'yup';

/*
 * First-run setup with Silo as the primary server: Silo's address and a Silo
 * administrator's sign-in. Seerr AI creates its own API key with it (or uses
 * one pasted here, for a Silo whose household rules don't let a sign-in
 * create keys), and the administrator becomes the owner.
 */

const messages = defineMessages('components.Login', {
  username: 'Username',
  password: 'Password',
  hostname: '{mediaServerName} URL',
  port: 'Port',
  enablessl: 'Use SSL',
  urlBase: 'URL Base',
  email: 'Email Address',
  emailtooltip: 'It doesn’t have to match your {mediaServerName} account.',
  validationhostrequired: '{mediaServerName} URL required',
  validationemailrequired: 'You must provide a valid email address',
  validationemailformat: 'Valid email required',
  validationusernamerequired: 'Username required',
  validationPortRequired: 'You must provide a valid port number',
  validationUrlBaseLeadingSlash: 'URL base must have a leading slash',
  validationUrlBaseTrailingSlash: 'URL base must not end in a trailing slash',
  loginerror: 'Something went wrong while trying to sign in.',
  adminerror: 'You must use an admin account to sign in.',
  credentialerror: 'The username or password is incorrect.',
  invalidurlerror: 'Unable to connect to {mediaServerName} server.',
  signingin: 'Signing In…',
  signin: 'Sign In',
  back: 'Go back',
  siloPasswordChange:
    'This Silo account has a temporary password. Sign in to Silo, change it, then try again.',
  siloApiKey: 'API Key (optional)',
  siloApiKeyTip:
    'Seerr AI creates its own key when you sign in. Paste one only if Silo refuses that; it needs the admin:monitor:read and libraries:read scopes.',
  siloUrlBaseHelp: 'Only if Silo is reached under a path, such as /silo.',
});

interface SiloSetupProps {
  revalidate: () => void;
  onCancel?: () => void;
}

const SiloSetup = ({ revalidate, onCancel }: SiloSetupProps) => {
  const toasts = useToasts();
  const intl = useIntl();
  const values = { mediaServerName: 'Silo' };

  const schema = Yup.object().shape({
    hostname: Yup.string().required(
      intl.formatMessage(messages.validationhostrequired, values)
    ),
    port: Yup.number().required(
      intl.formatMessage(messages.validationPortRequired)
    ),
    urlBase: Yup.string()
      .test(
        'leading-slash',
        intl.formatMessage(messages.validationUrlBaseLeadingSlash),
        (value) => !value || value.startsWith('/')
      )
      .test(
        'trailing-slash',
        intl.formatMessage(messages.validationUrlBaseTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    email: Yup.string()
      .test(
        'email',
        intl.formatMessage(messages.validationemailformat),
        (value) => !value || isEmail(value, { require_tld: false })
      )
      .required(intl.formatMessage(messages.validationemailrequired)),
    username: Yup.string().required(
      intl.formatMessage(messages.validationusernamerequired)
    ),
    password: Yup.string(),
    apiKey: Yup.string(),
  });

  return (
    <Formik
      initialValues={{
        username: '',
        password: '',
        hostname: '',
        port: 8090,
        useSsl: false,
        urlBase: '',
        email: '',
        apiKey: '',
      }}
      validationSchema={schema}
      onSubmit={async (form) => {
        try {
          await axios.post('/api/v1/auth/silo', {
            username: form.username,
            password: form.password,
            hostname: form.hostname,
            port: Number(form.port),
            useSsl: form.useSsl,
            urlBase: form.urlBase,
            email: form.email,
            ...(form.apiKey ? { apiKey: form.apiKey } : {}),
          });
        } catch (e) {
          const code = e?.response?.data?.message;
          const known: Record<string, string> = {
            [ApiErrorCode.ConnectionError]: intl.formatMessage(
              messages.invalidurlerror,
              values
            ),
            [ApiErrorCode.InvalidCredentials]: intl.formatMessage(
              messages.credentialerror
            ),
            [ApiErrorCode.NotAdmin]: intl.formatMessage(messages.adminerror),
            [ApiErrorCode.PasswordChangeRequired]: intl.formatMessage(
              messages.siloPasswordChange
            ),
          };
          // Silo's own plain reasons (a missing scope, say) are shown as sent.
          toasts.addToast(
            known[code] ??
              (typeof code === 'string' && code.includes(' ')
                ? code
                : intl.formatMessage(messages.loginerror)),
            { autoDismiss: true, appearance: 'error' }
          );
        } finally {
          revalidate();
        }
      }}
    >
      {({
        errors,
        touched,
        values: form,
        setFieldValue,
        isSubmitting,
        isValid,
      }) => (
        <Form>
          <div className="sm:border-t sm:border-gray-800 light:sm:border-subtle">
            <div className="flex flex-col sm:flex-row sm:gap-4">
              <div className="w-full">
                <label htmlFor="hostname" className="text-label">
                  {intl.formatMessage(messages.hostname, values)}
                </label>
                <div className="mb-2 mt-1 sm:col-span-2 sm:mb-0 sm:mt-0">
                  <div className="flex rounded-md shadow-sm">
                    <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                      {form.useSsl ? 'https://' : 'http://'}
                    </span>
                    <Field
                      id="hostname"
                      name="hostname"
                      type="text"
                      className="rounded-r-only flex-1"
                      placeholder={intl.formatMessage(
                        messages.hostname,
                        values
                      )}
                      autoComplete="off"
                      data-form-type="other"
                      data-1pignore="true"
                      data-lpignore="true"
                      data-bwignore="true"
                    />
                  </div>
                  {errors.hostname && touched.hostname && (
                    <div className="error">{errors.hostname}</div>
                  )}
                </div>
              </div>
              <div className="flex-1">
                <label htmlFor="port" className="text-label">
                  {intl.formatMessage(messages.port)}
                </label>
                <div className="mt-1 sm:mt-0">
                  <Field
                    id="port"
                    name="port"
                    inputMode="numeric"
                    type="text"
                    className="short flex-1"
                    placeholder={intl.formatMessage(messages.port)}
                  />
                  {errors.port && touched.port && (
                    <div className="error">{errors.port}</div>
                  )}
                </div>
              </div>
            </div>
            <label htmlFor="useSsl" className="text-label mt-2">
              {intl.formatMessage(messages.enablessl)}
            </label>
            <div className="mb-2 mt-1 sm:col-span-2">
              <div className="flex rounded-md shadow-sm">
                <Field
                  id="useSsl"
                  name="useSsl"
                  type="checkbox"
                  onChange={() => {
                    setFieldValue('useSsl', !form.useSsl);
                    setFieldValue('port', form.useSsl ? 8090 : 443);
                  }}
                />
              </div>
            </div>
            <label
              htmlFor="urlBase"
              className="text-label mt-1 inline-flex gap-1 align-middle"
            >
              {intl.formatMessage(messages.urlBase)}
              <span className="label-tip">
                <Tooltip content={intl.formatMessage(messages.siloUrlBaseHelp)}>
                  <span className="tooltip-trigger">
                    <InformationCircleIcon className="h-4 w-4" />
                  </span>
                </Tooltip>
              </span>
            </label>
            <div className="mb-2 mt-1 sm:col-span-2 sm:mt-0">
              <div className="flex rounded-md shadow-sm">
                <Field
                  type="text"
                  inputMode="url"
                  id="urlBase"
                  name="urlBase"
                  placeholder={intl.formatMessage(messages.urlBase)}
                />
              </div>
              {errors.urlBase && touched.urlBase && (
                <div className="error">{errors.urlBase}</div>
              )}
            </div>
            <label
              htmlFor="email"
              className="text-label inline-flex gap-1 align-middle"
            >
              {intl.formatMessage(messages.email)}
              <span className="label-tip">
                <Tooltip
                  content={intl.formatMessage(messages.emailtooltip, values)}
                >
                  <span className="tooltip-trigger">
                    <InformationCircleIcon className="h-4 w-4" />
                  </span>
                </Tooltip>
              </span>
            </label>
            <div className="mt-1 sm:col-span-2 sm:mb-2 sm:mt-0">
              <div className="flex rounded-md shadow-sm">
                <Field
                  id="email"
                  name="email"
                  type="text"
                  placeholder={intl.formatMessage(messages.email)}
                  autoComplete="off"
                  data-form-type="other"
                />
              </div>
              {errors.email && touched.email && (
                <div className="error">{errors.email}</div>
              )}
            </div>
            <label htmlFor="username" className="text-label">
              {intl.formatMessage(messages.username)}
            </label>
            <div className="mb-2 mt-1 sm:col-span-2 sm:mt-0">
              <div className="flex rounded-md shadow-sm">
                <Field
                  id="username"
                  name="username"
                  type="text"
                  placeholder={intl.formatMessage(messages.username)}
                  autoComplete="off"
                  data-form-type="other"
                />
              </div>
              {errors.username && touched.username && (
                <div className="error">{errors.username}</div>
              )}
            </div>
            <label htmlFor="password" className="text-label">
              {intl.formatMessage(messages.password)}
            </label>
            <div className="mb-2 mt-1 sm:col-span-2 sm:mt-0">
              <div className="flex rounded-md shadow-sm">
                <Field
                  id="password"
                  name="password"
                  type="password"
                  placeholder={intl.formatMessage(messages.password)}
                  autoComplete="off"
                  data-form-type="other"
                />
              </div>
            </div>
            <label
              htmlFor="apiKey"
              className="text-label inline-flex gap-1 align-middle"
            >
              {intl.formatMessage(messages.siloApiKey)}
              <span className="label-tip">
                <Tooltip content={intl.formatMessage(messages.siloApiKeyTip)}>
                  <span className="tooltip-trigger">
                    <InformationCircleIcon className="h-4 w-4" />
                  </span>
                </Tooltip>
              </span>
            </label>
            <div className="mb-2 mt-1 sm:col-span-2 sm:mt-0">
              <div className="flex rounded-md shadow-sm">
                <SensitiveInput
                  as="field"
                  id="apiKey"
                  name="apiKey"
                  type="text"
                  autoComplete="off"
                />
              </div>
            </div>
          </div>
          <div className="mt-8 border-t border-gray-700 pt-5">
            <div className="flex flex-row-reverse justify-between">
              <span className="inline-flex rounded-md shadow-sm">
                <Button
                  buttonType="primary"
                  type="submit"
                  disabled={isSubmitting || !isValid}
                >
                  {intl.formatMessage(
                    isSubmitting ? messages.signingin : messages.signin
                  )}
                </Button>
              </span>
              {onCancel && (
                <span className="inline-flex rounded-md shadow-sm">
                  <Button buttonType="default" onClick={() => onCancel()}>
                    <FormattedMessage {...messages.back} />
                  </Button>
                </span>
              )}
            </div>
          </div>
        </Form>
      )}
    </Formik>
  );
};

export default SiloSetup;
