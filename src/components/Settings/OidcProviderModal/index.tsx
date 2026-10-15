import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import CopyButton from '@app/components/Settings/CopyButton';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  DEFAULT_OIDC_SCOPES,
  oidcCallbackUrl,
  oidcProviderId,
} from '@server/constants/oidc';
import type { OidcProviderSettings } from '@server/lib/settings';
import axios, { isAxiosError } from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.OidcProviderModal', {
  addProvider: 'Add Single Sign-On Provider',
  editProvider: 'Edit Single Sign-On Provider',
  add: 'Add Provider',
  name: 'Name',
  nameTip: 'Shown on the sign-in button: "Sign in with {name}".',
  redirectUrl: 'Redirect URL',
  redirectUrlTip:
    'Paste this into the provider as the redirect (callback) URL of the client you make there for Seerr AI.',
  redirectUrlCopied: 'Redirect URL copied.',
  noApplicationUrl:
    'Set the Application URL in Settings → General first: it is the start of this address.',
  issuerUrl: 'Issuer URL',
  issuerUrlTip:
    'Exactly as the provider shows it, a slash at the end included or not. For example https://auth.example.com/application/o/seerr/ (Authentik), https://auth.example.com (Authelia), https://sso.example.com/realms/home (Keycloak), https://accounts.google.com.',
  issuerUrlLinked:
    'People who linked this provider stay linked to it. To use a different provider, add it as a new one instead.',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  clientSecretTip: 'Make the client "confidential" in the provider.',
  savedSecret: 'Saved. Leave blank to keep it.',
  logoUrl: 'Button Logo',
  logoUrlTip:
    'An https:// address of a small picture for the sign-in button. Optional.',
  scopes: 'Scopes',
  scopesTip:
    'What Seerr AI asks the provider for. "openid" is always asked for.',
  enabled: 'Enabled',
  enabledTip: 'Show this provider on the sign-in page and in Linked Accounts.',
  newUserSignUp: 'Let New People Sign Up',
  newUserSignUpTip:
    'Someone who signs in with this provider and has no account here gets one, with the default permissions. When off, only people who have linked this provider in their profile can sign in with it.',
  toastTestSuccess: 'Found {issuer}.',
  toastTestFailure: 'Could not use this provider: {reason}',
  noAnswer: 'it did not answer.',
  validationName: 'Enter a name',
  validationIssuerUrl: 'Enter the issuer URL, starting with https://',
  validationClientId: 'Enter the client ID',
  validationClientSecret: 'Enter the client secret',
  validationLogoUrl:
    'Enter an address starting with https://, or leave it blank',
});

/** As the settings page is sent it: no secret, only that one is saved. */
export type ShownOidcProvider = OidcProviderSettings & {
  hasClientSecret: boolean;
  callbackUrl: string | null;
};

interface OidcProviderModalProps {
  /** The saved provider, or null to add one. */
  provider: ShownOidcProvider | null;
  /** The Application URL redirect URLs start with; blank when unset. */
  applicationUrl: string;
  /** Ids a new provider can't have. */
  takenIds: string[];
  onClose: () => void;
  onSave: () => void;
}

interface FormValues {
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  logoUrl: string;
  scopes: string;
  enabled: boolean;
  newUserSignUp: boolean;
}

