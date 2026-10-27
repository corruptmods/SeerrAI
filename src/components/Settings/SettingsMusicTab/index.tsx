import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import FeatureSwitches from '@app/components/Common/FeatureSwitches';
import { NOT_ON_MUSIC_PAGE } from '@app/components/Common/FeatureSwitches/shown';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import { useFeaturesForEveryone } from '@app/components/Settings/SettingsFeatures';
import type {
  MusicSourceValues,
  ShownMusicSettings,
} from '@app/components/Settings/SettingsMusic';
import MusicSources, {
  musicSourceBody,
  musicSourceSchema,
  musicSourceValues,
  messages as sourceMessages,
} from '@app/components/Settings/SettingsMusic';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsMusicTab', {
  music: 'Music',
  description: 'Everything about music in one place.',
  addLidarr: 'Add Lidarr under Services to start.',
  addLidarrTip:
    'Music appears for everyone once a Lidarr server is added and made the default.',
  openServices: 'Open Services',
  search: 'Search',
  searchDescription:
    'Search gets a Music tab, and the Music page its own search box. Hidden for anyone who turned music off.',
  inAll: 'Include Music in All Search Results',
  inAllTip:
    'Artist and album rows below the other results, loaded last so they never slow them down. On to start once Lidarr is set up.',
  offForEveryone: 'Music is off for everyone. Turn it on to set it up.',
  metadata: 'Where Music Comes From',
  whereItLives: 'Where It Lives',
  whereItLivesDescription:
    'The rest of music’s settings stay with what they belong to.',
  lidarr: 'Lidarr',
  lidarrWhere: 'Settings → Services',
  lidarrTip:
    'The Lidarr servers music is requested through, with their profiles, folders and tags.',
  libraries: 'Music Libraries',
  librariesWhere: 'Settings → Media Servers',
  librariesTip:
    'Each server’s music libraries, under Edit, which say which albums are here.',
  albumLimits: 'Album Limits',
  albumLimitsWhere: 'Settings → Users',
  albumLimitsTip:
    'How many albums each person may request, like seasons for series.',
  discoverRows: 'Music on Discover',
  discoverRowsWhere: 'Discover → Customize Discover',
  discoverRowsTip: 'The music rows on Discover, moved or hidden like any row.',
  loadFailed: 'Music settings could not be loaded.',
});

/** Where the rest of music's settings are, in the order they are set up. */
const PLACES = [
  {
    href: '/settings/services',
    title: messages.lidarr,
    where: messages.lidarrWhere,
    tip: messages.lidarrTip,
  },
  {
    href: '/settings/media-servers',
    title: messages.libraries,
    where: messages.librariesWhere,
    tip: messages.librariesTip,
  },
  {
    href: '/settings/users',
    title: messages.albumLimits,
    where: messages.albumLimitsWhere,
    tip: messages.albumLimitsTip,
  },
  {
    href: '/',
    title: messages.discoverRows,
    where: messages.discoverRowsWhere,
    tip: messages.discoverRowsTip,
  },
];

/**
 * How music is searched and where its details come from, loaded and saved
 * together.
 */
