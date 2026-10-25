import SensitiveInput from '@app/components/Common/SensitiveInput';
import QuotaSelector from '@app/components/QuotaSelector';
import defineMessages from '@app/utils/defineMessages';
import { Field, useFormikContext } from 'formik';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

export const messages = defineMessages('components.Settings.SettingsMusic', {
  musicDescription:
    'Where artists, albums and covers come from. MusicBrainz allows one request a second, so busy servers can use their own mirror.',
  musicbrainzUrl: 'MusicBrainz Address',
  musicbrainzUrlTip:
    'Leave blank for the public MusicBrainz. A mirror you run has no limit on requests.',
  contactEmail: 'Contact Email',
  contactEmailTip:
    'Optional. Sent with each MusicBrainz request so they can contact you.',
  listenBrainz: 'New and Popular Music',
  listenBrainzTip:
    'The New Music, Popular Albums and Popular Artists rows on Discover, from ListenBrainz.',
  theAudioDbApiKey: 'TheAudioDB API Key',
  theAudioDbApiKeyTip:
    'Optional: pictures of artists Lidarr has none of. A key comes with a TheAudioDB supporter account.',
  theAudioDbSaved: 'A key is saved. Leave blank to keep it.',
  removeKey: 'Remove the saved key',
  maxAlbumsPerRequest: 'Most Albums in One Request',
  maxAlbumsPerRequestTip:
    'The most albums a whole-discography request asks for.',
  songRequests: 'Song Requests',
  songRequestsTip:
    'Songs can be asked for one at a time, each version on its own (radio edit, club mix), from search and album pages.',
  songsFromAlbums: 'Take Songs from Albums',
  songsFromAlbumsTip:
    'A song that came out on no single is taken from its album: Backfill’s indexers and download client fetch the album, Lidarr imports only the song, and the rest is deleted. Needs Backfill set up.',
  songQuota: 'Song Limit',
  songQuotaTip:
    'Songs each person may ask for. Unlimited counts each song as one album against their music limit instead.',
  validationUrl: 'You must provide a valid URL',
  validationEmail: 'You must provide a valid email address',
  validationMaxAlbums: 'A number from 1 to 1000',
  saved: 'Music settings saved.',
  saveFailed: 'Music settings could not be saved.',
});

/** Music's settings as the server shows them: no key, only that one is set. */
export interface ShownMusicSettings {
  musicbrainzUrl: string;
  contactEmail: string;
  listenBrainz: boolean;
  maxAlbumsPerRequest: number;
  songRequests: boolean;
  songsFromAlbums: boolean;
  songQuota: { quotaLimit: number; quotaDays: number };
  hasTheAudioDbApiKey: boolean;
  search: { inAll: boolean };
}

export interface MusicSourceValues {
  musicbrainzUrl: string;
  contactEmail: string;
  listenBrainz: boolean;
  theAudioDbApiKey: string;
  removeTheAudioDbApiKey: boolean;
  maxAlbumsPerRequest: number | string;
  songRequests: boolean;
  songsFromAlbums: boolean;
  songQuotaLimit: number;
  songQuotaDays: number;
}

/** The fields as the form starts: the public MusicBrainz shows as blank. */
export const musicSourceValues = (
  data: ShownMusicSettings
): MusicSourceValues => ({
  musicbrainzUrl:
    data.musicbrainzUrl === 'https://musicbrainz.org'
      ? ''
      : data.musicbrainzUrl,
  contactEmail: data.contactEmail,
  listenBrainz: data.listenBrainz,
  theAudioDbApiKey: '',
  removeTheAudioDbApiKey: false,
  maxAlbumsPerRequest: data.maxAlbumsPerRequest,
  songRequests: data.songRequests,
  songsFromAlbums: data.songsFromAlbums,
  songQuotaLimit: data.songQuota.quotaLimit,
  songQuotaDays: data.songQuota.quotaDays,
});

/** The fields as the server takes them. */
export const musicSourceBody = ({
  songQuotaLimit,
  songQuotaDays,
  ...sources
}: MusicSourceValues) => ({
  ...sources,
  maxAlbumsPerRequest: Number(sources.maxAlbumsPerRequest),
  songQuota: { quotaLimit: songQuotaLimit, quotaDays: songQuotaDays },
});

/** What the fields must be before they are saved. */
export const musicSourceSchema = (intl: IntlShape) => ({
  musicbrainzUrl: Yup.string()
    .trim()
    .matches(/^(https?:\/\/\S+)?$/, intl.formatMessage(messages.validationUrl)),
  contactEmail: Yup.string()
    .trim()
    .email(intl.formatMessage(messages.validationEmail)),
  maxAlbumsPerRequest: Yup.number()
    .typeError(intl.formatMessage(messages.validationMaxAlbums))
    .integer(intl.formatMessage(messages.validationMaxAlbums))
    .min(1, intl.formatMessage(messages.validationMaxAlbums))
    .max(1000, intl.formatMessage(messages.validationMaxAlbums))
    .required(intl.formatMessage(messages.validationMaxAlbums)),
});

