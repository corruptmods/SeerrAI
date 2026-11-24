import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SaveBar from '@app/components/Common/SaveBar';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import LibraryItem from '@app/components/Settings/LibraryItem';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import {
  ArrowPathIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import type { Library, SiloSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Formik } from 'formik';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

/*
 * Settings → Silo: its film and series libraries, its full scan, and its
 * address and API key. Connecting and removing it is under Media Servers.
 */

const messages = defineMessages('components.Settings.SettingsSilo', {
  libraries: 'Silo Libraries',
  librariesDescription:
    'The film and series libraries Seerr AI scans. Book, podcast and manga libraries aren’t listed. None listed? Use the button below.',
  mixedLibrary: 'Films and series',
  readLibraries: 'Read Libraries',
  reading: 'Reading…',
  readFailed: 'Silo’s libraries could not be read.',
  toggleFailed: 'That library could not be changed.',
  scan: 'Full Library Scan',
  scanDescription:
    'Runs once a day; recently added titles are checked every few minutes. Run one after choosing libraries.',
  notRunning: 'Not running',
  progress: '{progress} of {total}',
  currentLibrary: 'Current library: {name}',
  startScan: 'Start Scan',
  cancelScan: 'Cancel Scan',
  settings: 'Silo Settings',
  settingsDescription:
    'Where Seerr AI reaches Silo, the address people use for Play links, a password reset page, and the API key.',
  version: 'Silo {version}',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  useSsl: 'Use SSL',
  urlBase: 'URL Base',
  externalUrl: 'External URL',
  externalUrlTip: 'The address people use, for Play links',
  forgotPasswordUrl: 'Forgot Password URL',
  apiKey: 'API Key',
  apiKeyTip: 'Leave empty to keep the saved key',
  saved: 'Silo settings saved.',
  saveFailed: 'Silo settings could not be saved.',
  notConnected:
    'Seerr AI is not connected to Silo. Connect it under <MediaServersLink>Media Servers</MediaServersLink>.',
  validationHostname: 'Enter a hostname or IP address',
  validationPort: 'Enter a port number',
  validationUrl: 'Enter a valid URL',
  validationTrailingSlash: 'The URL must not end in a slash',
  validationUrlBaseLeadingSlash: 'The URL base must start with a slash',
  validationUrlBaseTrailingSlash: 'The URL base must not end in a slash',
});

interface SiloSettingsResponse extends SiloSettings {
  hasApiKey: boolean;
}

interface SyncStatus {
  running: boolean;
  progress: number;
  total: number;
  currentLibrary?: Library;
  libraries: Library[];
}

const ENDPOINT = '/api/v1/settings/silo';

/** The message a refused request carries, else the fallback. */
const messageOf = (e: unknown, fallback: string): string => {
  const response = (
    e as { response?: { status?: number; data?: { message?: string } } }
  )?.response;
  return response?.data?.message && response.status !== 500
    ? response.data.message
    : fallback;
};

interface SettingsSiloProps {
  /** At first-run setup: only the libraries and the scan. */
  isSetupSettings?: boolean;
}

const SettingsSilo = ({ isSetupSettings }: SettingsSiloProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [reading, setReading] = useState(false);
  const { data, error, mutate } = useSWR<SiloSettingsResponse>(ENDPOINT);
  const { data: sync, mutate: revalidateSync } = useSWR<SyncStatus>(
    `${ENDPOINT}/sync`,
    { refreshInterval: (latest) => (latest?.running ? 1000 : 10000) }
  );

  const schema = Yup.object().shape({
    hostname: Yup.string()
      .nullable()
      .required(intl.formatMessage(messages.validationHostname)),
    port: Yup.number()
      .typeError(intl.formatMessage(messages.validationPort))
      .required(intl.formatMessage(messages.validationPort)),
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
    externalUrl: Yup.string()
      .nullable()
      .test('valid-url', intl.formatMessage(messages.validationUrl), isValidURL)
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    forgotPasswordUrl: Yup.string()
      .nullable()
      .test(
        'valid-url',
        intl.formatMessage(messages.validationUrl),
        isValidURL
      ),
  });

  const readLibraries = async () => {
    setReading(true);
    try {
      await axios.post(`${ENDPOINT}/library/sync`);
    } catch (e) {
      addToast(messageOf(e, intl.formatMessage(messages.readFailed)), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setReading(false);
      mutate();
    }
  };

  const toggleLibrary = async (library: Library) => {
    try {
      await axios.put(`${ENDPOINT}/library/${library.id}`, {
        enabled: !library.enabled,
      });
    } catch {
      addToast(intl.formatMessage(messages.toggleFailed), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      mutate();
    }
  };

  const scan = async (start: boolean) => {
    await axios.post(`${ENDPOINT}/sync`, start ? { start } : { cancel: true });
    revalidateSync();
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      {data?.connected === false && (
        <div className="mb-6">
          <Alert
            type="warning"
            title={intl.formatMessage(messages.notConnected, {
              MediaServersLink: (msg: React.ReactNode) => (
                <Link
                  href="/settings/media-servers"
                  className="text-strong transition duration-300 hover:underline"
                >
                  {msg}
                </Link>
              ),
            })}
          />
        </div>
      )}
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.libraries)}</h3>
        <p className="description">
          {intl.formatMessage(messages.librariesDescription)}
        </p>
      </div>
      <div className="section">
        <Button onClick={() => readLibraries()} disabled={reading}>
          <ArrowPathIcon className={reading ? 'animate-spin' : ''} />
          <span>
            {intl.formatMessage(
              reading ? messages.reading : messages.readLibraries
            )}
          </span>
        </Button>
        <ul className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
          {data?.libraries.map((library) => (
            <LibraryItem
              key={`silo-library-${library.id}`}
              name={
                library.type === 'mixed'
                  ? `${library.name} (${intl.formatMessage(
                      messages.mixedLibrary
                    )})`
                  : library.name
              }
              isEnabled={library.enabled}
              onToggle={() => toggleLibrary(library)}
            />
          ))}
        </ul>
      </div>

      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.scan)}</h3>
        <p className="description">
          {intl.formatMessage(messages.scanDescription)}
        </p>
      </div>
      <div className="section">
        <div className="rounded-md bg-gray-800 p-4">
          <div className="relative mb-6 h-8 w-full overflow-hidden rounded-full bg-gray-600">
            {sync?.running && sync.total > 0 && (
              <div
                className="h-8 bg-accent transition-all duration-200 ease-in-out"
                style={{
                  width: `${Math.round((sync.progress / sync.total) * 100)}%`,
                }}
              />
            )}
            <div className="absolute inset-0 flex h-8 w-full items-center justify-center text-sm">
              <span>
                {sync?.running
                  ? intl.formatMessage(messages.progress, {
                      progress: sync.progress,
                      total: sync.total,
                    })
                  : intl.formatMessage(messages.notRunning)}
              </span>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
            {sync?.running && sync.currentLibrary && (
              <Badge>
                {intl.formatMessage(messages.currentLibrary, {
                  name: sync.currentLibrary.name,
                })}
              </Badge>
            )}
            <div className="flex-1 text-right">
              {sync?.running ? (
                <Button buttonType="danger" onClick={() => scan(false)}>
                  <XMarkIcon />
                  <span>{intl.formatMessage(messages.cancelScan)}</span>
                </Button>
              ) : (
                <Button buttonType="warning" onClick={() => scan(true)}>
                  <MagnifyingGlassIcon />
                  <span>{intl.formatMessage(messages.startScan)}</span>
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {!isSetupSettings && (
        <>
          <div className="mb-6 mt-10">
            <h3 className="heading">{intl.formatMessage(messages.settings)}</h3>
            <p className="description">
              {intl.formatMessage(messages.settingsDescription)}
              {data?.serverVersion && data.serverVersion !== 'unavailable' && (
                <>
                  {' '}
                  {intl.formatMessage(messages.version, {
                    version: data.serverVersion,
                  })}
                </>
              )}
            </p>
          </div>
          <Formik
            initialValues={{
              hostname: data?.ip ?? '',
              port: data?.port ?? 8090,
              useSsl: !!data?.useSsl,
              urlBase: data?.urlBase ?? '',
              externalUrl: data?.externalHostname ?? '',
              forgotPasswordUrl: data?.forgotPasswordUrl ?? '',
              apiKey: '',
            }}
            enableReinitialize
            validationSchema={schema}
            onSubmit={async (values) => {
              try {
                await axios.post(ENDPOINT, {
                  hostname: values.hostname,
                  port: Number(values.port),
                  useSsl: values.useSsl,
                  urlBase: values.urlBase,
                  externalHostname: values.externalUrl,
                  forgotPasswordUrl: values.forgotPasswordUrl,
                  ...(values.apiKey ? { apiKey: values.apiKey } : {}),
                });
                addToast(intl.formatMessage(messages.saved), {
                  autoDismiss: true,
                  appearance: 'success',
                });
              } catch (e) {
                addToast(
                  messageOf(e, intl.formatMessage(messages.saveFailed)),
                  {
                    autoDismiss: true,
                    appearance: 'error',
                  }
                );
              } finally {
                mutate();
              }
            }}
          >
            {({
              errors,
              touched,
              values,
              setFieldValue,
              handleSubmit,
              isSubmitting,
              isValid,
            }) => (
              <form className="section" onSubmit={handleSubmit}>
                <div className="form-row">
                  <label htmlFor="silo-hostname" className="text-label">
                    {intl.formatMessage(messages.hostname)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                        {values.useSsl ? 'https://' : 'http://'}
                      </span>
                      <Field
                        type="text"
                        inputMode="url"
                        id="silo-hostname"
                        name="hostname"
                        className="rounded-r-only"
                      />
                    </div>
                    {errors.hostname && touched.hostname && (
                      <div className="error">{errors.hostname}</div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="silo-port" className="text-label">
                    {intl.formatMessage(messages.port)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="text"
                      inputMode="numeric"
                      id="silo-port"
                      name="port"
                      className="short"
                    />
                    {errors.port && touched.port && (
                      <div className="error">{errors.port}</div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="silo-ssl" className="checkbox-label">
                    {intl.formatMessage(messages.useSsl)}
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="silo-ssl"
                      name="useSsl"
                      onChange={() => setFieldValue('useSsl', !values.useSsl)}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="silo-urlbase" className="text-label">
                    {intl.formatMessage(messages.urlBase)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        type="text"
                        inputMode="url"
                        id="silo-urlbase"
                        name="urlBase"
                      />
                    </div>
                    {errors.urlBase && touched.urlBase && (
                      <div className="error">{errors.urlBase}</div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="silo-apikey" className="text-label">
                    {intl.formatMessage(messages.apiKey)}
                    {data?.hasApiKey && (
                      <span className="label-tip">
                        {intl.formatMessage(messages.apiKeyTip)}
                      </span>
                    )}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <SensitiveInput
                        as="field"
                        type="text"
                        id="silo-apikey"
                        name="apiKey"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="silo-external" className="text-label">
                    {intl.formatMessage(messages.externalUrl)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.externalUrlTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        type="text"
                        inputMode="url"
                        id="silo-external"
                        name="externalUrl"
                      />
                    </div>
                    {errors.externalUrl && touched.externalUrl && (
                      <div className="error">{errors.externalUrl}</div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="silo-forgot" className="text-label">
                    {intl.formatMessage(messages.forgotPasswordUrl)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        type="text"
                        inputMode="url"
                        id="silo-forgot"
                        name="forgotPasswordUrl"
                      />
                    </div>
                    {errors.forgotPasswordUrl && touched.forgotPasswordUrl && (
                      <div className="error">{errors.forgotPasswordUrl}</div>
                    )}
                  </div>
                </div>
                <SaveBar>
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
                </SaveBar>
              </form>
            )}
          </Formik>
        </>
      )}
    </>
  );
};

export default SettingsSilo;
