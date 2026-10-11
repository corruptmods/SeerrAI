import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type { DownloadClientSettings } from '@server/lib/settings';
import axios, { isAxiosError } from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.DownloadClientModal', {
  createclient: 'Add Download Client',
  editclient: 'Edit Download Client',
  add: 'Add Client',
  type: 'Client',
  sabnzbd: 'SABnzbd',
  nzbget: 'NZBGet',
  qbittorrent: 'qBittorrent',
  transmission: 'Transmission',
  deluge: 'Deluge',
  rtorrent: 'rTorrent / ruTorrent',
  usenet: 'Usenet',
  torrents: 'Torrents',
  name: 'Name',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  ssl: 'Use SSL',
  urlBase: 'URL Base',
  urlBaseTransmission: 'Usually /transmission/, as in Sonarr.',
  urlBaseRtorrent:
    'Where its XML-RPC is, as in Sonarr: usually RPC2, or plugins/httprpc/action.php through ruTorrent.',
  apiKey: 'API Key',
  apiKeyTip: 'In SABnzbd: Config → General → Security.',
  username: 'Username',
  usernameTip:
    'Leave blank if {client} lets this address in without signing in.',
  password: 'Password',
  passwordTipDeluge: 'Deluge’s Web UI password.',
  savedSecret: 'Saved. Leave blank to keep it.',
  toastTestSuccess: 'Connected to {name}.',
  toastTestFailure: 'Could not connect: {reason}',
  noAnswer: 'it did not answer.',
  validationNameRequired: 'You must provide a name',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationApiKeyRequired: 'You must provide the API key',
});

/** As the settings page is sent it: no key or password, only that one is set. */
export type ShownDownloadClient = DownloadClientSettings & {
  hasApiKey?: boolean;
  hasPassword?: boolean;
};

interface DownloadClientModalProps {
  /** The client being edited, or null to add one. */
  client: ShownDownloadClient | null;
  onClose: () => void;
  onSave: () => void;
}

type FormValues = Omit<DownloadClientSettings, 'id'>;

const DEFAULT_PORTS: Record<FormValues['type'], number> = {
  sabnzbd: 8080,
  nzbget: 6789,
  qbittorrent: 8080,
  transmission: 9091,
  deluge: 8112,
  rtorrent: 8080,
};

const USENET = ['sabnzbd', 'nzbget'] as const;
const TORRENTS = ['qbittorrent', 'transmission', 'deluge', 'rtorrent'] as const;

