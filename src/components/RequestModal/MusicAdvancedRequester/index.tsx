import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import type {
  LidarrServer,
  LidarrServerWithDetails,
} from '@server/interfaces/api/serviceInterfaces';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import { hasPermission } from '@server/lib/permissions';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR from 'swr';

const messages = defineMessages(
  'components.RequestModal.MusicAdvancedRequester',
  {
    advancedoptions: 'Advanced',
    destinationserver: 'Destination Server',
    qualityprofile: 'Quality Profile',
    metadataprofile: 'Metadata Profile',
    rootfolder: 'Root Folder',
    default: '{name} (Default)',
    folder: '{path} ({space})',
    tags: 'Tags',
    selecttags: 'Select tags',
    notagoptions: 'No tags.',
    requestas: 'Request As',
    ignoreQuotaTitle: 'Bypass User Quota',
    ignoreQuotaDescription:
      "This request will not count against the user's quota limits. Use with caution.",
    artistKept:
      'Lidarr already has this artist, so their folder and profiles stay as they are.',
  }
);

/** What someone allowed the advanced options chose for a music request. */
export interface MusicOverrides {
  server?: number;
  profile?: number;
  metadataProfile?: number;
  folder?: string;
  tags?: number[];
  /** The person it is requested for, by id; the signed-in person if unset. */
  userId?: number;
  ignoreQuota?: boolean;
}

interface MusicAdvancedRequesterProps {
  servers: LidarrServer[];
  /** The chosen server's profiles, folders and tags, and the artist there. */
  serverData?: LidarrServerWithDetails;
  value: MusicOverrides;
  onChange: (value: MusicOverrides) => void;
  /** Bypassing the quota is offered: the person asked for has one. */
  quotaLimited: boolean;
}

/**
 * The advanced options of a music request: which Lidarr, its quality and
 * metadata profiles, root folder and tags, and for managers whom it is for.
 * An artist Lidarr already has keeps its own folder and profiles, so those
 * are shown but cannot be changed.
 */
