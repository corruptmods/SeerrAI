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

// Message ids predate this modal, so existing translations still apply.
const messages = defineMessages('components.Settings.SettingsSoulseek', {
  addSoulseek: 'Add Soulseek',
  editSoulseek: 'Edit Soulseek',
  url: 'slskd Address',
  urlExample: 'For example http://192.168.1.5:5030.',
  apiKey: 'API Key',
  apiKeyTip: 'An slskd API key with the ReadWrite role.',
  apiKeySaved: 'Saved; leave blank to keep it',
  downloadsPath: 'Downloads Folder, as Lidarr Sees It',
  downloadsPathTip:
    'Where slskd puts finished downloads, as the path Lidarr sees, for example /data/soulseek/complete. Lidarr imports the songs from there.',
  testOk: 'slskd {version} answered and is signed in to Soulseek.',
  testNotSignedIn:
    'slskd {version} answered, but isn’t signed in to Soulseek yet.',
  testFailed: 'Could not reach slskd.',
  saveFailed: 'Could not save Soulseek: {reason}',
  validationUrlRequired: 'You must provide slskd’s address',
  validationApiKeyRequired: 'You must provide the API key',
  validationDownloadsPathRequired:
    'You must provide the downloads folder, as a full path',
});

/** As Settings sends it: no key, only whether one is set. */
export interface ShownSoulseek {
  url: string;
  downloadsPath: string;
  hasApiKey: boolean;
}

interface SoulseekModalProps {
  /** The saved Soulseek, or null to add it. */
  soulseek: ShownSoulseek | null;
  onClose: () => void;
  onSave: () => void;
}

interface FormValues {
  url: string;
  apiKey: string;
  downloadsPath: string;
}

/**
 * Adds or edits Soulseek (through slskd): tested before adding, and saved only
 * once Lidarr can see its downloads folder.
 */
const SoulseekModal = ({ soulseek, onClose, onSave }: SoulseekModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  // Editing starts from a working slskd; a new one must pass a test first.
  const [isValidated, setIsValidated] = useState(!!soulseek);

  const schema = Yup.object().shape({
    url: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationUrlRequired))
      .matches(
        /^https?:\/\/[^\s/]+/,
        intl.formatMessage(messages.validationUrlRequired)
      ),
    apiKey: soulseek?.hasApiKey
      ? Yup.string()
      : Yup.string().required(
          intl.formatMessage(messages.validationApiKeyRequired)
        ),
    downloadsPath: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationDownloadsPathRequired))
      // A full path, as Lidarr sees it: /data/…, C:\… or \\server\….
      .matches(
        /^(?:\/|[A-Za-z]:[\\/]|\\\\)/,
        intl.formatMessage(messages.validationDownloadsPathRequired)
      ),
  });

  const toBody = (values: FormValues) => ({
    url: values.url.trim(),
    apiKey: values.apiKey,
    downloadsPath: values.downloadsPath.trim(),
  });

  const reasonOf = (e: unknown) =>
    (isAxiosError(e) && (e.response?.data as { message?: string })?.message) ||
    intl.formatMessage(messages.testFailed);

  const testConnection = async (values: FormValues) => {
    setIsTesting(true);
    try {
      const { data } = await axios.post<{
        version: string;
        signedIn: boolean;
      }>('/api/v1/settings/music/soulseek/test', toBody(values));
      setIsValidated(true);
      addToast(
        intl.formatMessage(
          data.signedIn ? messages.testOk : messages.testNotSignedIn,
          { version: data.version }
        ),
        {
          appearance: data.signedIn ? 'success' : 'warning',
          autoDismiss: true,
        }
      );
    } catch (e) {
      setIsValidated(false);
      addToast(reasonOf(e), { appearance: 'error', autoDismiss: true });
    } finally {
      setIsTesting(false);
    }
  };

  // A new address, key or folder voids the earlier test.
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
          url: soulseek?.url ?? '',
          apiKey: '',
          downloadsPath: soulseek?.downloadsPath ?? '',
        }}
        validationSchema={schema}
        onSubmit={async (values) => {
          try {
            await axios.put('/api/v1/settings/music/soulseek', toBody(values));
            onSave();
          } catch (e) {
            // The server tests slskd again before saving.
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
                : soulseek
                  ? intl.formatMessage(globalMessages.save)
                  : intl.formatMessage(messages.addSoulseek)
            }
            secondaryButtonType="warning"
            secondaryText={
              isTesting
                ? intl.formatMessage(globalMessages.testing)
                : intl.formatMessage(globalMessages.test)
            }
            onSecondary={() => testConnection(values)}
            secondaryDisabled={!values.url || isTesting || isSubmitting}
            okDisabled={!isValidated || isSubmitting || isTesting || !isValid}
            onOk={() => handleSubmit()}
            title={intl.formatMessage(
              soulseek ? messages.editSoulseek : messages.addSoulseek
            )}
          >
            <div className="mb-6">
              <div className="form-row">
                <label htmlFor="soulseek-url" className="text-label">
                  {intl.formatMessage(messages.url)}
                  <span className="label-required">*</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.urlExample)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="soulseek-url"
                      name="url"
                      type="text"
                      inputMode="url"
                      placeholder="http://192.168.1.5:5030"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        connectionField(setFieldValue, 'url', e.target.value)
                      }
                    />
                  </div>
                  {errors.url && touched.url && (
                    <div className="error">{errors.url}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="soulseek-apikey" className="text-label">
                  {intl.formatMessage(messages.apiKey)}
                  {!soulseek?.hasApiKey && (
                    <span className="label-required">*</span>
                  )}
                  <span className="label-tip">
                    {intl.formatMessage(
                      soulseek?.hasApiKey
                        ? messages.apiKeySaved
                        : messages.apiKeyTip
                    )}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      id="soulseek-apikey"
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
                <label htmlFor="soulseek-downloads" className="text-label">
                  {intl.formatMessage(messages.downloadsPath)}
                  <span className="label-required">*</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.downloadsPathTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="soulseek-downloads"
                      name="downloadsPath"
                      type="text"
                      placeholder="/data/soulseek/complete"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        connectionField(
                          setFieldValue,
                          'downloadsPath',
                          e.target.value
                        )
                      }
                    />
                  </div>
                  {errors.downloadsPath && touched.downloadsPath && (
                    <div className="error">{errors.downloadsPath}</div>
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

export default SoulseekModal;