const MusicSettingsForm = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const { data, error, mutate } = useSWR<ShownMusicSettings>(
    '/api/v1/settings/music'
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }
  if (!data) {
    return (
      <Alert type="error" title={intl.formatMessage(messages.loadFailed)}>
        <Button buttonSize="sm" onClick={() => mutate()}>
          <ArrowPathIcon />
          <span>{intl.formatMessage(globalMessages.retry)}</span>
        </Button>
      </Alert>
    );
  }

  return (
    <Formik<MusicSourceValues & { inAll: boolean }>
      initialValues={{ inAll: data.search.inAll, ...musicSourceValues(data) }}
      validationSchema={Yup.object().shape(musicSourceSchema(intl))}
      enableReinitialize
      onSubmit={async ({ inAll, ...sources }) => {
        try {
          // Sent only when changed: left alone, it stays on while Lidarr
          // is set up and off while it isn't.
          const response = await axios.post<ShownMusicSettings>(
            '/api/v1/settings/music',
            {
              ...musicSourceBody(sources),
              ...(inAll !== data.search.inAll ? { search: { inAll } } : {}),
            }
          );
          await mutate(response.data, { revalidate: false });
          // The search page reads whether music is in All from the public
          // settings.
          await globalMutate('/api/v1/settings/public');
          addToast(intl.formatMessage(sourceMessages.saved), {
            appearance: 'success',
            autoDismiss: true,
          });
        } catch {
          addToast(intl.formatMessage(sourceMessages.saveFailed), {
            appearance: 'error',
            autoDismiss: true,
          });
        }
      }}
    >
      {({ isSubmitting, isValid }) => (
        <Form>
          <div className="section">
            <div className="form-row">
              <label htmlFor="inAll" className="checkbox-label">
                {intl.formatMessage(messages.inAll)}
                <span className="label-tip">
                  {intl.formatMessage(messages.inAllTip)}
                </span>
              </label>
              <div className="form-input-area">
                <Field type="checkbox" id="inAll" name="inAll" />
              </div>
            </div>
          </div>

          <div className="mb-6 mt-10">
            <h3 className="heading">{intl.formatMessage(messages.metadata)}</h3>
            <p className="description">
              {intl.formatMessage(sourceMessages.musicDescription)}
            </p>
          </div>
          <div className="section">
            <MusicSources hasTheAudioDbApiKey={data.hasTheAudioDbApiKey} />
            <div className="actions">
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
            </div>
          </div>
        </Form>
      )}
    </Formik>
  );
};

/**
 * Settings → Music: the Music switch (the only place it is, for everyone),
 * how music is searched, where its details come from, and links to music's
 * settings elsewhere. There before a Lidarr is added, since that is where
 * music starts.
 */
const SettingsMusicTab = () => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const { disabled, saving, change } = useFeaturesForEveryone();

  if (!disabled) {
    return <LoadingSpinner />;
  }

  const on = !disabled.includes('music');

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.music),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.music)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {on && !currentSettings.musicReady && (
        <Alert type="info" title={intl.formatMessage(messages.addLidarr)}>
          <p>
            {intl.formatMessage(messages.addLidarrTip)}{' '}
            <Link
              href="/settings/services"
              className="font-medium text-indigo-300 underline hover:text-indigo-200 light:text-accent-text light:hover:text-accent-text"
            >
              {intl.formatMessage(messages.openServices)}
            </Link>
          </p>
        </Alert>
      )}
      <div className="section">
        <FeatureSwitches
          disabled={disabled}
          saving={saving}
          aiReady={currentSettings.aiReady}
          musicReady
          hidden={NOT_ON_MUSIC_PAGE}
          onChange={change}
        />
      </div>

      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.search)}</h3>
        <p className="description">
          {intl.formatMessage(
            on ? messages.searchDescription : messages.offForEveryone
          )}
        </p>
      </div>
      {on && <MusicSettingsForm />}

      {on && currentSettings.musicReady && (
        <>
          <div className="mb-6 mt-10">
            <h3 className="heading">
              {intl.formatMessage(messages.whereItLives)}
            </h3>
            <p className="description">
              {intl.formatMessage(messages.whereItLivesDescription)}
            </p>
          </div>
          <ul className="section space-y-5">
            {PLACES.map((place) => (
              <li key={place.href}>
                <Link
                  href={place.href}
                  className="font-medium text-indigo-400 hover:underline light:text-accent-text"
                >
                  {intl.formatMessage(place.title)}
                </Link>
                <span className="ml-2 text-sm text-gray-500">
                  {intl.formatMessage(place.where)}
                </span>
                <p className="mt-1 text-sm text-gray-400">
                  {intl.formatMessage(place.tip)}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
};

export default SettingsMusicTab;
