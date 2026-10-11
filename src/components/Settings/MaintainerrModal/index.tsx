import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type { MaintainerrSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.MaintainerrModal', {
  createmaintainerr: 'Add New Maintainerr Server',
  editmaintainerr: 'Edit Maintainerr Server',
  add: 'Add Server',
  servername: 'Server Name',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  ssl: 'Use SSL',
  urlBase: 'URL Base',
  apiKey: 'API Key',
  apiKeyTip:
    'Maintainerr does not need one. Only set this if a proxy in front of it asks for a key.',
  features: 'Features',
  showBadges: 'Show "Deleting soon" badges',
  showBadgesTip: 'On posters and title pages, for this server’s titles.',
  showDeletingSoon: 'Show on the home page',
  showDeletingSoonTip:
    'Include this server’s titles in the "Deleting Soon" row.',
  soonDays: 'Deleting soon means within',
  soonDaysTip: 'Titles due further out are not shown.',
  days: 'days',
  allowKeep: 'Allow anyone to keep a title',
  allowKeepTip:
    'Shows a Keep button, where Request normally sits, to everyone signed in. It postpones the deletion; it never excludes a title for good.',
  keepDays: 'Keep adds',
  keepDaysTip: '0 restarts the rule’s whole grace period.',
  toastTestSuccess: 'Maintainerr connection established successfully!',
  toastTestFailure: 'Failed to connect to Maintainerr.',
  validationNameRequired: 'You must provide a server name',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationNumberRange: 'Must be between {min} and {max}',
});

interface MaintainerrModalProps {
  /** The server being edited, or null to add one. */
  maintainerr: MaintainerrSettings | null;
  onClose: () => void;
  onSave: () => void;
}

type FormValues = Omit<MaintainerrSettings, 'id'>;