const OidcProviderModal = ({
  provider,
  applicationUrl,
  takenIds,
  onClose,
  onSave,
}: OidcProviderModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);

  // A saved secret is only kept for the issuer it was saved for.
  const secretSaved = (values: FormValues) =>
    !!provider?.hasClientSecret &&
    values.issuerUrl.trim() === provider.issuerUrl;

  const schema = Yup.object().shape({
    name: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationName)),
    issuerUrl: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationIssuerUrl))
      .matches(
        /^https?:\/\/[^\s]+$/,
        intl.formatMessage(messages.validationIssuerUrl)
      ),
    clientId: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationClientId)),
    clientSecret: Yup.string().when('issuerUrl', {
      is: (issuerUrl: string) =>
        !!provider?.hasClientSecret &&
        (issuerUrl ?? '').trim() === provider.issuerUrl,
      then: (s) => s,
      otherwise: (s) =>
        s.required(intl.formatMessage(messages.validationClientSecret)),
    }),
    logoUrl: Yup.string()
      .trim()
      .matches(
        /^(https:\/\/[^\s]+|\/[^/\\\s][^\s]*)?$/,
        intl.formatMessage(messages.validationLogoUrl)
      ),
  });

  const toBody = (values: FormValues) => ({
    name: values.name.trim(),
    issuerUrl: values.issuerUrl.trim(),
    clientId: values.clientId.trim(),
    clientSecret: values.clientSecret,
    logoUrl: values.logoUrl.trim(),
    scopes: values.scopes.trim(),
    enabled: values.enabled,
    newUserSignUp: values.newUserSignUp,
  });

  const reasonOf = (e: unknown) =>
    (isAxiosError(e) && (e.response?.data as { message?: string })?.message) ||
    intl.formatMessage(messages.noAnswer);

  const test = async (values: FormValues) => {
    setIsTesting(true);
    try {
      const { data } = await axios.post<{ issuer: string }>(
        '/api/v1/settings/oidc/test',
        {
          ...(provider ? { id: provider.id } : {}),
          issuerUrl: values.issuerUrl.trim(),
          clientId: values.clientId.trim(),
          clientSecret: values.clientSecret,
        }
      );
      addToast(
        intl.formatMessage(messages.toastTestSuccess, { issuer: data.issuer }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch (e) {
      addToast(
        intl.formatMessage(messages.toastTestFailure, { reason: reasonOf(e) }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setIsTesting(false);
    }
  };

  // The redirect URL a new provider will have, from its name; a saved
  // one's never changes.
  const redirectUrlFor = (name: string) =>
    applicationUrl
      ? oidcCallbackUrl(
          applicationUrl,
          provider?.id ?? oidcProviderId(name, takenIds)
        )
      : '';

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Formik<FormValues>
        initialValues={{
          name: provider?.name ?? '',
          issuerUrl: provider?.issuerUrl ?? '',
          clientId: provider?.clientId ?? '',
          clientSecret: '',
          logoUrl: provider?.logoUrl ?? '',
          scopes: provider?.scopes ?? DEFAULT_OIDC_SCOPES,
          enabled: provider?.enabled ?? true,
          newUserSignUp: provider?.newUserSignUp ?? false,
        }}
        validationSchema={schema}
        onSubmit={async (values) => {
          try {
            if (provider) {
              await axios.put(
                `/api/v1/settings/oidc/${encodeURIComponent(provider.id)}`,
                toBody(values)
              );
            } else {
              await axios.post('/api/v1/settings/oidc', toBody(values));
            }
            onSave();
          } catch (e) {
            addToast(
              intl.formatMessage(messages.toastTestFailure, {
                reason: reasonOf(e),
              }),
              { appearance: 'error', autoDismiss: true }
            );
          }
        }}
      >
        {({
          errors,
          touched,
          values,
          handleSubmit,
          setFieldValue,
          isSubmitting,
          isValid,
        }) => {
          const redirectUrl = redirectUrlFor(values.name);
          return (
            <Modal
              onCancel={onClose}
              okButtonType="primary"
              okText={
                isSubmitting
                  ? intl.formatMessage(globalMessages.saving)
                  : provider
                    ? intl.formatMessage(globalMessages.save)
                    : intl.formatMessage(messages.add)
              }
              secondaryButtonType="warning"
              secondaryText={
                isTesting
                  ? intl.formatMessage(globalMessages.testing)
                  : intl.formatMessage(globalMessages.test)
              }
              onSecondary={() => test(values)}
              secondaryDisabled={
                !values.issuerUrl ||
                !values.clientId ||
                (!values.clientSecret && !secretSaved(values)) ||
                isTesting ||
                isSubmitting
              }
              okDisabled={isSubmitting || isTesting || !isValid}
              onOk={() => handleSubmit()}
              title={intl.formatMessage(
                provider ? messages.editProvider : messages.addProvider
              )}
            >
              <div className="mb-6">
                <div className="form-row">
                  <label htmlFor="name" className="text-label">
                    {intl.formatMessage(messages.name)}
                    <span className="label-required">*</span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.nameTip, {
                        name: values.name.trim() || 'Authentik',
                      })}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field id="name" name="name" type="text" />
                    </div>
                    {errors.name && touched.name && (
                      <div className="error">{errors.name}</div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="redirectUrl" className="text-label">
                    {intl.formatMessage(messages.redirectUrl)}
                    <span className="label-tip">
                      {intl.formatMessage(
                        applicationUrl
                          ? messages.redirectUrlTip
                          : messages.noApplicationUrl
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <input
                        id="redirectUrl"
                        type="text"
                        className="rounded-l-only"
                        value={redirectUrl}
                        readOnly
                      />
                      <CopyButton
                        textToCopy={redirectUrl}
                        disabled={!redirectUrl}
                        toastMessage={intl.formatMessage(
                          messages.redirectUrlCopied
                        )}
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="issuerUrl" className="text-label">
                    {intl.formatMessage(messages.issuerUrl)}
                    <span className="label-required">*</span>
                    <span className="label-tip">
                      {intl.formatMessage(
                        provider
                          ? messages.issuerUrlLinked
                          : messages.issuerUrlTip
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="issuerUrl"
                        name="issuerUrl"
                        type="text"
                        inputMode="url"
                        placeholder="https://"
                      />
                    </div>
                    {errors.issuerUrl && touched.issuerUrl && (
                      <div className="error">{errors.issuerUrl}</div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="clientId" className="text-label">
                    {intl.formatMessage(messages.clientId)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="clientId"
                        name="clientId"
                        type="text"
                        autoComplete="off"
                      />
                    </div>
                    {errors.clientId && touched.clientId && (
                      <div className="error">{errors.clientId}</div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="clientSecret" className="text-label">
                    {intl.formatMessage(messages.clientSecret)}
                    {!secretSaved(values) && (
                      <span className="label-required">*</span>
                    )}
                    <span className="label-tip">
                      {intl.formatMessage(
                        secretSaved(values)
                          ? messages.savedSecret
                          : messages.clientSecretTip
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <SensitiveInput
                        as="field"
                        id="clientSecret"
                        name="clientSecret"
                        autoComplete="off"
                      />
                    </div>
                    {errors.clientSecret && touched.clientSecret && (
                      <div className="error">{errors.clientSecret}</div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="logoUrl" className="text-label">
                    {intl.formatMessage(messages.logoUrl)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.logoUrlTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="logoUrl"
                        name="logoUrl"
                        type="text"
                        inputMode="url"
                      />
                    </div>
                    {errors.logoUrl && touched.logoUrl && (
                      <div className="error">{errors.logoUrl}</div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="scopes" className="text-label">
                    {intl.formatMessage(messages.scopes)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.scopesTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field id="scopes" name="scopes" type="text" />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="enabled" className="checkbox-label">
                    {intl.formatMessage(messages.enabled)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.enabledTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="enabled"
                      name="enabled"
                      onChange={() => setFieldValue('enabled', !values.enabled)}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="newUserSignUp" className="checkbox-label">
                    {intl.formatMessage(messages.newUserSignUp)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.newUserSignUpTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="newUserSignUp"
                      name="newUserSignUp"
                      onChange={() =>
                        setFieldValue('newUserSignUp', !values.newUserSignUp)
                      }
                    />
                  </div>
                </div>
              </div>
            </Modal>
          );
        }}
      </Formik>
    </Transition>
  );
};

export default OidcProviderModal;