/*
 * Where music's details come from: MusicBrainz, ListenBrainz, TheAudioDB,
 * the most albums one request may ask for, and asking for songs one at a
 * time. The fields of Settings →
 * Music's form, which loads and saves them with the rest of the page.
 */
const MusicSources = ({
  hasTheAudioDbApiKey,
}: {
  hasTheAudioDbApiKey: boolean;
}) => {
  const intl = useIntl();
  const { errors, touched, values, setFieldValue } =
    useFormikContext<MusicSourceValues>();

  return (
    <>
      <div className="form-row">
        <label htmlFor="musicbrainzUrl" className="text-label">
          {intl.formatMessage(messages.musicbrainzUrl)}
          <span className="label-tip">
            {intl.formatMessage(messages.musicbrainzUrlTip)}
          </span>
        </label>
        <div className="form-input-area">
          <div className="form-input-field">
            <Field
              id="musicbrainzUrl"
              name="musicbrainzUrl"
              type="text"
              inputMode="url"
              placeholder="https://musicbrainz.org"
            />
          </div>
          {errors.musicbrainzUrl && touched.musicbrainzUrl && (
            <div className="error">{errors.musicbrainzUrl}</div>
          )}
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="contactEmail" className="text-label">
          {intl.formatMessage(messages.contactEmail)}
          <span className="label-tip">
            {intl.formatMessage(messages.contactEmailTip)}
          </span>
        </label>
        <div className="form-input-area">
          <div className="form-input-field">
            <Field
              id="contactEmail"
              name="contactEmail"
              type="email"
              inputMode="email"
            />
          </div>
          {errors.contactEmail && touched.contactEmail && (
            <div className="error">{errors.contactEmail}</div>
          )}
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="listenBrainz" className="checkbox-label">
          {intl.formatMessage(messages.listenBrainz)}
          <span className="label-tip">
            {intl.formatMessage(messages.listenBrainzTip)}
          </span>
        </label>
        <div className="form-input-area">
          <Field type="checkbox" id="listenBrainz" name="listenBrainz" />
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="theAudioDbApiKey" className="text-label">
          {intl.formatMessage(messages.theAudioDbApiKey)}
          <span className="label-tip">
            {hasTheAudioDbApiKey
              ? intl.formatMessage(messages.theAudioDbSaved)
              : intl.formatMessage(messages.theAudioDbApiKeyTip)}
          </span>
        </label>
        <div className="form-input-area">
          <div className="form-input-field">
            <SensitiveInput
              as="field"
              id="theAudioDbApiKey"
              name="theAudioDbApiKey"
              autoComplete="off"
              disabled={values.removeTheAudioDbApiKey}
            />
          </div>
          {hasTheAudioDbApiKey && (
            <label className="mt-2 flex items-center gap-2 text-sm text-gray-300">
              <Field
                type="checkbox"
                id="removeTheAudioDbApiKey"
                name="removeTheAudioDbApiKey"
              />
              {intl.formatMessage(messages.removeKey)}
            </label>
          )}
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="maxAlbumsPerRequest" className="text-label">
          {intl.formatMessage(messages.maxAlbumsPerRequest)}
          <span className="label-tip">
            {intl.formatMessage(messages.maxAlbumsPerRequestTip)}
          </span>
        </label>
        <div className="form-input-area">
          <Field
            id="maxAlbumsPerRequest"
            name="maxAlbumsPerRequest"
            type="text"
            inputMode="numeric"
            className="short"
          />
          {errors.maxAlbumsPerRequest && touched.maxAlbumsPerRequest && (
            <div className="error">{errors.maxAlbumsPerRequest}</div>
          )}
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="songRequests" className="checkbox-label">
          {intl.formatMessage(messages.songRequests)}
          <span className="label-tip">
            {intl.formatMessage(messages.songRequestsTip)}
          </span>
        </label>
        <div className="form-input-area">
          <Field type="checkbox" id="songRequests" name="songRequests" />
        </div>
      </div>
      {values.songRequests && (
        <div className="form-row">
          <label htmlFor="songsFromAlbums" className="checkbox-label">
            {intl.formatMessage(messages.songsFromAlbums)}
            <span className="label-tip">
              {intl.formatMessage(messages.songsFromAlbumsTip)}
            </span>
          </label>
          <div className="form-input-area">
            <Field
              type="checkbox"
              id="songsFromAlbums"
              name="songsFromAlbums"
            />
          </div>
        </div>
      )}
      {values.songRequests && (
        <div className="form-row">
          <label htmlFor="songQuotaLimit" className="text-label">
            {intl.formatMessage(messages.songQuota)}
            <span className="label-tip">
              {intl.formatMessage(messages.songQuotaTip)}
            </span>
          </label>
          <div className="form-input-area">
            <QuotaSelector
              mediaType="song"
              limitFieldName="songQuotaLimit"
              dayFieldName="songQuotaDays"
              defaultLimit={Number(values.songQuotaLimit)}
              defaultDays={Number(values.songQuotaDays)}
              onChange={setFieldValue}
            />
          </div>
        </div>
      )}
    </>
  );
};

export default MusicSources;