const MusicAdvancedRequester = ({
  servers,
  serverData,
  value,
  onChange,
  quotaLimited,
}: MusicAdvancedRequesterProps) => {
  const intl = useIntl();
  const { user, hasPermission: currentHasPermission } = useUser();
  const canChooseUser = currentHasPermission([
    Permission.MANAGE_REQUESTS,
    Permission.MANAGE_USERS,
  ]);
  const { data: userData } = useSWR<UserResultsResponse>(
    canChooseUser ? '/api/v1/user?take=1000&sort=displayname' : null
  );
  const requesters = (userData?.results ?? []).filter((person) =>
    hasPermission(
      [Permission.REQUEST, Permission.REQUEST_MUSIC],
      person.permissions,
      { type: 'or' }
    )
  );
  const set = (change: MusicOverrides) => onChange({ ...value, ...change });
  const artist = serverData?.artist;
  const loading = !serverData;
  const showIgnoreQuota =
    currentHasPermission(Permission.MANAGE_REQUESTS) && quotaLimited;

  const defaultName = (name: string, isDefault: boolean) =>
    isDefault ? intl.formatMessage(messages.default, { name }) : name;

  return (
    <>
      <div className="mb-2 mt-4 flex items-center text-lg font-semibold">
        {intl.formatMessage(messages.advancedoptions)}
      </div>
      {artist && (
        <p className="mb-3 text-sm text-gray-400">
          {intl.formatMessage(messages.artistKept)}
        </p>
      )}
      <div className="flex flex-col md:flex-row md:flex-wrap">
        {servers.length > 1 && (
          <div className="mb-3 w-full md:w-1/2 md:pr-4">
            <label htmlFor="music-server">
              {intl.formatMessage(messages.destinationserver)}
            </label>
            <select
              id="music-server"
              value={value.server ?? ''}
              onChange={(e) =>
                // Another server has its own profiles and folders.
                onChange({
                  ...value,
                  server: Number(e.target.value),
                  profile: undefined,
                  metadataProfile: undefined,
                  folder: undefined,
                  tags: undefined,
                })
              }
              className="border-gray-700 bg-gray-800"
            >
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {defaultName(server.name, server.isDefault)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="mb-3 w-full md:w-1/2 md:pr-4">
          <label htmlFor="music-profile">
            {intl.formatMessage(messages.qualityprofile)}
          </label>
          <select
            id="music-profile"
            value={artist?.qualityProfileId ?? value.profile ?? ''}
            onChange={(e) => set({ profile: Number(e.target.value) })}
            className="border-gray-700 bg-gray-800"
            disabled={loading || !!artist}
          >
            {loading && (
              <option value="">
                {intl.formatMessage(globalMessages.loading)}
              </option>
            )}
            {serverData?.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {defaultName(
                  profile.name,
                  serverData.server.activeProfileId === profile.id
                )}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-3 w-full md:w-1/2 md:pr-4">
          <label htmlFor="music-metadata-profile">
            {intl.formatMessage(messages.metadataprofile)}
          </label>
          <select
            id="music-metadata-profile"
            value={artist?.metadataProfileId ?? value.metadataProfile ?? ''}
            onChange={(e) => set({ metadataProfile: Number(e.target.value) })}
            className="border-gray-700 bg-gray-800"
            disabled={loading || !!artist}
          >
            {loading && (
              <option value="">
                {intl.formatMessage(globalMessages.loading)}
              </option>
            )}
            {serverData?.metadataProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {defaultName(
                  profile.name,
                  serverData.server.activeMetadataProfileId === profile.id
                )}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-3 w-full md:w-1/2 md:pr-4">
          <label htmlFor="music-folder">
            {intl.formatMessage(messages.rootfolder)}
          </label>
          <select
            id="music-folder"
            value={artist?.rootFolderPath ?? value.folder ?? ''}
            onChange={(e) => set({ folder: e.target.value })}
            className="border-gray-700 bg-gray-800"
            disabled={loading || !!artist}
          >
            {loading && (
              <option value="">
                {intl.formatMessage(globalMessages.loading)}
              </option>
            )}
            {artist?.rootFolderPath &&
              !serverData?.rootFolders.some(
                (folder) => folder.path === artist.rootFolderPath
              ) && (
                <option value={artist.rootFolderPath}>
                  {artist.rootFolderPath}
                </option>
              )}
            {serverData?.rootFolders.map((folder) => (
              <option key={folder.id} value={folder.path}>
                {defaultName(
                  intl.formatMessage(messages.folder, {
                    path: folder.path,
                    space: formatBytes(folder.freeSpace ?? 0),
                  }),
                  serverData.server.activeDirectory === folder.path
                )}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!!serverData?.tags.length && (
        <div className="mb-2">
          <label htmlFor="music-tags">
            {intl.formatMessage(messages.tags)}
          </label>
          <Select<{ value: number; label: string }, true>
            inputId="music-tags"
            options={serverData.tags.map((tag) => ({
              label: tag.label,
              value: tag.id,
            }))}
            isMulti
            placeholder={intl.formatMessage(messages.selecttags)}
            className="react-select-container react-select-container-dark"
            classNamePrefix="react-select"
            value={serverData.tags
              .filter((tag) => (value.tags ?? []).includes(tag.id))
              .map((tag) => ({ value: tag.id, label: tag.label }))}
            onChange={(chosen) =>
              set({ tags: chosen.map((option) => option.value) })
            }
            noOptionsMessage={() => intl.formatMessage(messages.notagoptions)}
          />
        </div>
      )}
      {showIgnoreQuota && (
        <div className="mb-2">
          <span className="font-medium">
            {intl.formatMessage(messages.ignoreQuotaTitle)}
          </span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">
              {intl.formatMessage(messages.ignoreQuotaDescription)}
            </p>
            <SlideCheckbox
              label={intl.formatMessage(messages.ignoreQuotaTitle)}
              checked={!!value.ignoreQuota}
              onClick={() => set({ ignoreQuota: !value.ignoreQuota })}
            />
          </div>
        </div>
      )}
      {canChooseUser && requesters.length > 1 && (
        <div className="mb-2">
          <label htmlFor="music-request-as">
            {intl.formatMessage(messages.requestas)}
          </label>
          <select
            id="music-request-as"
            value={value.userId ?? user?.id ?? ''}
            onChange={(e) =>
              set({ userId: Number(e.target.value), ignoreQuota: false })
            }
            className="border-gray-700 bg-gray-800"
          >
            {requesters.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
};

export default MusicAdvancedRequester;