const DownloadClientModal = ({
  client,
  onClose,
  onSave,
}: DownloadClientModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  // Editing starts from a client that already worked; a new one must pass a
  // test before it can be added.
  const [isValidated, setIsValidated] = useState(!!client);

  const schema = Yup.object().shape({
    name: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationNameRequired)),
    hostname: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationHostnameRequired))
      // Just the host: no scheme, path, port or spaces.
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
    apiKey: Yup.string().when('type', {
      is: (type: string) => type === 'sabnzbd' && !client?.hasApiKey,
      then: (rule) =>
        rule.required(intl.formatMessage(messages.validationApiKeyRequired)),
    }),
  });

  /** What is sent: only what the server takes, never the "is set" flags. */
  const toBody = (values: FormValues) => ({
    name: values.name.trim(),
    type: values.type,
    hostname: values.hostname.trim(),
    port: Number(values.port),
    useSsl: values.useSsl,
    urlBase: values.urlBase.trim(),
    apiKey: values.type === 'sabnzbd' ? values.apiKey : '',
    // Deluge's Web UI has a password and no username; SABnzbd a key instead.
    username:
      values.type === 'sabnzbd' || values.type === 'deluge'
        ? ''
        : values.username.trim(),
    password: values.type === 'sabnzbd' ? '' : values.password,
  });

  const reasonOf = (e: unknown) =>
    (isAxiosError(e) && (e.response?.data as { message?: string })?.message) ||
    intl.formatMessage(messages.noAnswer);

  const testConnection = async (values: FormValues) => {
    setIsTesting(true);
    try {
      await axios.post('/api/v1/settings/download-clients/test', {
        ...toBody(values),
        ...(client ? { id: client.id } : {}),
      });
      setIsValidated(true);
      addToast(
        intl.formatMessage(messages.toastTestSuccess, {
          name: values.name.trim() || intl.formatMessage(messages[values.type]),
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

  // Changing where the client is, or how to sign in, means the earlier test
  // no longer counts.
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
          name: client?.name ?? '',
          type: client?.type ?? 'sabnzbd',
          hostname: client?.hostname ?? '',
          port: client?.port ?? DEFAULT_PORTS.sabnzbd,
          useSsl: client?.useSsl ?? false,
          urlBase: client?.urlBase ?? '',
          apiKey: '',
          username: client?.username ?? '',
          password: '',
        }}
        validationSchema={schema}
        onSubmit={async (values) => {
          try {
            if (client) {
              await axios.put(
                `/api/v1/settings/download-clients/${client.id}`,
                toBody(values)
              );
            } else {
              await axios.post(
                '/api/v1/settings/download-clients',
                toBody(values)
              );
            }
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
                : client
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
              client ? messages.editclient : messages.createclient
            )}
          >
            <div className="mb-6">
              <div className="form-row">
                <label htmlFor="type" className="text-label">
                  {intl.formatMessage(messages.type)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      as="select"
                      id="type"
                      name="type"
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                        const type = e.target.value as FormValues['type'];
                        connectionField(setFieldValue, 'type', type);
                        if (!client) {
                          setFieldValue('port', DEFAULT_PORTS[type]);
                        }
                      }}
                    >
                      <optgroup label={intl.formatMessage(messages.usenet)}>
                        {USENET.map((type) => (
                          <option key={type} value={type}>
                            {intl.formatMessage(messages[type])}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label={intl.formatMessage(messages.torrents)}>
                        {TORRENTS.map((type) => (
                          <option key={type} value={type}>
                            {intl.formatMessage(messages[type])}
                          </option>
                        ))}
                      </optgroup>
                    </Field>
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="name" className="text-label">
                  {intl.formatMessage(messages.name)}
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
                  {(values.type === 'transmission' ||
                    values.type === 'rtorrent') && (
                    <span className="label-tip">
                      {intl.formatMessage(
                        values.type === 'transmission'
                          ? messages.urlBaseTransmission
                          : messages.urlBaseRtorrent
                      )}
                    </span>
                  )}
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
              {values.type === 'sabnzbd' ? (
                <div className="form-row">
                  <label htmlFor="apiKey" className="text-label">
                    {intl.formatMessage(messages.apiKey)}
                    {!client?.hasApiKey && (
                      <span className="label-required">*</span>
                    )}
                    <span className="label-tip">
                      {client?.hasApiKey
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
                          connectionField(
                            setFieldValue,
                            'apiKey',
                            e.target.value
                          )
                        }
                      />
                    </div>
                    {errors.apiKey && touched.apiKey && (
                      <div className="error">{errors.apiKey}</div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {values.type !== 'deluge' && (
                    <div className="form-row">
                      <label htmlFor="username" className="text-label">
                        {intl.formatMessage(messages.username)}
                        <span className="label-tip">
                          {intl.formatMessage(messages.usernameTip, {
                            client: intl.formatMessage(messages[values.type]),
                          })}
                        </span>
                      </label>
                      <div className="form-input-area">
                        <div className="form-input-field">
                          <Field
                            id="username"
                            name="username"
                            type="text"
                            autoComplete="off"
                            data-form-type="other"
                            data-1pignore="true"
                            data-lpignore="true"
                            data-bwignore="true"
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>
                            ) =>
                              connectionField(
                                setFieldValue,
                                'username',
                                e.target.value
                              )
                            }
                          />
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="form-row">
                    <label htmlFor="password" className="text-label">
                      {intl.formatMessage(messages.password)}
                      {client?.hasPassword && client.type === values.type ? (
                        <span className="label-tip">
                          {intl.formatMessage(messages.savedSecret)}
                        </span>
                      ) : (
                        values.type === 'deluge' && (
                          <span className="label-tip">
                            {intl.formatMessage(messages.passwordTipDeluge)}
                          </span>
                        )
                      )}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <SensitiveInput
                          as="field"
                          id="password"
                          name="password"
                          autoComplete="off"
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            connectionField(
                              setFieldValue,
                              'password',
                              e.target.value
                            )
                          }
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </Modal>
        )}
      </Formik>
    </Transition>
  );
};

export default DownloadClientModal;
