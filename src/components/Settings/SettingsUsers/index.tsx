import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LabeledCheckbox from '@app/components/Common/LabeledCheckbox';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SaveBar from '@app/components/Common/SaveBar';
import PermissionEdit from '@app/components/PermissionEdit';
import QuotaSelector from '@app/components/QuotaSelector';
import { SERVER_NAMES } from '@app/components/Settings/SettingsMediaServers/names';
import SingleSignOn from '@app/components/Settings/SettingsUsers/SingleSignOn';
import useLazyModule from '@app/hooks/useLazyModule';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowDownOnSquareIcon,
  InboxArrowDownIcon,
} from '@heroicons/react/24/outline';
import type { MediaServerKind } from '@server/constants/server';
import type { MainSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import * as yup from 'yup';

const messages = defineMessages('components.Settings.SettingsUsers', {
  users: 'Users',
  userSettings: 'User Settings',
  userSettingsDescription: 'Configure global and default user settings.',
  toastSettingsSuccess: 'User settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving settings.',
  loginMethods: 'Login Methods',
  loginMethodsTip: 'Configure login methods for users.',
  localLogin: 'Enable Local Sign-In',
  localLoginTip: 'Sign in with email and password',
  mediaServerLogin: 'Enable {mediaServerName} Sign-In',
  mediaServerLoginTip: 'Sign in with a {mediaServerName} account',
  atLeastOneAuth: 'At least one authentication method must be selected.',
  newPlexLogin: 'Enable New {mediaServerName} Sign-In',
  newPlexLoginTip:
    '{mediaServerName} users can sign in without being imported first',
  autoImportPlexUsers: 'Auto-Import Plex Users',
  autoImportPlexUsersTip:
    'Hourly, give everyone you share your Plex server with an account, with the default permissions below',
  movieRequestLimitLabel: 'Global Movie Request Limit',
  tvRequestLimitLabel: 'Global Series Request Limit',
  musicRequestLimitLabel: 'Global Album Request Limit',
  defaultPermissions: 'Default Permissions',
  defaultPermissionsTip: 'Initial permissions assigned to new users',
  defaultWatchlistSync: 'Watchlist Sync for New Users',
  defaultWatchlistSyncTip:
    'Whether new users’ Plex or Trakt watchlists are requested automatically. Needs an Auto-Request permission',
  defaultWatchlistSyncMovies: 'Movies',
  defaultWatchlistSyncMoviesTip: 'Request movies added to their watchlist',
  defaultWatchlistSyncTv: 'Series',
  defaultWatchlistSyncTvTip: 'Request series added to their watchlist',
  disabledMediaServerLoginWarning:
    'Users with no {applicationTitle} password can’t sign in without {mediaServerName}. They can set one in their profile or by password reset.',
  mediaServersLogin: 'Enable Media Server Sign-In',
  mediaServersLoginTip:
    'Sign in with an account on any connected media server. Set each server under Media Servers',
  newMediaServersLogin: 'Enable New Media Server Sign-In',
  newMediaServersLoginTip:
    'Media server users can sign in without being imported first',
  disabledMediaServersLoginWarning:
    'Users with no {applicationTitle} password can’t sign in without a media server. They can set one in their profile or by password reset.',
  personalApiKeys: 'Let People Make Their Own API Keys',
  personalApiKeysTip:
    'Keys for apps and scripts, each acting as the person who made it. Off stops existing keys',
  personalApiKeysWho: 'Who Can Make Them',
  personalApiKeysManagers: 'Admins and people who can manage users',
  personalApiKeysEveryone: 'Everyone',
  importUsers: 'Import Users',
  importUsersTip:
    'Give people on a connected media server an account, with the default permissions above',
  importFrom: 'Import {mediaServerName} Users',
  couldNotOpen:
    'That could not be opened. Check your connection and try again.',
});

const loadPlexImport = () => import('@app/components/UserList/PlexImportModal');
const loadJellyfinImport = () =>
  import('@app/components/UserList/JellyfinImportModal');

const SettingsUsers = () => {
  const { addToast } = useToasts();
  const intl = useIntl();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MainSettings>('/api/v1/settings/main');
  const settings = useSettings();
  // Music's quota, once there is music to request.
  const musicReady = settings.currentSettings.musicReady;
  const [importing, setImporting] = useState<MediaServerKind>();
  const couldNotOpen = () => {
    addToast(intl.formatMessage(messages.couldNotOpen), {
      appearance: 'error',
      autoDismiss: true,
    });
    setImporting(undefined);
  };
  const plexImport = useLazyModule(
    loadPlexImport,
    importing === 'plex',
    couldNotOpen
  );
  const jellyfinImport = useLazyModule(
    loadJellyfinImport,
    importing === 'jellyfin' || importing === 'emby',
    couldNotOpen
  );

  const schema = yup
    .object()
    .shape({
      localLogin: yup.boolean(),
      mediaServerLogin: yup.boolean(),
    })
    .test({
      name: 'atLeastOneAuth',
      test: function (values) {
        const isValid = (
          ['localLogin', 'mediaServerLogin'] as (keyof typeof values)[]
        ).some((field) => !!values[field]);

        if (isValid) return true;
        return this.createError({
          path: 'localLogin | mediaServerLogin',
          message: intl.formatMessage(messages.atLeastOneAuth),
        });
      },
    });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  // With one server connected the switches are named after it; with
  // several, they stand for them all.
  const servers = settings.currentSettings.mediaServers;
  const several = servers.length > 1;
  const mediaServerFormatValues = {
    mediaServerName: servers[0] ? SERVER_NAMES[servers[0].kind] : undefined,
  };
  const plexConnected = servers.some((server) => server.kind === 'plex');

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.users),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.userSettings)}</h3>
        <p className="description">
          {intl.formatMessage(messages.userSettingsDescription)}
        </p>
      </div>
      <div className="section">
        <Formik
          initialValues={{
            localLogin: data?.localLogin,
            mediaServerLogin: data?.mediaServerLogin,
            newPlexLogin: data?.newPlexLogin,
            autoImportPlexUsers: data?.autoImportPlexUsers ?? false,
            personalApiKeys: data?.personalApiKeys ?? 'off',
            movieQuotaLimit: data?.defaultQuotas.movie.quotaLimit ?? 0,
            movieQuotaDays: data?.defaultQuotas.movie.quotaDays ?? 7,
            tvQuotaLimit: data?.defaultQuotas.tv.quotaLimit ?? 0,
            tvQuotaDays: data?.defaultQuotas.tv.quotaDays ?? 7,
            musicQuotaLimit: data?.defaultQuotas.music?.quotaLimit ?? 0,
            musicQuotaDays: data?.defaultQuotas.music?.quotaDays ?? 7,
            defaultPermissions: data?.defaultPermissions ?? 0,
            defaultWatchlistSyncMovies:
              data?.defaultWatchlistSyncMovies ?? false,
            defaultWatchlistSyncTv: data?.defaultWatchlistSyncTv ?? false,
          }}
          validationSchema={schema}
          enableReinitialize
          onSubmit={async (values) => {
            try {
              await axios.post('/api/v1/settings/main', {
                localLogin: values.localLogin,
                mediaServerLogin: values.mediaServerLogin,
                newPlexLogin: values.newPlexLogin,
                autoImportPlexUsers: values.autoImportPlexUsers,
                personalApiKeys: values.personalApiKeys,
                defaultQuotas: {
                  movie: {
                    quotaLimit: values.movieQuotaLimit,
                    quotaDays: values.movieQuotaDays,
                  },
                  tv: {
                    quotaLimit: values.tvQuotaLimit,
                    quotaDays: values.tvQuotaDays,
                  },
                  music: {
                    quotaLimit: values.musicQuotaLimit,
                    quotaDays: values.musicQuotaDays,
                  },
                },
                defaultPermissions: values.defaultPermissions,
                defaultWatchlistSyncMovies: values.defaultWatchlistSyncMovies,
                defaultWatchlistSyncTv: values.defaultWatchlistSyncTv,
              });
              mutate('/api/v1/settings/public');

              addToast(intl.formatMessage(messages.toastSettingsSuccess), {
                autoDismiss: true,
                appearance: 'success',
              });
            } catch {
              addToast(intl.formatMessage(messages.toastSettingsFailure), {
                autoDismiss: true,
                appearance: 'error',
              });
            } finally {
              revalidate();
            }
          }}
        >
          {({ isSubmitting, isValid, values, errors, setFieldValue }) => {
            return (
              <Form className="section">
                <div
                  role="group"
                  aria-labelledby="group-label"
                  className="form-group"
                >
                  <div className="form-row">
                    <span id="group-label" className="group-label">
                      {intl.formatMessage(messages.loginMethods)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.loginMethodsTip)}
                      </span>
                      {'localLogin | mediaServerLogin' in errors && (
                        <span className="error">
                          {errors['localLogin | mediaServerLogin'] as string}
                        </span>
                      )}
                    </span>

                    <div className="form-input-area max-w-lg">
                      <LabeledCheckbox
                        id="localLogin"
                        label={intl.formatMessage(messages.localLogin)}
                        description={intl.formatMessage(
                          messages.localLoginTip,
                          mediaServerFormatValues
                        )}
                        onChange={() =>
                          setFieldValue('localLogin', !values.localLogin)
                        }
                      />
                      <LabeledCheckbox
                        id="mediaServerLogin"
                        className="mt-4"
                        label={intl.formatMessage(
                          several
                            ? messages.mediaServersLogin
                            : messages.mediaServerLogin,
                          mediaServerFormatValues
                        )}
                        description={intl.formatMessage(
                          several
                            ? messages.mediaServersLoginTip
                            : messages.mediaServerLoginTip,
                          mediaServerFormatValues
                        )}
                        onChange={() =>
                          setFieldValue(
                            'mediaServerLogin',
                            !values.mediaServerLogin
                          )
                        }
                      />
                      {!values.mediaServerLogin && values.localLogin && (
                        <div className="mt-4">
                          <Alert
                            title={intl.formatMessage(
                              several
                                ? messages.disabledMediaServersLoginWarning
                                : messages.disabledMediaServerLoginWarning,
                              {
                                applicationTitle:
                                  settings.currentSettings.applicationTitle,
                                ...mediaServerFormatValues,
                              }
                            )}
                            type="warning"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="form-row">
                  <label htmlFor="newPlexLogin" className="checkbox-label">
                    {intl.formatMessage(
                      several
                        ? messages.newMediaServersLogin
                        : messages.newPlexLogin,
                      mediaServerFormatValues
                    )}
                    <span className="label-tip">
                      {intl.formatMessage(
                        several
                          ? messages.newMediaServersLoginTip
                          : messages.newPlexLoginTip,
                        mediaServerFormatValues
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="newPlexLogin"
                      name="newPlexLogin"
                      onChange={() => {
                        setFieldValue('newPlexLogin', !values.newPlexLogin);
                      }}
                    />
                  </div>
                </div>
                {plexConnected && (
                  <div className="form-row">
                    <label
                      htmlFor="autoImportPlexUsers"
                      className="checkbox-label"
                    >
                      {intl.formatMessage(messages.autoImportPlexUsers)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.autoImportPlexUsersTip)}
                      </span>
                    </label>
                    <div className="form-input-area">
                      <Field
                        type="checkbox"
                        id="autoImportPlexUsers"
                        name="autoImportPlexUsers"
                        onChange={() => {
                          setFieldValue(
                            'autoImportPlexUsers',
                            !values.autoImportPlexUsers
                          );
                        }}
                      />
                    </div>
                  </div>
                )}
                <div className="form-row">
                  <label htmlFor="personalApiKeys" className="checkbox-label">
                    {intl.formatMessage(messages.personalApiKeys)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.personalApiKeysTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <input
                      type="checkbox"
                      id="personalApiKeys"
                      checked={values.personalApiKeys !== 'off'}
                      onChange={() =>
                        // Turned on, it starts with the narrower choice.
                        setFieldValue(
                          'personalApiKeys',
                          values.personalApiKeys === 'off' ? 'managers' : 'off'
                        )
                      }
                    />
                  </div>
                </div>
                {values.personalApiKeys !== 'off' && (
                  <div className="form-row">
                    <label htmlFor="personalApiKeysWho" className="text-label">
                      {intl.formatMessage(messages.personalApiKeysWho)}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field
                          as="select"
                          id="personalApiKeysWho"
                          name="personalApiKeys"
                        >
                          <option value="managers">
                            {intl.formatMessage(
                              messages.personalApiKeysManagers
                            )}
                          </option>
                          <option value="everyone">
                            {intl.formatMessage(
                              messages.personalApiKeysEveryone
                            )}
                          </option>
                        </Field>
                      </div>
                    </div>
                  </div>
                )}
                <div className="form-row">
                  <label htmlFor="movieQuotaLimit" className="text-label">
                    {intl.formatMessage(messages.movieRequestLimitLabel)}
                  </label>
                  <div className="form-input-area">
                    <QuotaSelector
                      onChange={setFieldValue}
                      dayFieldName="movieQuotaDays"
                      limitFieldName="movieQuotaLimit"
                      mediaType="movie"
                      defaultDays={values.movieQuotaDays}
                      defaultLimit={values.movieQuotaLimit}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="tvQuotaLimit" className="text-label">
                    {intl.formatMessage(messages.tvRequestLimitLabel)}
                  </label>
                  <div className="form-input-area">
                    <QuotaSelector
                      onChange={setFieldValue}
                      dayFieldName="tvQuotaDays"
                      limitFieldName="tvQuotaLimit"
                      mediaType="tv"
                      defaultDays={values.tvQuotaDays}
                      defaultLimit={values.tvQuotaLimit}
                    />
                  </div>
                </div>
                {musicReady && (
                  <div className="form-row">
                    <label htmlFor="musicQuotaLimit" className="text-label">
                      {intl.formatMessage(messages.musicRequestLimitLabel)}
                    </label>
                    <div className="form-input-area">
                      <QuotaSelector
                        onChange={setFieldValue}
                        dayFieldName="musicQuotaDays"
                        limitFieldName="musicQuotaLimit"
                        mediaType="music"
                        defaultDays={values.musicQuotaDays}
                        defaultLimit={values.musicQuotaLimit}
                      />
                    </div>
                  </div>
                )}
                <div
                  role="group"
                  aria-labelledby="watchlist-sync-label"
                  className="form-group"
                >
                  <div className="form-row">
                    <span id="watchlist-sync-label" className="group-label">
                      {intl.formatMessage(messages.defaultWatchlistSync)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.defaultWatchlistSyncTip)}
                      </span>
                    </span>
                    <div className="form-input-area max-w-lg">
                      <LabeledCheckbox
                        id="defaultWatchlistSyncMovies"
                        label={intl.formatMessage(
                          messages.defaultWatchlistSyncMovies
                        )}
                        description={intl.formatMessage(
                          messages.defaultWatchlistSyncMoviesTip
                        )}
                        onChange={() =>
                          setFieldValue(
                            'defaultWatchlistSyncMovies',
                            !values.defaultWatchlistSyncMovies
                          )
                        }
                      />
                      <LabeledCheckbox
                        id="defaultWatchlistSyncTv"
                        className="mt-4"
                        label={intl.formatMessage(
                          messages.defaultWatchlistSyncTv
                        )}
                        description={intl.formatMessage(
                          messages.defaultWatchlistSyncTvTip
                        )}
                        onChange={() =>
                          setFieldValue(
                            'defaultWatchlistSyncTv',
                            !values.defaultWatchlistSyncTv
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
                <div
                  role="group"
                  aria-labelledby="group-label"
                  className="form-group"
                >
                  <div className="form-row">
                    <span id="group-label" className="group-label">
                      {intl.formatMessage(messages.defaultPermissions)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.defaultPermissionsTip)}
                      </span>
                    </span>
                    <div className="form-input-area">
                      <div className="max-w-lg">
                        <PermissionEdit
                          currentPermission={values.defaultPermissions}
                          onUpdate={(newPermissions) =>
                            setFieldValue('defaultPermissions', newPermissions)
                          }
                        />
                      </div>
                    </div>
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
              </Form>
            );
          }}
        </Formik>
      </div>
      {servers.length > 0 && (
        <>
          <div className="mb-6 mt-10">
            <h3 className="heading">
              {intl.formatMessage(messages.importUsers)}
            </h3>
            <p className="description">
              {intl.formatMessage(messages.importUsersTip)}
            </p>
          </div>
          <div className="section flex flex-wrap gap-3">
            {servers.map((server) => (
              <Button
                key={server.kind}
                type="button"
                onClick={() => setImporting(server.kind)}
              >
                <InboxArrowDownIcon />
                <span>
                  {intl.formatMessage(messages.importFrom, {
                    mediaServerName: SERVER_NAMES[server.kind],
                  })}
                </span>
              </Button>
            ))}
          </div>
        </>
      )}
      <SingleSignOn />
      <Transition
        as="div"
        show={!!importing}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        {importing === 'plex' && plexImport && (
          <plexImport.default
            onCancel={() => setImporting(undefined)}
            onComplete={() => setImporting(undefined)}
          />
        )}
        {(importing === 'jellyfin' || importing === 'emby') &&
          jellyfinImport && (
            <jellyfinImport.default
              kind={importing}
              onCancel={() => setImporting(undefined)}
              onComplete={() => setImporting(undefined)}
            />
          )}
      </Transition>
    </>
  );
};

export default SettingsUsers;
