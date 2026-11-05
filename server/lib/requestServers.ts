import { MediaType } from '@server/constants/media';
import type {
  AllSettings,
  DVRSettings,
  LidarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

/*
 * Which Radarr, Sonarr or Lidarr server a request goes to, and why it can't
 * when its server was removed from Settings → Services. No database access,
 * so the request entity can compute it on load.
 *
 * Having no server of a kind is fine: some setups run without one on purpose
 * and fulfil those requests by hand, so an approved request stays approved.
 */

export type RequestService = 'radarr' | 'sonarr' | 'lidarr';

export interface RequestServerIssue {
  /**
   * - `removed`: its chosen server no longer exists.
   * - `noDefault`: none chosen, and no default of its kind.
   * - `none`: a 4K request with Radarr or Sonarr servers but no 4K one. (No
   *   server of its kind at all is no issue.)
   */
  reason: 'removed' | 'noDefault' | 'none';
  service: RequestService;
  /** Retrying sends it to its kind's default server instead. */
  usesDefault: boolean;
}

/** The request fields that decide its server. */
interface RoutedRequest {
  type: MediaType;
  serverId?: number | null;
  is4k?: boolean;
}

/** Servers of each kind, from settings. */
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

/** Whether a server matches the request's 4K tier. Lidarr has no 4K. */
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

/** The default server for this kind of request (4K or not). */
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
 * Why a server can't be chosen for a request, or nothing if it can. It must be
 * the request's kind and tier: 4K Radarr/Sonarr only for 4K requests and the
 * others never, so choosing a server can't bypass 4K permissions. With no
 * server of the kind at all, the id is meaningless and anything goes.
 */
export const chosenServerProblem = (
  request: RoutedRequest,
  settings: Settings = getSettings()
): 'unknown' | 'only4k' | 'not4k' | undefined => {
  const service = serviceFor(request.type);
  const chosen = chosenServer(request);
  if (!service || chosen === undefined) {
    return undefined;
  }
  const servers = serversFor(service, settings);
  if (!servers.length) {
    return undefined;
  }
  const server = servers.find((candidate) => candidate.id === chosen);
  if (!server) {
    return 'unknown';
  }
  if (sameTier(service, server, !!request.is4k)) {
    return undefined;
  }
  return request.is4k ? 'not4k' : 'only4k';
};

/** Messages shown when a chosen server is rejected. */
export const CHOSEN_SERVER_MESSAGES: Record<
  NonNullable<ReturnType<typeof chosenServerProblem>>,
  string
> = {
  unknown: 'That server no longer exists. Choose another.',
  only4k: 'That server takes only 4K requests. Choose another.',
  not4k: 'That server doesn’t take 4K requests. Choose a 4K server.',
};

/**
 * The request's chosen server, when valid for it: its kind, and 4K if the
 * request is (see chosenServerProblem).
 */
export const chosenServerFor = (
  request: RoutedRequest,
  settings: Settings = getSettings()
): DVRSettings | LidarrSettings | undefined => {
  const service = serviceFor(request.type);
  const chosen = chosenServer(request);
  return service && chosen !== undefined
    ? serversFor(service, settings).find(
        (server) =>
          server.id === chosen && sameTier(service, server, !!request.is4k)
      )
    : undefined;
};

/**
 * Why a request has no server, or nothing when it has one: the chosen one,
 * else its kind's default. Either must match its 4K tier, as when sent, so a
 * chosen server of the other tier counts as gone (only requests from before
 * that check can have one). Nothing when there is no server of its kind.
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

  if (chosen !== undefined && chosenServerFor(request, settings)) {
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
