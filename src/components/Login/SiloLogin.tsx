import Button from '@app/components/Common/Button';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import SiloCodeModal from '@app/components/Login/SiloCodeModal';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowLeftOnRectangleIcon,
  QrCodeIcon,
} from '@heroicons/react/24/outline';
import { ExclamationTriangleIcon } from '@heroicons/react/24/solid';
import { ApiErrorCode } from '@server/constants/error';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useCallback, useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

/*
 * The sign-in form for Silo, laid out as the Jellyfin and Emby one: name and
 * password (Silo checks them, LDAP included), or a code approved in Silo.
 */

const messages = defineMessages('components.Login', {
  loginwithapp: 'Login with {appName}',
  username: 'Username',
  password: 'Password',
  validationusernamerequired: 'Username required',
  loginerror: 'Something went wrong while trying to sign in.',
  toomanyattempts: 'Too many sign-in attempts. Try again in a few minutes.',
  credentialerror: 'The username or password is incorrect.',
  invalidurlerror: 'Unable to connect to {mediaServerName} server.',
  tipUsernameHasTrailingWhitespace: 'The username ends with whitespace',
  signingin: 'Signing In…',
  signin: 'Sign In',
  forgotpassword: 'Forgot Password?',
  existingaccounterror:
    'Another account here uses this name as its email. Sign in with it, then link {mediaServerName} in your profile.',
  siloSignInWithCode: 'Sign in with a code',
  siloPasswordChange:
    'This Silo account has a temporary password. Sign in to Silo, change it, then try again.',
  siloAccessDenied:
    'This Silo account has no account here yet. Ask the owner to import it.',
});

interface SiloLoginProps {
  revalidate: () => void;
}

const SiloLogin = ({ revalidate }: SiloLoginProps) => {
  const toasts = useToasts();
  const intl = useIntl();
  const settings = useSettings();
  const [showCode, setShowCode] = useState(false);
  const values = { mediaServerName: 'Silo' };

  /** Words for a refusal, from the server's error code or status. */
  const describe = useCallback(
    (code: string | undefined, status?: number): string => {
      switch (code) {
        case ApiErrorCode.InvalidCredentials:
          return intl.formatMessage(messages.credentialerror);
        case ApiErrorCode.ConnectionError:
          return intl.formatMessage(messages.invalidurlerror, values);
        case ApiErrorCode.ExistingAccount:
          return intl.formatMessage(messages.existingaccounterror, values);
        case ApiErrorCode.PasswordChangeRequired:
          return intl.formatMessage(messages.siloPasswordChange);
        case 'Access denied.':
          return intl.formatMessage(messages.siloAccessDenied);
      }
      if (status === 429) {
        return intl.formatMessage(messages.toomanyattempts);
      }
      return intl.formatMessage(messages.loginerror);
    },
    // values is constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [intl]
  );

  const schema = Yup.object().shape({
    username: Yup.string().required(
      intl.formatMessage(messages.validationusernamerequired)
    ),
    password: Yup.string(),
  });
  const forgotPasswordUrl = settings.currentSettings.siloForgotPasswordUrl;

  return (
    <div>
      <Formik
        initialValues={{ username: '', password: '' }}
        validationSchema={schema}
        validateOnBlur={false}
        onSubmit={async (form) => {
          try {
            await axios.post('/api/v1/auth/silo', {
              username: form.username,
              password: form.password,
              email: form.username,
            });
          } catch (e) {
            toasts.addToast(
              describe(e?.response?.data?.message, e?.response?.status),
              { autoDismiss: true, appearance: 'error' }
            );
          } finally {
            revalidate();
          }
        }}
      >
        {({ errors, touched, values: form, isSubmitting, isValid }) => (
          <Form data-form-type="login">
            <div>
              <h2 className="-mt-1 mb-6 text-center text-lg font-bold text-neutral-200 light:text-strong">
                {intl.formatMessage(messages.loginwithapp, { appName: 'Silo' })}
              </h2>

              <div className="mb-4 mt-1">
                <div className="form-input-field">
                  <Field
                    id="username"
                    name="username"
                    type="text"
                    placeholder={intl.formatMessage(messages.username)}
                    className="!bg-gray-700/80 placeholder:text-gray-400 light:!bg-field"
                    data-form-type="username"
                  />
                </div>
                {touched.username && form.username.match(/\s$/) && (
                  <div className="warning label-tip flex items-center">
                    <ExclamationTriangleIcon className="mr-1 h-4 w-4" />
                    {intl.formatMessage(
                      messages.tipUsernameHasTrailingWhitespace
                    )}
                  </div>
                )}
                {errors.username && touched.username && (
                  <div className="error">{errors.username}</div>
                )}
              </div>

              <div className="mb-2 mt-1">
                <div className="form-input-field">
                  <SensitiveInput
                    as="field"
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder={intl.formatMessage(messages.password)}
                    className="!bg-gray-700/80 placeholder:text-gray-400 light:!bg-field"
                    data-form-type="password"
                    data-1pignore="false"
                    data-lpignore="false"
                  />
                </div>
                <div className="flex">
                  <div className="flex-grow" />
                  {forgotPasswordUrl && (
                    <a
                      href={forgotPasswordUrl}
                      className="pt-2 text-sm text-accent-text hover:text-indigo-400 light:hover:text-accent-text"
                    >
                      {intl.formatMessage(messages.forgotpassword)}
                    </a>
                  )}
                </div>
              </div>
            </div>

            <Button
              buttonType="primary"
              type="submit"
              disabled={isSubmitting || !isValid}
              className="mt-2 w-full shadow-sm"
            >
              <ArrowLeftOnRectangleIcon />
              <span>
                {intl.formatMessage(
                  isSubmitting ? messages.signingin : messages.signin
                )}
              </span>
            </Button>
          </Form>
        )}
      </Formik>

      <div className="mt-4">
        <Button
          buttonType="ghost"
          type="button"
          onClick={() => setShowCode(true)}
          className="w-full"
        >
          <QrCodeIcon />
          <span>{intl.formatMessage(messages.siloSignInWithCode)}</span>
        </Button>
      </div>

      {showCode && (
        <SiloCodeModal
          endpoint="/api/v1/auth/silo"
          onApproved={() => {
            setShowCode(false);
            revalidate();
          }}
          onClose={() => setShowCode(false)}
          describeError={describe}
        />
      )}
    </div>
  );
};

export default SiloLogin;
