import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import type {
  ProfileService,
  UserDefaultProfile,
} from '@server/constants/requestDefaults';
import type {
  ServiceCommonServer,
  ServiceCommonServerWithDetails,
} from '@server/interfaces/api/serviceInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserGeneralSettings.DefaultProfiles',
  {
    defaultProfiles: 'Default Quality Profiles',
    defaultProfilesTip:
      'Picked first when you request, and used for requests made elsewhere, such as Siri or AI Search. If a server no longer has one, its own default is used.',
    movies: 'Movies',
    series: 'Series',
    anime: 'Anime',
    music: 'Music',
    serverDefault: 'Server default ({name})',
    loading: 'Loading profiles…',
    unavailable: 'Could not load this server’s profiles.',
  }
);

const KIND_LABEL = {
  radarr: messages.movies,
  sonarr: messages.series,
  lidarr: messages.music,
} as const;

interface DefaultProfilesProps {
  value: UserDefaultProfile[];
  onChange: (value: UserDefaultProfile[]) => void;
}

/** One server's profile choices: everything, and anime where it has one. */
const ServerProfiles = ({
  service,
  server,
  value,
  onChange,
}: {
  service: ProfileService;
  server: ServiceCommonServer;
  value: UserDefaultProfile[];
  onChange: (value: UserDefaultProfile[]) => void;
}) => {
  const intl = useIntl();
  const { data, error } = useSWR<ServiceCommonServerWithDetails>(
    `/api/v1/service/${service}/${server.id}`,
    { revalidateOnFocus: false }
  );
  const profileName = (id?: number) =>
    data?.profiles.find((profile) => profile.id === id)?.name ?? '';

  const kinds: { anime: boolean; label: string; serverDefault?: number }[] = [
    {
      anime: false,
      label: intl.formatMessage(KIND_LABEL[service]),
      serverDefault: server.activeProfileId,
    },
    ...(service !== 'lidarr' && server.activeAnimeProfileId
      ? [
          {
            anime: true,
            label: intl.formatMessage(messages.anime),
            serverDefault: server.activeAnimeProfileId,
          },
        ]
      : []),
  ];

  const chosen = (anime: boolean) =>
    value.find(
      (entry) =>
        entry.service === service &&
        entry.serverId === server.id &&
        !!entry.anime === anime
    )?.profileId;

  const choose = (anime: boolean, profileId?: number) =>
    onChange([
      ...value.filter(
        (entry) =>
          !(
            entry.service === service &&
            entry.serverId === server.id &&
            !!entry.anime === anime
          )
      ),
      ...(profileId
        ? [
            {
              service,
              serverId: server.id,
              ...(anime ? { anime } : {}),
              profileId,
            },
          ]
        : []),
    ]);

  return (
    <div className="mb-3">
      <p className="mb-1 text-sm font-medium text-gray-300">{server.name}</p>
      {error ? (
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.unavailable)}
        </p>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          {kinds.map((kind) => {
            const id = `default-profile-${service}-${server.id}${
              kind.anime ? '-anime' : ''
            }`;
            const saved = chosen(kind.anime);
            // A saved profile the server no longer has shows as the default.
            const shown =
              saved && data?.profiles.some((profile) => profile.id === saved)
                ? saved
                : '';
            return (
              <div key={id} className="w-full sm:w-1/2">
                <label htmlFor={id} className="text-sm text-gray-400">
                  {kind.label}
                </label>
                <select
                  id={id}
                  value={shown}
                  disabled={!data}
                  onChange={(e) =>
                    choose(kind.anime, Number(e.target.value) || undefined)
                  }
                >
                  <option value="">
                    {data
                      ? intl.formatMessage(messages.serverDefault, {
                          name: profileName(kind.serverDefault),
                        })
                      : intl.formatMessage(messages.loading)}
                  </option>
                  {(data?.profiles ?? [])
                    .toSorted((a, b) =>
                      a.name.localeCompare(b.name, intl.locale, {
                        numeric: true,
                        sensitivity: 'base',
                      })
                    )
                    .map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * Quality profiles someone picks for their own requests, per Radarr, Sonarr
 * and Lidarr server.
 */
const DefaultProfiles = ({ value, onChange }: DefaultProfilesProps) => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const { data: radarr } = useSWR<ServiceCommonServer[]>(
    '/api/v1/service/radarr'
  );
  const { data: sonarr } = useSWR<ServiceCommonServer[]>(
    '/api/v1/service/sonarr'
  );
  const { data: lidarr } = useSWR<ServiceCommonServer[]>(
    currentSettings.musicReady ? '/api/v1/service/lidarr' : null
  );
  const servers: [ProfileService, ServiceCommonServer[] | undefined][] = [
    ['radarr', radarr],
    ['sonarr', sonarr],
    ['lidarr', lidarr],
  ];

  if (!servers.some(([, list]) => list?.length)) {
    return null;
  }

  return (
    <div className="form-row">
      <span className="text-label">
        {intl.formatMessage(messages.defaultProfiles)}
        <span className="label-tip">
          {intl.formatMessage(messages.defaultProfilesTip)}
        </span>
      </span>
      <div className="form-input-area">
        <div className="max-w-lg">
          {servers.flatMap(([service, list]) =>
            (list ?? []).map((server) => (
              <ServerProfiles
                key={`${service}-${server.id}`}
                service={service}
                server={server}
                value={value}
                onChange={onChange}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default DefaultProfiles;
