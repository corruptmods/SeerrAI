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
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsSoulseek', {
  soulseek: 'Soulseek',
  description:
    'A song taken from an album is looked for on Soulseek, through slskd, when no release of its album or single is on the indexers. Only the song’s file is downloaded, and Lidarr imports it. Needs slskd 0.26 or newer.',
  url: 'slskd Address',
  urlTip:
    'For example http://192.168.1.5:5030. Leave blank to not use Soulseek.',
  apiKey: 'API Key',
  apiKeyTip: 'An slskd API key with the ReadWrite role.',
  apiKeySaved: 'Saved; leave blank to keep it',
  downloadsPath: 'Downloads Folder, as Lidarr Sees It',
  downloadsPathTip:
    'Where slskd puts finished downloads, as the path Lidarr sees, for example /data/soulseek/complete. Lidarr imports the songs from there.',
  test: 'Test',
  testing: 'Testing…',
  testOk: 'slskd {version} answered and is signed in to Soulseek.',
  testNotSignedIn:
    'slskd {version} answered, but isn’t signed in to Soulseek yet.',
  testFailed: 'Could not reach slskd.',
  saved: 'Soulseek saved.',
  saveFailed: 'Could not save Soulseek: {reason}',
});

interface SoulseekShown {
  url: string;
  downloadsPath: string;
  hasApiKey: boolean;
}

const problemOf = (e: unknown): string | undefined =>
  axios.isAxiosError(e) && e.response?.data?.message
    ? String(e.response.data.message)
    : undefined;

/**
 * Soulseek, through slskd, among the services: tested before it is saved,
 * and saved only once Lidarr sees its downloads folder.
 */
const SettingsSoulseek = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, mutate } = useSWR<SoulseekShown>(
    '/api/v1/settings/music/soulseek'
  );
  const [test, setTest] = useState<{ ok: boolean; text: string }>();
  const [testing, setTesting] = useState(false);

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.soulseek)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <div className="section">
        {!data ? (
          <LoadingSpinner />
        ) : (
          <Formik
            initialValues={{
              url: data.url,
              apiKey: '',
              downloadsPath: data.downloadsPath,
            }}
            enableReinitialize
            onSubmit={async (values, { resetForm }) => {
              try {
                const { data: saved } = await axios.put<SoulseekShown>(
                  '/api/v1/settings/music/soulseek',
                  values
                );
                await mutate(saved);
                resetForm({
                  values: {
                    url: saved.url,
                    apiKey: '',
                    downloadsPath: saved.downloadsPath,
                  },
                });
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
            {({ values, isSubmitting }) => {
              const runTest = async () => {
                setTesting(true);
                setTest(undefined);
                try {
                  const { data: answer } = await axios.post<{
                    version: string;
                    signedIn: boolean;
                  }>('/api/v1/settings/music/soulseek/test', values);
                  setTest({
                    ok: answer.signedIn,
                    text: intl.formatMessage(
                      answer.signedIn
                        ? messages.testOk
                        : messages.testNotSignedIn,
                      { version: answer.version }
                    ),
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
                    <label htmlFor="soulseek-url" className="text-label">
                      {intl.formatMessage(messages.url)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.urlTip)}
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
                        />
                      </div>
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="soulseek-apikey" className="text-label">
                      {intl.formatMessage(messages.apiKey)}
                      <span className="label-tip">
                        {intl.formatMessage(
                          data.hasApiKey
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
                        />
                      </div>
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="soulseek-downloads" className="text-label">
                      {intl.formatMessage(messages.downloadsPath)}
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
                        />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <Button
                          buttonType="warning"
                          buttonSize="sm"
                          type="button"
                          disabled={testing || !values.url}
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

export default SettingsSoulseek;