const MaintainerrModal = ({
  maintainerr,
  onClose,
  onSave,
}: MaintainerrModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  // Editing starts from a server that already worked; a new one must pass a
  // test before it can be added, as with Radarr and Sonarr.
  const [isValidated, setIsValidated] = useState(!!maintainerr);

  const range = (min: number, max: number) => {
    const message = intl.formatMessage(messages.validationNumberRange, {
      min,
      max,
    });
    return Yup.number()
      .typeError(message)
      .integer(message)
      .min(min, message)
      .max(max, message)
      .required(message);
  };

  const schema = Yup.object().shape({
    name: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationNameRequired)),
    hostname: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationHostnameRequired))
      // Just the host: no scheme, path, port or spaces. The connection test
      // catches anything else.
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
    soonDays: range(1, 365),
    keepDays: range(0, 365),
  });

  const toSettings = (values: FormValues): FormValues => ({
    ...values,
    name: values.name.trim(),
    hostname: values.hostname.trim(),
    port: Number(values.port),
    soonDays: Number(values.soonDays),
    keepDays: Number(values.keepDays),
  });

  const testConnection = async (values: FormValues) => {
    setIsTesting(true);
    try {
      await axios.post('/api/v1/settings/maintainerr/test', {
        hostname: values.hostname.trim(),
        port: Number(values.port),
        useSsl: values.useSsl,
        urlBase: values.urlBase,
        apiKey: values.apiKey,
      });
      setIsValidated(true);
      addToast(intl.formatMessage(messages.toastTestSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      setIsValidated(false);
      addToast(intl.formatMessage(messages.toastTestFailure), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsTesting(false);
    }
  };

  // Changing where the server is means the earlier test no longer counts.
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
          name: maintainerr?.name ?? '',
          hostname: maintainerr?.hostname ?? '',
          port: maintainerr?.port ?? 6246,
          useSsl: maintainerr?.useSsl ?? false,
          urlBase: maintainerr?.urlBase ?? '',
          apiKey: maintainerr?.apiKey ?? '',
          showBadges: maintainerr?.showBadges ?? true,
          showDeletingSoon: maintainerr?.showDeletingSoon ?? true,
          allowKeep: maintainerr?.allowKeep ?? true,
          keepDays: maintainerr?.keepDays ?? 0,
          soonDays: maintainerr?.soonDays ?? 14,
        }}
        validationSchema={schema}
        onSubmit={async (values) => {
          try {
            if (maintainerr) {
              await axios.put(
                `/api/v1/settings/maintainerr/${maintainerr.id}`,
                { ...toSettings(values), id: maintainerr.id }
              );
            } else {
              await axios.post(
                '/api/v1/settings/maintainerr',
                toSettings(values)
              );
            }
            onSave();
          } catch {
            // The server tests the connection again before saving.
            setIsValidated(false);
            addToast(intl.formatMessage(messages.toastTestFailure), {
              appearance: 'error',
              autoDismiss: true,
            });
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
                : maintainerr
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
              maintainerr
                ? messages.editmaintainerr
                : messages.createmaintainerr
            )}
          >
            <div className="mb-6">
              <div className="form-row">
                <label htmlFor="name" className="text-label">
                  {intl.formatMessage(messages.servername)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="name"
                      name="name"
                      type="text"
                      autoComplete="off"
                      data-form-type="other"
                      data-1pignore="true"
                      data-lpignore="true"
                      data-bwignore="true"
                    />
                  </div>
                  {errors.name && touched.name && (
                    <div className="error">{errors.name}</div>
                  )}
                </div>
              </div>
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
                  <span className="label-tip">
                    {intl.formatMessage(messages.apiKeyTip)}
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
                </div>
              </div>

              <h3 className="mb-2 mt-8 text-lg font-bold text-gray-200">
                {intl.formatMessage(messages.features)}
              </h3>

              <div className="form-row">
                <label htmlFor="showBadges" className="checkbox-label">
                  {intl.formatMessage(messages.showBadges)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.showBadgesTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="showBadges"
                    name="showBadges"
                    onChange={() =>
                      setFieldValue('showBadges', !values.showBadges)
                    }
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="showDeletingSoon" className="checkbox-label">
                  {intl.formatMessage(messages.showDeletingSoon)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.showDeletingSoonTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="showDeletingSoon"
                    name="showDeletingSoon"
                    onChange={() =>
                      setFieldValue(
                        'showDeletingSoon',
                        !values.showDeletingSoon
                      )
                    }
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="soonDays" className="text-label">
                  {intl.formatMessage(messages.soonDays)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.soonDaysTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="flex items-center">
                    {/* Its own box: the global input rule outranks a width utility inside a flex row. */}
                    <div className="w-20 flex-none">
                      <Field
                        id="soonDays"
                        name="soonDays"
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
                    </div>
                    <span className="ml-2 text-sm text-gray-400">
                      {intl.formatMessage(messages.days)}
                    </span>
                  </div>
                  {errors.soonDays && touched.soonDays && (
                    <div className="error">{errors.soonDays}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="allowKeep" className="checkbox-label">
                  {intl.formatMessage(messages.allowKeep)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.allowKeepTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="allowKeep"
                    name="allowKeep"
                    onChange={() =>
                      setFieldValue('allowKeep', !values.allowKeep)
                    }
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="keepDays" className="text-label">
                  {intl.formatMessage(messages.keepDays)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.keepDaysTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="flex items-center">
                    <div className="w-20 flex-none">
                      <Field
                        id="keepDays"
                        name="keepDays"
                        type="text"
                        inputMode="numeric"
                        className="short"
                        disabled={!values.allowKeep}
                      />
                    </div>
                    <span className="ml-2 text-sm text-gray-400">
                      {intl.formatMessage(messages.days)}
                    </span>
                  </div>
                  {errors.keepDays && touched.keepDays && (
                    <div className="error">{errors.keepDays}</div>
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

export default MaintainerrModal;
