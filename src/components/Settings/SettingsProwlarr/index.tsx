import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SaveBar from '@app/components/Common/SaveBar';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon, BeakerIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsProwlarr', {
  prowlarr: 'Prowlarr',
  description:
    'Backfill and songs taken from albums search Prowlarr directly, under every name a title goes by. Neither runs without it. Sonarr, Radarr and Lidarr keep using their own indexers.',
  hostname: 'Hostname or IP address',
  port: 'Port',
  ssl: 'Use SSL',
  urlBase: 'URL base',
  apiKey: 'API key',
  apiKeySaved: 'Saved; leave blank to keep it',
  test: 'Test',
  testing: 'Testing…',
  testOk: 'Prowlarr {version} answered.',
  testFailed: 'Could not reach Prowlarr.',
  saved: 'Prowlarr saved.',
  saveFailed: 'Could not save Prowlarr: {reason}',
});

interface ProwlarrShown {
  hostname: string;
  port: number;
  useSsl: boolean;
  urlBase: string;
  apiKey: string;
  hasApiKey: boolean;
}

const problemOf = (e: unknown): string | undefined =>
  axios.isAxiosError(e) && e.response?.data?.message
    ? String(e.response.data.message)
    : undefined;

/**
 * Prowlarr's connection, among the services: kept with Backfill's
 * settings, which use it, and tested before it is saved.
 */
const SettingsProwlarr = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, mutate } = useSWR<ProwlarrShown>(
    '/api/v1/settings/backfill/prowlarr'
  );
  const [test, setTest] = useState<{ ok: boolean; text: string }>();
  const [testing, setTesting] = useState(false);

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.prowlarr)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <div className="section">
        {!data ? (
          <LoadingSpinner />
        ) : (
          <Formik
            initialValues={data}
            enableReinitialize
            onSubmit={async (values) => {
              try {
                await axios.put('/api/v1/settings/backfill/prowlarr', {
                  hostname: values.hostname,
                  port: Number(values.port),
                  useSsl: values.useSsl,
                  urlBase: values.urlBase,
                  apiKey: values.apiKey,
                });
                await mutate();
                // Backfill's own settings show whether Prowlarr is set up.
                await globalMutate('/api/v1/settings/backfill');
                addToast(intl.formatMessage(messages.saved), {
                  appearance: 'success',
                  autoDismiss: true,
                });
              } catch (e) {
                addToast(
                  intl.formatMessage(messages.saveFailed, {
                    reason:
                      problemOf(e) ?? intl.formatMessage(messages.testFailed),
                  }),
                  { appearance: 'error', autoDismiss: true }
                );
              }
            }}
          >
            {({ values, setFieldValue, isSubmitting }) => {
              const runTest = async () => {
                setTesting(true);
                setTest(undefined);
                try {
                  const { data: answer } = await axios.post<{
                    version: string;
                  }>('/api/v1/settings/backfill/test', {
                    hostname: values.hostname,
                    port: Number(values.port),
                    useSsl: values.useSsl,
                    urlBase: values.urlBase,
                    apiKey: values.apiKey,
                  });
                  setTest({
                    ok: true,
                    text: intl.formatMessage(messages.testOk, {
                      version: answer.version,
                    }),
                  });
                } catch (e) {
                  setTest({
                    ok: false,
                    text:
                      problemOf(e) ?? intl.formatMessage(messages.testFailed),
                  });
                } finally {
                  setTesting(false);
                }
              };
              return (
                <Form>
                  <div className="form-row">
                    <label htmlFor="prowlarr-hostname" className="text-label">
                      {intl.formatMessage(messages.hostname)}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field
                          id="prowlarr-hostname"
                          name="hostname"
                          type="text"
                          placeholder="prowlarr"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="prowlarr-port" className="text-label">
                      {intl.formatMessage(messages.port)}
                    </label>
                    <div className="form-input-area">
                      <Field
                        id="prowlarr-port"
                        name="port"
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
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
                        onChange={() => setFieldValue('useSsl', !values.useSsl)}
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
                        />
                      </div>
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="prowlarr-apikey" className="text-label">
                      {intl.formatMessage(messages.apiKey)}
                      {data.hasApiKey && (
                        <span className="label-tip">
                          {intl.formatMessage(messages.apiKeySaved)}
                        </span>
                      )}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <SensitiveInput
                          as="field"
                          id="prowlarr-apikey"
                          name="apiKey"
                          autoComplete="off"
                        />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <Button
                          buttonType="warning"
                          buttonSize="sm"
                          type="button"
                          disabled={testing || !values.hostname}
                          onClick={runTest}
                        >
                          <BeakerIcon />
                          <span>
                            {intl.formatMessage(
                              testing ? messages.testing : messages.test
                            )}
                          </span>
                        </Button>
                        {test && (
                          <span
                            className={`text-sm ${test.ok ? 'text-green-400' : 'text-red-400'}`}
                          >
                            {test.text}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <SaveBar>
                    <div className="flex justify-end">
                      <Button
                        buttonType="primary"
                        type="submit"
                        disabled={isSubmitting}
                      >
                        <ArrowDownOnSquareIcon />
                        <span>
                          {isSubmitting
                            ? intl.formatMessage(globalMessages.saving)
                            : intl.formatMessage(globalMessages.save)}
                        </span>
                      </Button>
                    </div>
                  </SaveBar>
                </Form>
              );
            }}
          </Formik>
        )}
      </div>
    </>
  );
};

export default SettingsProwlarr;
