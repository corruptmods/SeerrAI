import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios, { isAxiosError } from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

// The form's words keep the ids they had in Settings → Services' own
// Prowlarr form, so their translations still apply.
const messages = defineMessages('components.Settings.SettingsProwlarr', {
  addProwlarr: 'Add Prowlarr',
  editProwlarr: 'Edit Prowlarr',
  hostname: 'Hostname or IP address',
  port: 'Port',
  ssl: 'Use SSL',
  urlBase: 'URL base',
  apiKey: 'API key',
  apiKeySaved: 'Saved; leave blank to keep it',
  apiKeyTip: 'In Prowlarr: Settings → General → Security.',
  testOk: 'Prowlarr {version} answered.',
  testFailed: 'Could not reach Prowlarr.',
  saveFailed: 'Could not save Prowlarr: {reason}',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationApiKeyRequired: 'You must provide the API key',
});

/** Prowlarr's connection as Settings sends it: no key, only that one is set. */
export interface ShownProwlarr {
  hostname: string;
  port: number;
  useSsl: boolean;
  urlBase: string;
  hasApiKey: boolean;
}

interface ProwlarrModalProps {
  /** The saved Prowlarr, or null to add it. */
  prowlarr: ShownProwlarr | null;
  onClose: () => void;
  onSave: () => void;
}

interface FormValues {
  hostname: string;
  port: number | string;
  useSsl: boolean;
  urlBase: string;
  apiKey: string;
}

/**
 * Adding or editing Prowlarr, as the other services are: tested before it
 * can be added, and tested again by the server before it is saved.
 */
const ProwlarrModal = ({ prowlarr, onClose, onSave }: ProwlarrModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  // Editing starts from a Prowlarr that already worked; a new one must pass
  // a test before it can be added.
  const [isValidated, setIsValidated] = useState(!!prowlarr);

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
    apiKey: prowlarr?.hasApiKey
      ? Yup.string()
      : Yup.string().required(
          intl.formatMessage(messages.validationApiKeyRequired)
        ),
  });

  const toBody = (values: FormValues) => ({
    hostname: values.hostname.trim(),
    port: Number(values.port),
    useSsl: values.useSsl,
    urlBase: values.urlBase.trim(),
    apiKey: values.apiKey,
  });

  const reasonOf = (e: unknown) =>
    (isAxiosError(e) && (e.response?.data as { message?: string })?.message) ||
    intl.formatMessage(messages.testFailed);

  const testConnection = async (values: FormValues) => {
    setIsTesting(true);
    try {
      const { data } = await axios.post<{ version: string }>(
        '/api/v1/settings/backfill/test',
        toBody(values)
      );
      setIsValidated(true);
      addToast(intl.formatMessage(messages.testOk, { version: data.version }), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      setIsValidated(false);
      addToast(reasonOf(e), { appearance: 'error', autoDismiss: true });
    } finally {
      setIsTesting(false);
    }
  };

  // Changing where Prowlarr is, or its key, means the earlier test no
  // longer counts.
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
          hostname: prowlarr?.hostname ?? '',
          port: prowlarr?.port ?? 9696,
          useSsl: prowlarr?.useSsl ?? false,
          urlBase: prowlarr?.urlBase ?? '',
          apiKey: '',
        }}
        validationSchema={schema}
        onSubmit={async (values) => {
          try {
            await axios.put(
              '/api/v1/settings/backfill/prowlarr',
              toBody(values)
            );
            onSave();
          } catch (e) {
            // The server tests the connection again before saving.
            setIsValidated(false);
            addToast(
              intl.formatMessage(messages.saveFailed, { reason: reasonOf(e) }),
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
                : prowlarr
                  ? intl.formatMessage(globalMessages.save)
                  : intl.formatMessage(messages.addProwlarr)
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
              prowlarr ? messages.editProwlarr : messages.addProwlarr
            )}
          >
            <div className="mb-6">
              <div className="form-row">
                <label htmlFor="prowlarr-hostname" className="text-label">
                  {intl.formatMessage(messages.hostname)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                      {values.useSsl ? 'https://' : 'http://'}
                    </span>
                    <Field
                      id="prowlarr-hostname"
                      name="hostname"
                      type="text"
                      inputMode="url"
                      placeholder="prowlarr"
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
                <label htmlFor="prowlarr-port" className="text-label">
                  {intl.formatMessage(messages.port)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <Field
                    id="prowlarr-port"
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
                <label htmlFor="prowlarr-ssl" className="checkbox-label">
                  {intl.formatMessage(messages.ssl)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="prowlarr-ssl"
                    name="useSsl"
                    onChange={() =>
                      connectionField(setFieldValue, 'useSsl', !values.useSsl)
                    }
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="prowlarr-urlbase" className="text-label">
                  {intl.formatMessage(messages.urlBase)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="prowlarr-urlbase"
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
                <label htmlFor="prowlarr-apikey" className="text-label">
                  {intl.formatMessage(messages.apiKey)}
                  {!prowlarr?.hasApiKey && (
                    <span className="label-required">*</span>
                  )}
                  <span className="label-tip">
                    {intl.formatMessage(
                      prowlarr?.hasApiKey
                        ? messages.apiKeySaved
                        : messages.apiKeyTip
                    )}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      id="prowlarr-apikey"
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
            </div>
          </Modal>
        )}
      </Formik>
    </Transition>
  );
};

export default ProwlarrModal;
