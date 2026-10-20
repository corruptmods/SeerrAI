import { MediaType } from '@server/constants/media';
import type {
  AllSettings,
  DVRSettings,
  LidarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

/*
 * Which Radarr, Sonarr or Lidarr server a request goes to, and why it cannot
 * go anywhere when the server it was meant for has been removed from
 * Settings, Services. Nothing here looks at the database, so the request
 * entity can say it of itself when it is loaded.
 *
 * Having no server of a kind at all is not a problem: some servers run
 * without Radarr, Sonarr or Lidarr on purpose and fulfil those requests by
 * hand, so an approved request then stays approved, as it always has.
 */

export type RequestService = 'radarr' | 'sonarr' | 'lidarr';

export interface RequestServerIssue {
  /**
   * - `removed`: the server chosen for it no longer exists.
   * - `noDefault`: none was chosen, and none of its kind is the default.
   * - `none`: a 4K request, with Radarr or Sonarr servers set up but no 4K
   *   one. (With no server of its kind at all, there is no issue.)
   */
  reason: 'removed' | 'noDefault' | 'none';
  service: RequestService;
  /** Retrying sends it to the default server of its kind instead. */
  usesDefault: boolean;
}

/** What a request has to say which server it goes to. */
interface RoutedRequest {
  type: MediaType;
  serverId?: number | null;
  is4k?: boolean;
}

/** The servers of each kind, as the settings hold them. */
type Settings = Pick<AllSettings, 'radarr' | 'sonarr' | 'lidarr'>;

const SERVICE_NAMES: Record<RequestService, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  lidarr: 'Lidarr',
};

export const serviceFor = (type: MediaType): RequestService | undefined =>
  type === MediaType.MOVIE
    ? 'radarr'
    : type === MediaType.TV
      ? 'sonarr'
      : type === MediaType.MUSIC
        ? 'lidarr'
        : undefined;

const serversFor = (
  service: RequestService,
  settings: Settings
): (DVRSettings | LidarrSettings)[] => settings[service];

/** Whether a server of this kind could take a 4K request or not. Lidarr has no 4K. */
const sameTier = (
  service: RequestService,
  server: DVRSettings | LidarrSettings,
  is4k: boolean
) => service === 'lidarr' || server.is4k === is4k;

const chosenServer = (request: RoutedRequest) =>
  request.serverId !== null &&
  request.serverId !== undefined &&
  request.serverId >= 0
    ? request.serverId
    : undefined;

/** The default server a request of this kind (and 4K or not) goes to. */
export const defaultServerFor = (
  request: RoutedRequest,
  settings: Settings = getSettings()
): DVRSettings | LidarrSettings | undefined => {
  const service = serviceFor(request.type);
  return service
    ? serversFor(service, settings).find(
        (server) =>
          server.isDefault && sameTier(service, server, !!request.is4k)
      )
    : undefined;
};

/**
 * Whether the server a server id names still exists, among those of the
 * request's kind. Ids are only unique within a kind.
 */
export const serverExists = (
  type: MediaType,
  serverId: number,
  settings: Settings = getSettings()
): boolean => {
  const service = serviceFor(type);
  return (
    !!service &&
    serversFor(service, settings).some((server) => server.id === serverId)
  );
};

/** Whether any server of the kind a request goes to is set up. */
export const hasServersFor = (
  type: MediaType,
  settings: Settings = getSettings()
): boolean => {
  const service = serviceFor(type);
  return !!service && serversFor(service, settings).length > 0;
};

/**
 * Why a request has no server to go to, or nothing when it has one: the one
 * chosen for it, else the default of its kind. As the request is sent:
 * a chosen server is found by its id alone, the default must match 4K.
 * Nothing either when there is no server of its kind at all (see above).
 */
export const requestServerIssue = (
  request: RoutedRequest,
  settings: Settings = getSettings()
): RequestServerIssue | undefined => {
  const service = serviceFor(request.type);
  if (!service) {
    return undefined;
  }
  const servers = serversFor(service, settings);
  if (!servers.length) {
    return undefined;
  }
  const chosen = chosenServer(request);

  if (chosen !== undefined && servers.some((server) => server.id === chosen)) {
    return undefined;
  }
  const fallback = defaultServerFor(request, settings);
  if (chosen === undefined && fallback) {
    return undefined;
  }

  const reason = !servers.some((server) =>
    sameTier(service, server, !!request.is4k)
  )
    ? 'none'
    : chosen !== undefined
      ? 'removed'
      : 'noDefault';

  return { reason, service, usesDefault: !!fallback };
};

/** "Radarr", or "4K Radarr" for a 4K request. */
export const serviceName = (service: RequestService, is4k = false): string =>
  `${is4k && service !== 'lidarr' ? '4K ' : ''}${SERVICE_NAMES[service]}`;

/** The issue in English, for the log and the title's history. */
export const describeServerIssue = (
  issue: RequestServerIssue,
  is4k = false
): string => {
  const name = serviceName(issue.service, is4k);
  switch (issue.reason) {
    case 'removed':
      return `The ${name} server chosen for this request no longer exists.`;
    case 'noDefault':
      return `There is no default ${name} server. Did you set one of your ${name} servers as default?`;
    case 'none':
      return `No ${name} server is set up.`;
  }
};
