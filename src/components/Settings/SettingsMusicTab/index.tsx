import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import FeatureSwitches from '@app/components/Common/FeatureSwitches';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import { useFeaturesForEveryone } from '@app/components/Settings/SettingsFeatures';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import { FEATURES } from '@server/constants/features';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsMusicTab', {
  music: 'Music',
  description:
    'Music in one place: whether it is on, how people search for it, and where the rest of its settings are.',
  addLidarr: 'Add Lidarr under Services to start.',
  addLidarrTip:
    'Music appears for everyone once a Lidarr server is added and made the default.',
  openServices: 'Open Services',
  search: 'Search',
  searchDescription:
    'Where people can search for artists and albums, and how many a search shows. Anyone who turned music off for themselves sees none of it.',
  inAll: 'Include Music in All Search Results',
  inAllTip:
    'A row of artists and a row of albums below the films, series, collections and people, loaded after them so they never slow them down',
  musicPage: 'Search on the Music Page',
  musicPageTip: 'The Music page’s own search box for artists and albums',
  chip: 'Music on the Search Page',
  chipTip: 'Music as a choice beside All, Movies and Series in search results',
  artists: 'Artists per Search',
  albums: 'Albums per Search',
  countTip: 'From 1 to {most}',
  validationCount: 'A whole number from 1 to {most}',
  offForEveryone:
    'Music is off for everyone. Turn it on to choose how it is searched.',
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
  discoverRowsTip:
    'The Recently Added Music, New Music, Popular Albums and Popular Artists rows, moved or hidden like any row.',
  metadata: 'Where Music Comes From',
  metadataWhere: 'Settings → Metadata Providers',
  metadataTip:
    'MusicBrainz or a mirror of it, ListenBrainz, TheAudioDB, and the most albums one request may ask for.',
  loadFailed: 'Music search settings could not be loaded.',
  saved: 'Music search settings saved.',
  saveFailed: 'Music search settings could not be saved.',
});

/** The most artists, or albums, a search may show (the server's bound). */
const MOST_RESULTS = 25;

interface MusicSearchSettings {
  inAll: boolean;
  musicPage: boolean;
  chip: boolean;
  artists: number;
  albums: number;
}

/** Every feature but music, left out of the switch shown here. */
const NOT_MUSIC = FEATURES.filter((feature) => feature !== 'music');

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
  {
    href: '/settings/metadata',
    title: messages.metadata,
    where: messages.metadataWhere,
    tip: messages.metadataTip,
  },
];

/** Whether music is searched, and how much a search shows. */
const MusicSearchForm = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const { data, error, mutate } = useSWR<MusicSearchSettings>(
    '/api/v1/settings/music/search'
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

  const count = Yup.number()
    .typeError(
      intl.formatMessage(messages.validationCount, { most: MOST_RESULTS })
    )
    .integer(
      intl.formatMessage(messages.validationCount, { most: MOST_RESULTS })
    )
    .min(
      1,
      intl.formatMessage(messages.validationCount, { most: MOST_RESULTS })
    )
    .max(
      MOST_RESULTS,
      intl.formatMessage(messages.validationCount, { most: MOST_RESULTS })
    )
    .required(
      intl.formatMessage(messages.validationCount, { most: MOST_RESULTS })
    );
  const schema = Yup.object().shape({ artists: count, albums: count });

  const checkbox = (name: 'inAll' | 'musicPage' | 'chip') => (
    <div className="form-row">
      <label htmlFor={name} className="checkbox-label">
        {intl.formatMessage(messages[name])}
        <span className="label-tip">
          {intl.formatMessage(messages[`${name}Tip`])}
        </span>
      </label>
      <div className="form-input-area">
        <Field type="checkbox" id={name} name={name} />
      </div>
    </div>
  );

  return (
    <Formik
      initialValues={data}
      validationSchema={schema}
      enableReinitialize
      onSubmit={async (values) => {
        try {
          const response = await axios.post<MusicSearchSettings>(
            '/api/v1/settings/music/search',
            {
              ...values,
              artists: Number(values.artists),
              albums: Number(values.albums),
            }
          );
          await mutate(response.data, { revalidate: false });
          // The search page and the Music page read these from the public
          // settings.
          await globalMutate('/api/v1/settings/public');
          addToast(intl.formatMessage(messages.saved), {
            appearance: 'success',
            autoDismiss: true,
          });
        } catch {
          addToast(intl.formatMessage(messages.saveFailed), {
            appearance: 'error',
            autoDismiss: true,
          });
        }
      }}
    >
      {({ errors, touched, isSubmitting, isValid }) => (
        <Form className="section">
          {checkbox('inAll')}
          {checkbox('musicPage')}
          {checkbox('chip')}
          {(['artists', 'albums'] as const).map((name) => (
            <div className="form-row" key={name}>
              <label htmlFor={name} className="text-label">
                {intl.formatMessage(messages[name])}
                <span className="label-tip">
                  {intl.formatMessage(messages.countTip, {
                    most: MOST_RESULTS,
                  })}
                </span>
              </label>
              <div className="form-input-area">
                <Field
                  id={name}
                  name={name}
                  type="text"
                  inputMode="numeric"
                  className="short"
                />
                {errors[name] && touched[name] && (
                  <div className="error">{errors[name]}</div>
                )}
              </div>
            </div>
          ))}
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
        </Form>
      )}
    </Formik>
  );
};

/**
 * Settings → Music: the Music switch (the same one as in Features), how
 * music is searched, and links to music's settings elsewhere. There before
 * a Lidarr is added, since that is where music starts.
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
              className="font-medium text-indigo-300 underline hover:text-indigo-200"
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
          hidden={NOT_MUSIC}
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
      {on && <MusicSearchForm />}

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
                  className="font-medium text-indigo-400 hover:underline"
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
