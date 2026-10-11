import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type { TautulliSettings } from '@server/lib/settings';
import axios, { isAxiosError } from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.TautulliModal', {
  createTautulli: 'Add Tautulli',
  editTautulli: 'Edit Tautulli',
  add: 'Add Tautulli',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  ssl: 'Use SSL',
  urlBase: 'URL Base',
  apiKey: 'API Key',
  apiKeyTip: 'In Tautulli: Settings → Web Interface → API.',
  externalUrl: 'External URL',
  externalUrlTip: 'Where people open Tautulli, if not at the address above.',
  validationExternalUrl:
    'You must provide a valid URL, without a trailing slash',
  savedSecret: 'Saved. Leave blank to keep it.',
  toastTestSuccess: 'Connected to Tautulli {version}.',
  toastTestFailure: 'Could not connect: {reason}',
  noAnswer: 'it did not answer.',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationApiKeyRequired: 'You must provide the API key',
});

/** As the settings page is sent it: no key, only that one is set. */
export type ShownTautulli = TautulliSettings & { hasApiKey?: boolean };

interface TautulliModalProps {
  /** The saved Tautulli, or null to add it. */
  tautulli: ShownTautulli | null;
  onClose: () => void;
  onSave: () => void;
}

const TautulliModal = ({ tautulli, onClose, onSave }: TautulliModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  // Editing starts from a Tautulli that already worked; a new one must pass
  // a test before it can be added.
  const [isValidated, setIsValidated] = useState(!!tautulli);

  const schema = Yup.object().shape({
    hostname: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationHostnameRequired))
      .matches(
        /^[^\s/:]+$/,
        intl.formatMessage(messages.validationHostnameRequired)
      ),
    port: Yup.number()
      .typeError(intl.formatMessage(messages.validationPortRequired))
      .integer()
      .min(1, intl.formatMessage(messages.validationPortRequired))
      .max(65535, intl.formatMessage(messages.validationPortRequired))
      .required(intl.formatMessage(messages.validationPortRequired)),
    apiKey: tautulli?.hasApiKey
      ? Yup.string()
      : Yup.string().required(
          intl.formatMessage(messages.validationApiKeyRequired)
        ),
    externalUrl: Yup.string()
      .trim()
      .matches(
        /^https?:\/\/\S+[^/]$/,
        intl.formatMessage(messages.validationExternalUrl)
      ),
  });

  interface FormValues {
    hostname: string;
    port: number | string;
    useSsl: boolean;
    urlBase: string;
    apiKey: string;
    externalUrl: string;
  }

  const toBody = (values: FormValues) => ({
    hostname: values.hostname.trim(),
    port: Number(values.port),
    useSsl: values.useSsl,
    urlBase: values.urlBase.trim(),
    apiKey: values.apiKey,
    externalUrl: values.externalUrl.trim(),
  });

  const reasonOf = (e: unknown) =>
    (isAxiosError(e) && (e.response?.data as { message?: string })?.message) ||
    intl.formatMessage(messages.noAnswer);

  const testConnection = async (values: FormValues) => {
    setIsTesting(true);
    try {
      const { data } = await axios.post<{ version: string }>(
        '/api/v1/settings/tautulli/test',
        toBody(values)
      );
      setIsValidated(true);
      addToast(
        intl.formatMessage(messages.toastTestSuccess, {
          version: data.version,
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch (e) {
      setIsValidated(false);
      addToast(
        intl.formatMessage(messages.toastTestFailure, { reason: reasonOf(e) }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setIsTesting(false);
    }
  };

  // Changing where Tautulli is, or its key, means the earlier test no longer
  // counts.
  const connectionField = (
    setFieldValue: (field: string, value: unknown) => void,
    field: keyof FormValues,
    value: unknown
  ) => {
    setIsValidated(false);
    setFieldValue(field, value);
  };

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
          hostname: tautulli?.hostname ?? '',
          port: tautulli?.port ?? 8181,
          useSsl: tautulli?.useSsl ?? false,
          urlBase: tautulli?.urlBase ?? '',
          apiKey: '',
          externalUrl: tautulli?.externalUrl ?? '',
        }}
        validationSchema={schema}
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/tautulli', toBody(values));
            onSave();
          } catch (e) {
            // The server tests the connection again before saving.
            setIsValidated(false);
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
        }) => (
          <Modal
            onCancel={onClose}
            okButtonType="primary"
            okText={
              isSubmitting
                ? intl.formatMessage(globalMessages.saving)
                : tautulli
                  ? intl.formatMessage(globalMessages.save)
                  : intl.formatMessage(messages.add)
            }
            secondaryButtonType="warning"
            secondaryText={
              isTesting
                ? intl.formatMessage(globalMessages.testing)
                : intl.formatMessage(globalMessages.test)
            }
            onSecondary={() => testConnection(values)}
            secondaryDisabled={
              !values.hostname || !values.port || isTesting || isSubmitting
            }
            okDisabled={!isValidated || isSubmitting || isTesting || !isValid}
            onOk={() => handleSubmit()}
            title={intl.formatMessage(
              tautulli ? messages.editTautulli : messages.createTautulli
            )}
          >
            <div className="mb-6">
              <div className="form-row">
                <label htmlFor="hostname" className="text-label">
                  {intl.formatMessage(messages.hostname)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                      {values.useSsl ? 'https://' : 'http://'}
                    </span>
                    <Field
                      id="hostname"
                      name="hostname"
                      type="text"
                      inputMode="url"
                      className="rounded-r-only"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        connectionField(
                          setFieldValue,
                          'hostname',
                          e.target.value
                        )
                      }
                    />
                  </div>
                  {errors.hostname && touched.hostname && (
                    <div className="error">{errors.hostname}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="port" className="text-label">
                  {intl.formatMessage(messages.port)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <Field
                    id="port"
                    name="port"
                    type="text"
                    inputMode="numeric"
                    className="short"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      connectionField(setFieldValue, 'port', e.target.value)
                    }
                  />
                  {errors.port && touched.port && (
                    <div className="error">{errors.port}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="useSsl" className="checkbox-label">
                  {intl.formatMessage(messages.ssl)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="useSsl"
                    name="useSsl"
                    onChange={() =>
                      connectionField(setFieldValue, 'useSsl', !values.useSsl)
                    }
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="urlBase" className="text-label">
                  {intl.formatMessage(messages.urlBase)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="urlBase"
                      name="urlBase"
                      type="text"
                      inputMode="url"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        connectionField(
                          setFieldValue,
                          'urlBase',
                          e.target.value
                        )
                      }
                    />
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="apiKey" className="text-label">
                  {intl.formatMessage(messages.apiKey)}
                  {!tautulli?.hasApiKey && (
                    <span className="label-required">*</span>
                  )}
                  <span className="label-tip">
                    {tautulli?.hasApiKey
                      ? intl.formatMessage(messages.savedSecret)
                      : intl.formatMessage(messages.apiKeyTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      id="apiKey"
                      name="apiKey"
                      autoComplete="off"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        connectionField(setFieldValue, 'apiKey', e.target.value)
                      }
                    />
                  </div>
                  {errors.apiKey && touched.apiKey && (
                    <div className="error">{errors.apiKey}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="externalUrl" className="text-label">
                  {intl.formatMessage(messages.externalUrl)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.externalUrlTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="externalUrl"
                      name="externalUrl"
                      type="text"
                      inputMode="url"
                    />
                  </div>
                  {errors.externalUrl && touched.externalUrl && (
                    <div className="error">{errors.externalUrl}</div>
                  )}
                </div>
              </div>
            </div>
          </Modal>
        )}
      </Formik>
    </Transition>
  );
};

export default TautulliModal;
