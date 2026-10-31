import BazarrAPI from '@server/api/bazarr';
import {
  CLIENT_PRODUCTS,
  downloadClientFor,
} from '@server/api/downloadclients';
import JellyfinAPI from '@server/api/jellyfin';
import MaintainerrAPI from '@server/api/maintainerr';
import { musicBrainzQueue } from '@server/api/musicbrainz';
import PlexAPI from '@server/api/plexapi';
import ProwlarrAPI from '@server/api/prowlarr';
import type LidarrAPI from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TautulliAPI from '@server/api/tautulli';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  VIDEO_MEDIA_TYPES,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import AlbumRequest from '@server/entity/AlbumRequest';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import DownloadCheck from '@server/entity/DownloadCheck';
import { MatchProblem } from '@server/entity/MatchWatch';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import { aiFeatureOn } from '@server/lib/ai';
import { listModels } from '@server/lib/ai/providers';
import { getCollectionGaps } from '@server/lib/collectionGaps';
import { getMaintainerrStatus } from '@server/lib/deletingSoon';
import downloadCheck from '@server/lib/downloadCheck';
import { featureEnabled } from '@server/lib/features';
import type { HealthActivity } from '@server/lib/healthActivity';
import { healthActivity } from '@server/lib/healthActivity';
import {
  connectedServers,
  hostnameFor,
  isJellyfinFamily,
  jellyfinFamily,
} from '@server/lib/mediaServers';
import { lidarrApi, musicReady } from '@server/lib/music/access';
import { lidarrOnly } from '@server/lib/music/availability';
import type { PlexMatchProblem } from '@server/lib/plexMatchCheck';
import plexMatchCheck from '@server/lib/plexMatchCheck';
import { lastStates } from '@server/lib/quality/engine';
import { readTrashState } from '@server/lib/quality/trash';
import type { DownloadClientSettings } from '@server/lib/settings';
import { aiReady, getSettings } from '@server/lib/settings';
import type { ShownId } from '@server/utils/plexMatch';
import {
  comparedIds,
  fileLooksWrong,
  fileMisnamed,
  fixSearch,
  idLabel,
  sameName,
} from '@server/utils/plexMatch';
import { In, IsNull, LessThan, MoreThanOrEqual, Not } from 'typeorm';

/*
 * What the admin health page shows: whether each connected service answers,
 * and what has quietly gone wrong with requests, titles and users. Each check
 * says ok, warning or error, and lists up to ITEM_LIMIT of what it found.
 *
 * TMDB is deliberately not checked: its responses are cached, so a check
 * would report healthy from the cache during an outage.
 */

export type HealthStatus = 'ok' | 'warning' | 'error';

export interface HealthItem {
  title: string;
  detail?: string;
  href?: string;
  /** A title Radarr or Sonarr has, that can be searched for from here. */
  searchable?: { mediaId: number; is4k: boolean; mediaType: MediaType };
  /** When it was found, for a list that says. */
  at?: string;
}

export interface HealthCheck {
  id: string;
  group: 'services' | 'backfill' | 'requests' | 'media' | 'users';
  /**
   * For a service: it answered, so a problem is what it reported, not that
   * it is down.
   */
  reachable?: boolean;
  /** Service checks carry the server's own name; the rest are named by id. */
  name?: string;
  status: HealthStatus;
  count: number;
  detail?: string;
  items: HealthItem[];
  /**
   * Match Check: what the check of new requests found and is not yet put
   * right, newest first, shown above the nightly list.
   */
  recent?: HealthItem[];
  /** Of those, how many the nightly list does not have too. */
  recentCount?: number;
  /**
   * A service that answered, but some of what it reports (its own health
   * list, its disks) could not be read this time. What that would have
   * said is unknown, which is not the same as nothing being wrong.
   */
  partial?: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ITEM_LIMIT = 10;

/** Which slice of a check's list to return: the page shows ten at a time. */
interface Page {
  skip: number;
  take: number;
}
const FIRST_PAGE: Page = { skip: 0, take: ITEM_LIMIT };
/** Everything, for Search all, which needs every title but no names. */
const EVERYTHING: Page = { skip: 0, take: 100_000 };
/** Name lookups at once, so a long list does not flood TMDB. */
const LOOKUP_CONCURRENCY = 8;

/** Like Promise.all over a map, with at most `limit` running at once. */
const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
};
const SERVICE_TIMEOUT_MS = 8_000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No answer within ${ms / 1000} seconds`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/** Times one "are you up?" call. */
const serviceCheck = async (
  id: string,
  name: string,
  ping: () => Promise<unknown>
): Promise<HealthCheck> => {
  const started = Date.now();
  try {
    await withTimeout(ping(), SERVICE_TIMEOUT_MS);
    return {
      id,
      group: 'services',
      name,
      status: 'ok',
      count: 0,
      detail: `${Date.now() - started} ms`,
      items: [],
    };
  } catch (e) {
    return serviceDown(id, name, e);
  }
};

const GB = 1024 ** 3;
/** Free space below these shares of a disk is a warning, then a problem. */
const DISK_WARNING_SHARE = 0.1;
const DISK_ERROR_SHARE = 0.03;

/** A list a service sent, or nothing if it sent something else. */
const listOf = <T>(value: T[]): T[] => (Array.isArray(value) ? value : []);

const worst = (statuses: HealthStatus[]): HealthStatus =>
  statuses.includes('error')
    ? 'error'
    : statuses.includes('warning')
      ? 'warning'
      : 'ok';

const size = (bytes: number) =>
  bytes >= 1024 * GB
    ? `${(bytes / (1024 * GB)).toFixed(1)} TB`
    : `${Math.round(bytes / GB)} GB`;

/**
 * For the lookups a service that answered still makes: notes that one
 * failed or was too slow, and stands in for its answer with an empty list.
 */
const unreadTracker = () => {
  const state = { partial: false };
  return {
    state,
    missed: (): never[] => {
      state.partial = true;
      return [];
    },
  };
};

/** The check, marked partial when some of the service's report was missed. */
const withPartial = (
  check: HealthCheck,
  state: { partial: boolean }
): HealthCheck => (state.partial ? { ...check, partial: true } : check);

/** A reachable service with things of its own to report. */
const reported = (
  id: string,
  name: string,
  ms: number,
  found: { status: HealthStatus; item: HealthItem }[],
  summary?: string
): HealthCheck => ({
  id,
  group: 'services',
  name,
  reachable: true,
  status: worst(found.map((f) => f.status)),
  count: found.filter((f) => f.status !== 'ok').length,
  detail: [`${ms} ms`, summary].filter(Boolean).join(' · '),
  items: found.filter((f) => f.status !== 'ok').map((f) => f.item),
});

/**
 * Radarr, Sonarr or Lidarr: whether it answers, what its own health page says is
 * wrong (indexers or a download client it cannot reach, a missing root
 * folder, failed imports), and how full its disks are.
 */
const arrCheck = async (
  id: string,
  name: string,
  api: RadarrAPI | SonarrAPI | LidarrAPI
): Promise<HealthCheck> => {
  const started = Date.now();
  try {
    await withTimeout(api.getSystemStatus(), SERVICE_TIMEOUT_MS);
  } catch (e) {
    return serviceDown(id, name, e);
  }
  const ms = Date.now() - started;
  const unread = unreadTracker();
  const [issues, folders] = await Promise.all([
    withTimeout(api.getHealth(), SERVICE_TIMEOUT_MS)
      .then(listOf)
      .catch(unread.missed),
    withTimeout(api.getRootFolderSpace(), SERVICE_TIMEOUT_MS)
      .then(listOf)
      .catch(unread.missed),
  ]);
  const found: { status: HealthStatus; item: HealthItem }[] = [
    ...issues
      .filter((issue) => issue.type === 'warning' || issue.type === 'error')
      .map((issue) => ({
        status: issue.type as HealthStatus,
        item: { title: issue.message, detail: issue.source },
      })),
    ...folders.map((folder) => {
      const share = folder.totalSpace
        ? folder.freeSpace / folder.totalSpace
        : 1;
      return {
        status: (share < DISK_ERROR_SHARE
          ? 'error'
          : share < DISK_WARNING_SHARE
            ? 'warning'
            : 'ok') as HealthStatus,
        item: {
          title: `Low on space: ${folder.path}`,
          detail: `${size(folder.freeSpace)} free of ${size(folder.totalSpace)} (${Math.round(share * 100)}%)`,
        },
      };
    }),
  ];
  const leastFree = folders.length
    ? Math.min(...folders.map((f) => f.freeSpace))
    : undefined;
  return withPartial(
    reported(
      id,
      name,
      ms,
      found,
      leastFree !== undefined ? `${size(leastFree)} free` : undefined
    ),
    unread.state
  );
};

/** Prowlarr: answering, its own health page, and indexers it has paused. */
const prowlarrCheck = async (api: ProwlarrAPI): Promise<HealthCheck> => {
  const started = Date.now();
  try {
    await withTimeout(api.getVersion(), SERVICE_TIMEOUT_MS);
  } catch (e) {
    return serviceDown('prowlarr', 'Prowlarr', e);
  }
  const ms = Date.now() - started;
  const unread = unreadTracker();
  const [issues, failing] = await Promise.all([
    withTimeout(api.getHealth(), SERVICE_TIMEOUT_MS)
      .then(listOf)
      .catch(unread.missed),
    withTimeout(api.getFailingIndexers(), SERVICE_TIMEOUT_MS).catch(
      unread.missed
    ),
  ]);
  const now = Date.now();
  const found: { status: HealthStatus; item: HealthItem }[] = [
    ...failing
      // Prowlarr keeps a status for every indexer that ever failed; only
      // one still paused, or failing in the last day, matters.
      .filter(
        (indexer) =>
          (indexer.disabledTill &&
            new Date(indexer.disabledTill).getTime() > now) ||
          (indexer.failedAt &&
            now - new Date(indexer.failedAt).getTime() < DAY_MS)
      )
      .map((indexer) => ({
        status: 'warning' as HealthStatus,
        item: {
          title: indexer.name,
          detail: [
            indexer.failedAt ? `failed ${ago(new Date(indexer.failedAt))}` : '',
            indexer.disabledTill &&
            new Date(indexer.disabledTill).getTime() > now
              ? `paused for ${until(new Date(indexer.disabledTill))}`
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
        },
      })),
    ...issues
      .filter((issue) => issue.type === 'warning' || issue.type === 'error')
      // Each failing indexer is listed above already.
      .filter((issue) => !/^Indexer/i.test(issue.source) || !failing.length)
      .map((issue) => ({
        status: issue.type as HealthStatus,
        item: { title: issue.message, detail: issue.source },
      })),
  ];
  return withPartial(reported('prowlarr', 'Prowlarr', ms, found), unread.state);
};

/**
 * Bazarr: answering, what its own status page lists, and subtitle providers
 * it has paused after an error. A paused WhisperAI is why "Transcribe" can
 * do nothing for a while, which was otherwise only found by asking.
 */
const bazarrCheck = async (api: BazarrAPI): Promise<HealthCheck> => {
  const started = Date.now();
  try {
    await withTimeout(api.getVersion(), SERVICE_TIMEOUT_MS);
  } catch (e) {
    return serviceDown('bazarr', 'Bazarr', e);
  }
  const ms = Date.now() - started;
  const unread = unreadTracker();
  const [issues, providers] = await Promise.all([
    withTimeout(api.getHealth(), SERVICE_TIMEOUT_MS).catch(unread.missed),
    withTimeout(api.getProviderStatus(), SERVICE_TIMEOUT_MS).catch(
      unread.missed
    ),
  ]);
  const found: { status: HealthStatus; item: HealthItem }[] = [
    ...providers
      .filter((p) => p.status && p.status !== 'Good')
      .map((p) => ({
        status: 'warning' as HealthStatus,
        item: {
          title: `${p.name} is paused`,
          detail: [
            `after an error (${p.status})`,
            p.retry && p.retry !== '-' ? `tries again ${p.retry}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        },
      })),
    ...issues
      .filter((issue) => issue.issue)
      .map((issue) => ({
        status: 'warning' as HealthStatus,
        item: { title: issue.issue!, detail: issue.object },
      })),
  ];
  return withPartial(
    reported(
      'bazarr',
      'Bazarr',
      ms,
      found,
      `${providers.length} provider${providers.length === 1 ? '' : 's'}`
    ),
    unread.state
  );
};

/**
 * A download client: answering, which one and which version, and, for one
 * Backfill sends downloads to, what keeps Backfill from using it fully
 * (Deluge's Label plugin off, rTorrent refusing to delete files, an NZBGet
 * too old to add to).
 */
const downloadClientCheck = async (
  client: DownloadClientSettings
): Promise<HealthCheck> => {
  const id = `downloadClient:${client.id}`;
  const api = downloadClientFor(client);
  const started = Date.now();
  let version: string;
  try {
    version = await withTimeout(api.getVersion(), SERVICE_TIMEOUT_MS);
  } catch (e) {
    return serviceDown(id, client.name, e);
  }
  const ms = Date.now() - started;
  const { backfill } = getSettings();
  const backfillUses =
    backfill.enabled &&
    (client.id === backfill.torrentClientId ||
      client.id === backfill.usenetClientId);
  const problems = backfillUses
    ? await withTimeout(api.backfillProblems(), SERVICE_TIMEOUT_MS).catch(
        () => []
      )
    : [];
  return reported(
    id,
    client.name,
    ms,
    problems.map((problem) => ({
      status: 'warning' as HealthStatus,
      item: { title: problem, detail: 'Backfill', href: '/settings/backfill' },
    })),
    `${CLIENT_PRODUCTS[client.type]} ${String(version).replace(/^v/i, '')}`
  );
};

/**
 * The AI model: the key still works (listing models costs nothing), and
 * the account has not run out of credit.
 */
const aiCheck = async (): Promise<HealthCheck> => {
  const settings = getSettings();
  const started = Date.now();
  try {
    await withTimeout(listModels(settings.ai), SERVICE_TIMEOUT_MS);
  } catch (e) {
    return serviceDown('ai', 'AI', e);
  }
  const ms = Date.now() - started;
  const outAt = settings.aiCredit.outOfCreditAt;
  return reported(
    'ai',
    'AI',
    ms,
    outAt
      ? [
          {
            status: 'error',
            item: {
              title: 'The account is out of credit',
              detail: `since ${ago(new Date(outAt))}; AI features answer again once more is added`,
              href: '/settings/ai',
            },
          },
        ]
      : [],
    settings.ai.model
  );
};

/**
 * Postgres connections in use against its limit. Running out stops every
 * page and sign-in at once, so it is worth seeing coming.
 */
const databaseCheck = async (): Promise<HealthCheck> => {
  const started = Date.now();
  let used: number;
  let max: number;
  try {
    const [row] = await withTimeout(
      dataSource.query(
        "SELECT count(*)::int AS used, current_setting('max_connections')::int AS max FROM pg_stat_activity"
      ) as Promise<{ used: number; max: number }[]>,
      SERVICE_TIMEOUT_MS
    );
    used = Number(row.used);
    max = Number(row.max);
  } catch (e) {
    return serviceDown('database', 'Database', e);
  }
  const share = max ? used / max : 0;
  return reported(
    'database',
    'Database',
    Date.now() - started,
    [
      {
        status: share > 0.9 ? 'error' : share > 0.7 ? 'warning' : 'ok',
        item: {
          title: 'Close to its connection limit',
          detail: `${used} of ${max} connections in use`,
        },
      },
    ],
    `${used} of ${max} connections`
  );
};

/** How long until a time to come, in words. */
const until = (date: Date) => {
  const minutes = Math.max(
    1,
    Math.round((date.getTime() - Date.now()) / 60_000)
  );
  return minutes < 90
    ? `${minutes} more min`
    : `${Math.round(minutes / 60)} more hours`;
};

const serviceDown = (id: string, name: string, e: unknown): HealthCheck => ({
  id,
  group: 'services',
  name,
  status: 'error',
  count: 1,
  detail: e instanceof Error ? e.message : String(e),
  items: [],
});

/**
 * Jellyfin or Emby: answering, with its version, or why not in words. The
 * API key is what Seerr uses for scans and watch history, so it is the one
 * checked.
 */
export const mediaServerCheck = async (
  kind: 'jellyfin' | 'emby',
  api: Pick<JellyfinAPI, 'getSystemInfo'>
): Promise<HealthCheck> => {
  const name = kind === 'emby' ? 'Emby' : 'Jellyfin';
  const started = Date.now();
  try {
    const info = (await withTimeout(
      api.getSystemInfo(),
      SERVICE_TIMEOUT_MS
    )) as {
      Version?: string;
      ServerName?: string;
    };
    return {
      id: kind,
      group: 'services',
      name,
      status: 'ok',
      count: 0,
      detail: [
        info?.Version ? `${name} ${info.Version}` : undefined,
        `${Date.now() - started} ms`,
      ]
        .filter(Boolean)
        .join(' · '),
      items: [],
    };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    return {
      id: kind,
      group: 'services',
      name,
      status: 'error',
      count: 1,
      detail:
        status === 401 || status === 403
          ? `${name} did not accept the API key (Settings → ${name}).`
          : status === 502 || status === undefined
            ? `Could not reach ${name}${
                e instanceof Error && e.message ? ` (${e.message})` : ''
              }.`
            : `${name} answered with an error (${status}).`,
      items: [],
    };
  }
};

/** People told MusicBrainz was busy, in an hour, before it is worth a look. */
const MB_BUSY_WARNING = 5;
/** Failures in a row before MusicBrainz counts as not answering. */
const MB_DOWN_AFTER = 3;

/**
 * MusicBrainz, judged by how its shared line has fared over the last hour
 * rather than by a call of its own: it allows one request a second, and a
 * check would spend one. Over its limit, failing, or turning people away
 * as busy are each worth a look; failing every time is a problem.
 */
const musicBrainzCheck = (): HealthCheck => {
  const health = musicBrainzQueue.health();
  const base = { id: 'musicbrainz', group: 'services' as const };
  const name = 'MusicBrainz';

  if (health.failingInARow >= MB_DOWN_AFTER) {
    return {
      ...base,
      name,
      status: 'error',
      count: 1,
      detail: `The last ${health.failingInARow} requests failed${
        health.lastError ? `: ${health.lastError}` : ''
      }`,
      items: [],
    };
  }

  const items: HealthItem[] = [];
  if (health.rateLimited > 0) {
    items.push({
      title: `Over its limit ${health.rateLimited} ${
        health.rateLimited === 1 ? 'time' : 'times'
      } in the last hour`,
      detail:
        'MusicBrainz allows one request a second from each address. A MusicBrainz mirror (Settings → Music) has no limit.',
    });
  }
  if (health.failed > 0) {
    items.push({
      title: `${health.failed} ${
        health.failed === 1 ? 'request' : 'requests'
      } failed in the last hour`,
      detail: health.lastError,
    });
  }
  if (health.busy >= MB_BUSY_WARNING) {
    items.push({
      title: `People were told it was busy ${health.busy} times in the last hour`,
      detail:
        'Pages ask again rather than wait; scans of a large library fill the line for a while.',
    });
  }

  return {
    ...base,
    name,
    reachable: true,
    status: items.length ? 'warning' : 'ok',
    count: items.length,
    detail: health.waiting
      ? `${health.waiting} waiting in line`
      : health.lastSuccessAt
        ? `Answering · last ${ago(new Date(health.lastSuccessAt))}`
        : 'Nothing asked yet',
    items,
  };
};

export const serviceChecks = async (): Promise<HealthCheck[]> => {
  const settings = getSettings();
  const pending: Promise<HealthCheck>[] = [];

  const mediaServers = connectedServers();

  if (mediaServers.includes('plex') && settings.plex.ip) {
    pending.push(
      serviceCheck('plex', 'Plex', async () => {
        const admin = await getRepository(User).findOne({
          select: { id: true, plexToken: true },
          where: { id: 1 },
        });
        return new PlexAPI({
          plexToken: admin?.plexToken,
          plexSettings: settings.plex,
          timeout: SERVICE_TIMEOUT_MS,
        }).getStatus();
      })
    );
  }

  for (const kind of mediaServers.filter(isJellyfinFamily)) {
    const { ip, apiKey } = jellyfinFamily(kind);
    if (ip && apiKey) {
      pending.push(
        mediaServerCheck(
          kind,
          new JellyfinAPI(hostnameFor(kind), apiKey, undefined, kind)
        )
      );
    }
  }

  for (const radarr of settings.radarr) {
    pending.push(
      arrCheck(
        `radarr:${radarr.id}`,
        radarr.name,
        new RadarrAPI({
          apiKey: radarr.apiKey,
          url: RadarrAPI.buildUrl(radarr, '/api/v3'),
        })
      )
    );
  }

  for (const sonarr of settings.sonarr) {
    pending.push(
      arrCheck(
        `sonarr:${sonarr.id}`,
        sonarr.name,
        new SonarrAPI({
          apiKey: sonarr.apiKey,
          url: SonarrAPI.buildUrl(sonarr, '/api/v3'),
        })
      )
    );
  }

  // Music's Lidarr, unless music is turned off for everyone.
  if (featureEnabled('music')) {
    for (const lidarr of settings.lidarr) {
      pending.push(
        arrCheck(`lidarr:${lidarr.id}`, lidarr.name, lidarrApi(lidarr))
      );
    }
    if (musicReady()) {
      pending.push(Promise.resolve(musicBrainzCheck()));
    }
  }

  const { prowlarr } = settings.backfill;
  if (prowlarr.hostname && prowlarr.apiKey) {
    pending.push(prowlarrCheck(new ProwlarrAPI(prowlarr)));
  }

  for (const client of settings.downloadClients) {
    pending.push(downloadClientCheck(client));
  }

  if (settings.bazarr.hostname && settings.bazarr.apiKey) {
    pending.push(bazarrCheck(new BazarrAPI(settings.bazarr)));
  }

  if (aiReady(settings.ai)) {
    pending.push(aiCheck());
  }

  if (dataSource.options.type === 'postgres') {
    pending.push(databaseCheck());
  }

  if (settings.tautulli.hostname) {
    pending.push(
      serviceCheck('tautulli', 'Tautulli', () =>
        new TautulliAPI(settings.tautulli).getInfo()
      )
    );
  }

  const scheduleErrors = new Map(
    getMaintainerrStatus().map((status) => [status.id, status.lastError])
  );
  for (const server of settings.maintainerr) {
    pending.push(
      serviceCheck(`maintainerr:${server.id}`, server.name, async () => {
        await new MaintainerrAPI(server).getVersion();
        // Answering is not enough if reading its schedule keeps failing.
        const lastError = scheduleErrors.get(server.id);
        if (lastError) {
          throw new Error(`Answers, but its schedule: ${lastError.message}`);
        }
      })
    );
  }

  return Promise.all(pending);
};

/** Names for titles, so items read as names rather than ids. */
const titleOf = async (media: Pick<Media, 'tmdbId' | 'mediaType'>) => {
  try {
    const tmdb = new TheMovieDb();
    const found =
      media.mediaType === MediaType.MOVIE
        ? (await withTimeout(tmdb.getMovie({ movieId: media.tmdbId }), 5_000))
            .title
        : (await withTimeout(tmdb.getTvShow({ tvId: media.tmdbId }), 5_000))
            .name;
    return found || `TMDB ${media.tmdbId}`;
  } catch {
    return `TMDB ${media?.tmdbId}`;
  }
};

const mediaHref = (media: Pick<Media, 'tmdbId' | 'mediaType'>) =>
  `/${media.mediaType === MediaType.MOVIE ? 'movie' : 'tv'}/${media.tmdbId}`;

const ago = (date: Date) => {
  const days = Math.floor((Date.now() - new Date(date).getTime()) / DAY_MS);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`;
  const hours = Math.floor((Date.now() - new Date(date).getTime()) / HOUR_MS);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
};

const fromRequests = async (
  id: string,
  status: HealthStatus,
  [requests, count]: [MediaRequest[], number],
  detail: (request: MediaRequest) => string
): Promise<HealthCheck> => ({
  id,
  group: 'requests',
  status: count > 0 ? status : 'ok',
  count,
  items: await mapLimit(requests, LOOKUP_CONCURRENCY, async (request) =>
    // A request can outlive its title's link — leftovers of the old
    // duplicate-request bug, for one. Listed as what it is, rather than
    // taking the page down.
    request.media
      ? {
          title: await titleOf(request.media),
          detail: detail(request),
          href: mediaHref(request.media),
        }
      : {
          title: `Request #${request.id}`,
          detail: [detail(request), 'no longer linked to a title']
            .filter(Boolean)
            .join(' · '),
        }
  ),
});

const fromMedia = async (
  id: string,
  status: HealthStatus,
  [media, count]: [Media[], number],
  detail: (media: Media) => string
): Promise<HealthCheck> => ({
  id,
  group: 'media',
  status: count > 0 ? status : 'ok',
  count,
  items: await mapLimit(media, LOOKUP_CONCURRENCY, async (item) => ({
    title: await titleOf(item),
    detail: detail(item),
    href: mediaHref(item),
  })),
});

/** Radarr or Sonarr refused it, or it could not be sent at all. */
const failedRequests = (page: Page): Promise<HealthCheck> =>
  getRepository(MediaRequest)
    .findAndCount({
      where: {
        status: MediaRequestStatus.FAILED,
        type: In(VIDEO_MEDIA_TYPES),
        media: { id: Not(IsNull()) },
      },
      relations: { media: true, requestedBy: true },
      order: { updatedAt: 'DESC' },
      skip: page.skip,
      take: page.take,
    })
    .then((found) =>
      fromRequests('failedRequests', 'error', found, (r) =>
        [r.requestedBy?.displayName, ago(r.updatedAt)]
          .filter(Boolean)
          .join(' · ')
      )
    );

/**
 * Approved over an hour ago, yet Radarr or Sonarr never gave the title an
 * id: the request did not reach them. (Approval marks the title Processing
 * straight away, so its status cannot tell; the id is only stored once it
 * has actually been added.)
 */
const neverSent = (page: Page): Promise<HealthCheck> => {
  const hourAgo = new Date(Date.now() - HOUR_MS);
  return getRepository(MediaRequest)
    .findAndCount({
      where: [
        {
          status: MediaRequestStatus.APPROVED,
          type: In(VIDEO_MEDIA_TYPES),
          is4k: false,
          updatedAt: LessThan(hourAgo),
          media: { id: Not(IsNull()), externalServiceId: IsNull() },
        },
        {
          status: MediaRequestStatus.APPROVED,
          type: In(VIDEO_MEDIA_TYPES),
          is4k: true,
          updatedAt: LessThan(hourAgo),
          media: { id: Not(IsNull()), externalServiceId4k: IsNull() },
        },
      ],
      relations: { media: true, requestedBy: true },
      order: { updatedAt: 'ASC' },
      skip: page.skip,
      take: page.take,
    })
    .then((found) =>
      fromRequests('neverSent', 'error', found, (r) =>
        [r.requestedBy?.displayName, `approved ${ago(r.updatedAt)}`]
          .filter(Boolean)
          .join(' · ')
      )
    );
};

const awaitingApproval = (page: Page): Promise<HealthCheck> =>
  getRepository(MediaRequest)
    .findAndCount({
      where: {
        status: MediaRequestStatus.PENDING,
        type: In(VIDEO_MEDIA_TYPES),
        createdAt: LessThan(new Date(Date.now() - 7 * DAY_MS)),
      },
      relations: { media: true, requestedBy: true },
      order: { createdAt: 'ASC' },
      skip: page.skip,
      take: page.take,
    })
    .then((found) =>
      fromRequests('awaitingApproval', 'warning', found, (r) =>
        [r.requestedBy?.displayName, `requested ${ago(r.createdAt)}`]
          .filter(Boolean)
          .join(' · ')
      )
    );

/**
 * Requests whose title link is gone. They cannot be sent, shown or
 * fulfilled; listed on their own rather than mixed into the checks above,
 * where they looked like failed or unsent requests.
 */
const unlinkedRequests = (page: Page): Promise<HealthCheck> =>
  getRepository(MediaRequest)
    .createQueryBuilder('request')
    .leftJoinAndSelect('request.requestedBy', 'requestedBy')
    .where('request.mediaId IS NULL')
    .orderBy('request.createdAt', 'DESC')
    .skip(page.skip)
    .take(page.take)
    .getManyAndCount()
    .then(([found, count]) => ({
      id: 'unlinkedRequests',
      group: 'requests' as const,
      status: (count > 0 ? 'warning' : 'ok') as HealthStatus,
      count,
      items: found.map((r) => ({
        title: `Request #${r.id}`,
        detail: [
          r.requestedBy?.displayName,
          STATUS_NAMES[r.status],
          `made ${ago(r.createdAt)}`,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    }));

const requestChecks = (page: Page = FIRST_PAGE): Promise<HealthCheck[]> =>
  Promise.all([
    failedRequests(page),
    neverSent(page),
    awaitingApproval(page),
    unlinkedRequests(page),
  ]);

const STATUS_NAMES: Record<number, string> = {
  [MediaRequestStatus.PENDING]: 'pending',
  [MediaRequestStatus.APPROVED]: 'approved',
  [MediaRequestStatus.DECLINED]: 'declined',
  [MediaRequestStatus.FAILED]: 'failed',
  [MediaRequestStatus.COMPLETED]: 'completed',
};

/*
 * "Processing for over a week", counting only titles that should have
 * arrived by now. Seerr keeps a requested title Processing until it is out,
 * so on its own this flagged every unreleased film and every series waiting
 * on its next episode. Radarr and Sonarr know better than a release date:
 * Radarr says whether a film has reached the minimum availability set for
 * it — cinemas, digital or physical — and Sonarr counts monitored episodes
 * that have aired against the files it has.
 *
 * A title Radarr or Sonarr cannot be asked about stays listed, saying so,
 * rather than quietly dropping out.
 */
type Verdict = { stuck: boolean; why: string; searchable?: boolean };

const stuckProcessing = async (
  weekAgo: Date,
  page: Page = FIRST_PAGE,
  lookupTitles = true
): Promise<HealthCheck> => {
  const settings = getSettings();
  const candidates = await getRepository(Media).find({
    where: [
      {
        mediaType: In(VIDEO_MEDIA_TYPES),
        status: MediaStatus.PROCESSING,
        updatedAt: LessThan(weekAgo),
      },
      {
        mediaType: In(VIDEO_MEDIA_TYPES),
        status4k: MediaStatus.PROCESSING,
        updatedAt: LessThan(weekAgo),
      },
    ],
    order: { updatedAt: 'ASC' },
  });

  // Each server's catalogue, fetched once and only if needed.
  const catalogues = new Map<string, Promise<Map<number, unknown> | null>>();
  const catalogue = (kind: 'radarr' | 'sonarr', serverId: number) => {
    const key = `${kind}:${serverId}`;
    if (!catalogues.has(key)) {
      catalogues.set(
        key,
        (async () => {
          try {
            if (kind === 'radarr') {
              const server = settings.radarr.find((r) => r.id === serverId);
              if (!server) return null;
              const movies = await withTimeout(
                new RadarrAPI({
                  apiKey: server.apiKey,
                  url: RadarrAPI.buildUrl(server, '/api/v3'),
                }).getMovies(),
                SERVICE_TIMEOUT_MS * 2
              );
              return new Map(
                movies
                  .filter((m) => m.id != null)
                  .map((m) => [m.id as number, m as unknown])
              );
            }
            const server = settings.sonarr.find((s) => s.id === serverId);
            if (!server) return null;
            const series = await withTimeout(
              new SonarrAPI({
                apiKey: server.apiKey,
                url: SonarrAPI.buildUrl(server, '/api/v3'),
              }).getSeries(),
              SERVICE_TIMEOUT_MS * 2
            );
            return new Map(
              series
                .filter((s) => s.id != null)
                .map((s) => [s.id as number, s as unknown])
            );
          } catch {
            return null;
          }
        })()
      );
    }
    return catalogues.get(key)!;
  };

  const judge = async (media: Media, is4k: boolean): Promise<Verdict> => {
    const serverId = is4k ? media.serviceId4k : media.serviceId;
    const externalId = is4k
      ? media.externalServiceId4k
      : media.externalServiceId;
    const service = media.mediaType === MediaType.MOVIE ? 'Radarr' : 'Sonarr';

    if (serverId == null || externalId == null) {
      return { stuck: true, why: `Not linked to ${service}` };
    }

    const found = await catalogue(
      media.mediaType === MediaType.MOVIE ? 'radarr' : 'sonarr',
      serverId
    );
    if (!found) {
      return { stuck: true, why: `Could not check ${service}` };
    }

    const item = found.get(externalId) as
      | {
          isAvailable?: boolean;
          hasFile?: boolean;
          statistics?: { episodeCount: number; episodeFileCount: number };
        }
      | undefined;
    if (!item) {
      return { stuck: true, why: `No longer in ${service}` };
    }

    if (media.mediaType === MediaType.MOVIE) {
      return item.isAvailable && !item.hasFile
        ? { stuck: true, why: 'Released, not downloaded', searchable: true }
        : { stuck: false, why: 'Not released yet' };
    }

    const missing =
      (item.statistics?.episodeCount ?? 0) -
      (item.statistics?.episodeFileCount ?? 0);
    return missing > 0
      ? {
          stuck: true,
          why: `${missing} aired ${missing === 1 ? 'episode' : 'episodes'} missing`,
          searchable: true,
        }
      : { stuck: false, why: 'Waiting for new episodes' };
  };

  const stuck: { media: Media; verdict: Verdict; is4k: boolean }[] = [];
  for (const media of candidates) {
    const flags = [false, true].filter((is4k) =>
      is4k
        ? media.status4k === MediaStatus.PROCESSING
        : media.status === MediaStatus.PROCESSING
    );
    const verdicts = await Promise.all(
      flags.map(async (is4k) => ({ is4k, verdict: await judge(media, is4k) }))
    );
    const bad = verdicts.find((v) => v.verdict.stuck);
    if (bad) {
      stuck.push({ media, verdict: bad.verdict, is4k: bad.is4k });
    }
  }

  return {
    id: 'stuckProcessing',
    group: 'media',
    status: stuck.length > 0 ? 'warning' : 'ok',
    count: stuck.length,
    items: await mapLimit(
      stuck.slice(page.skip, page.skip + page.take),
      LOOKUP_CONCURRENCY,
      async ({ media, verdict, is4k }) => ({
        title: lookupTitles ? await titleOf(media) : `TMDB ${media.tmdbId}`,
        detail: `${verdict.why} · last changed ${ago(media.updatedAt)}`,
        href: mediaHref(media),
        searchable: verdict.searchable
          ? { mediaId: media.id, is4k, mediaType: media.mediaType }
          : undefined,
      })
    ),
  };
};

/*
 * Music, judged apart from films and series (stuckProcessing is theirs):
 * an album is on its way from being approved, and is stuck in one of two
 * ways. Lidarr has its files but no media server lists it a day later
 * (the music library is off, or not scanned, or the album is filed where
 * the server does not look). Or Lidarr has found no release for it a week
 * after it was approved, which a search may fix.
 */

/** "Sing to the Ferryman — Glasswing", or the album alone. */
const albumTitle = (title: string, artist?: string | null) =>
  artist ? `${title} — ${artist}` : title;

const musicNotOnServer = async (page: Page): Promise<HealthCheck> => {
  if (lidarrOnly()) {
    // Lidarr's files decide on their own: such an album is already here.
    return {
      id: 'musicNotOnServer',
      group: 'media',
      status: 'ok',
      count: 0,
      items: [],
    };
  }
  const [rows, count] = await getRepository(MusicAlbum)
    .createQueryBuilder('album')
    .innerJoinAndSelect('album.media', 'media')
    .where('album.status = :processing', {
      processing: MediaStatus.PROCESSING,
    })
    .andWhere('album.trackFileCount > 0')
    .andWhere('album.updatedAt < :dayAgo', {
      dayAgo: new Date(Date.now() - DAY_MS),
    })
    .orderBy('album.updatedAt', 'ASC')
    .skip(page.skip)
    .take(page.take)
    .getManyAndCount();

  return {
    id: 'musicNotOnServer',
    group: 'media',
    status: count > 0 ? 'warning' : 'ok',
    count,
    items: rows.map((row) => ({
      title: albumTitle(row.title, row.media?.foreignTitle),
      detail: [
        `${row.trackFileCount} of ${row.trackCount ?? '?'} tracks in Lidarr`,
        `last changed ${ago(row.updatedAt)}`,
        'Is a music library switched on for it, and scanned?',
      ].join(' · '),
      href: row.mbId ? `/music/album/${row.mbId}` : undefined,
    })),
  };
};

interface WaitingAlbum {
  mediaId: number | string;
  foreignId: string;
  artist: string | null;
  linked: number | string | boolean | null;
  title: string;
  lidarrAlbumId: number | string | null;
  releaseDate: string | null;
  requestId: number | string;
}

const musicNoRelease = async (page: Page): Promise<HealthCheck> => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await getRepository(AlbumRequest)
    .createQueryBuilder('wanted')
    .innerJoin('wanted.request', 'request')
    .innerJoin('request.media', 'media')
    .innerJoin(
      MusicAlbum,
      'row',
      'row.mediaId = media.id AND row.mbId = wanted.albumMbid'
    )
    .select('media.id', 'mediaId')
    .addSelect('media.foreignId', 'foreignId')
    .addSelect('media.foreignTitle', 'artist')
    .addSelect('media.externalServiceId', 'linked')
    .addSelect('row.title', 'title')
    .addSelect('row.lidarrAlbumId', 'lidarrAlbumId')
    .addSelect('row.releaseDate', 'releaseDate')
    .addSelect('request.id', 'requestId')
    .where('request.type = :music', { music: MediaType.MUSIC })
    .andWhere('request.status = :approved', {
      approved: MediaRequestStatus.APPROVED,
    })
    .andWhere('wanted.status = :approved', {
      approved: MediaRequestStatus.APPROVED,
    })
    .andWhere('request.updatedAt < :weekAgo', {
      weekAgo: new Date(Date.now() - 7 * DAY_MS),
    })
    .andWhere('row.status = :processing', {
      processing: MediaStatus.PROCESSING,
    })
    .andWhere('(row.trackFileCount IS NULL OR row.trackFileCount = 0)')
    .orderBy('request.updatedAt', 'ASC')
    .getRawMany<WaitingAlbum>();

  // An album not out yet has nothing to find. MusicBrainz's dates can be
  // just a year, or a year and month: those count from their start.
  const due = rows.filter(
    (row) => !row.releaseDate || row.releaseDate.slice(0, 10) <= today
  );

  // When each was approved, read through the entity: a raw date from
  // SQLite would be taken for local time.
  const approvedAt = new Map(
    (
      await getRepository(MediaRequest).find({
        select: { id: true, updatedAt: true },
        where: {
          id: In([...new Set(due.map((row) => Number(row.requestId)))]),
        },
      })
    ).map((request) => [request.id, request.updatedAt])
  );

  const byArtist = new Map<number, WaitingAlbum[]>();
  for (const row of due) {
    const id = Number(row.mediaId);
    byArtist.set(id, [...(byArtist.get(id) ?? []), row]);
  }
  const artists = [...byArtist.entries()];

  return {
    id: 'musicNoRelease',
    group: 'media',
    status: artists.length > 0 ? 'warning' : 'ok',
    count: artists.length,
    items: artists
      .slice(page.skip, page.skip + page.take)
      .map(([mediaId, albums]) => {
        const titles = [...new Set(albums.map((a) => a.title))];
        const first = albums[0];
        return {
          title:
            titles.length === 1
              ? albumTitle(titles[0], first.artist)
              : `${first.artist ?? 'An artist'} — ${titles.length} albums`,
          detail: [
            titles.length > 1 ? titles.join(', ') : undefined,
            `approved ${ago(
              approvedAt.get(Number(first.requestId)) ?? new Date()
            )}`,
          ]
            .filter(Boolean)
            .join(' · '),
          href: `/music/artist/${first.foreignId}`,
          searchable:
            first.linked != null &&
            albums.some((album) => album.lidarrAlbumId != null)
              ? { mediaId, is4k: false, mediaType: MediaType.MUSIC }
              : undefined,
        };
      }),
  };
};

/** Whether music is set up and on for everyone, for its checks. */
const musicOn = () => featureEnabled('music') && musicReady();

/** The music checks, while music is on. */
const musicChecks = (page: Page): Promise<HealthCheck>[] =>
  musicOn() ? [musicNotOnServer(page), musicNoRelease(page)] : [];

/** Sonarr needs a TVDB id; without one a series request cannot be sent. */
const missingTvdb = (page: Page): Promise<HealthCheck> =>
  getRepository(Media)
    .findAndCount({
      where: {
        mediaType: MediaType.TV,
        tvdbId: IsNull(),
        requests: { id: Not(IsNull()) },
      },
      order: { updatedAt: 'DESC' },
      skip: page.skip,
      take: page.take,
    })
    .then((found) =>
      fromMedia(
        'missingTvdb',
        'warning',
        found,
        () => 'Sonarr cannot add it without one'
      )
    );

const WEEK_MS = 7 * DAY_MS;

const mediaChecks = (page: Page = FIRST_PAGE): Promise<HealthCheck[]> =>
  Promise.all([
    stuckProcessing(new Date(Date.now() - WEEK_MS), page),
    ...musicChecks(page),
    missingTvdb(page),
    Promise.resolve(collectionGapsCheck(page)),
    plexMatchesCheck(page),
  ]);

const titled = (t: { title: string; year?: number }) =>
  t.year ? `${t.title} (${t.year})` : t.title;

/**
 * How to fix a match on this server: Plex's "Fix Match" finds a title by
 * its id typed as "tmdb-123" (or "imdb-tt123"); Jellyfin's and Emby's
 * "Identify" has a box for each id. `also` is a second id to try.
 */
export const fixMatchText = (
  server: string,
  want?: ShownId,
  also?: ShownId
): string => {
  const typed = (id: ShownId) => `${id.name}-${id.id}`;
  const entered = (id: ShownId) =>
    `${id.name === 'imdb' ? 'IMDb' : id.name.toUpperCase()} id ${id.id}`;
  if (server === 'Plex') {
    return want
      ? `Fix Match in Plex, searching ${typed(want)}${also ? ` or ${typed(also)}` : ''}`
      : 'Fix Match in Plex';
  }
  return want
    ? `Identify in ${server}, entering ${entered(want)}${also ? ` or ${entered(also)}` : ''}`
    : `Identify in ${server}`;
};

/** An album and who it is by. */
const albumBy = (t: { title: string; year?: number; artist?: string }) =>
  `${titled(t)}${t.artist ? ` by ${t.artist}` : ''}`;

/** A music problem in words: albums go by MusicBrainz ids, not TMDB's. */
const musicMatchText = (
  p: PlexMatchProblem
): { title: string; detail: string } => {
  const server = p.mediaServer ?? 'Plex';
  const { mbid } = p.expected;
  const fix =
    server === 'Plex'
      ? `Fix Match in Plex and pick ${albumBy(p.expected)}`
      : mbid
        ? `Identify in ${server}, entering MusicBrainz release group ${mbid}`
        : `Identify in ${server}`;
  return {
    title: `${server} matched the album "${p.folder}" to ${albumBy(p.matched)}`,
    detail: `${p.expected.server} has ${albumBy(p.expected)} there${mbid ? ` (MusicBrainz ${mbid})` : ''} · ${fix}`,
  };
};

/**
 * One Match Check problem in words. The ids are shown because names can't
 * tell two films apart: two can share a name and a year. They are the ids
 * the two sides were compared by, so a server with only an IMDb id shows
 * it. For a film, the file's length against the film's says whose mistake
 * it is: a file far off the film is likely another film, which fixing the
 * match would only hide.
 */
export const plexMatchText = (
  p: PlexMatchProblem
): { title: string; detail: string } => {
  if (p.kind === 'music') return musicMatchText(p);
  const server = p.mediaServer ?? 'Plex';
  const arr = p.expected.server;
  const { want, got } = comparedIds(p.kind, p.expected, p.matched);
  const search = fixSearch(p.kind, p.expected);
  const fix = fixMatchText(
    server,
    search.want,
    want?.name === 'imdb' ? search.also : undefined
  );
  const ids = [
    want && `${arr}: ${idLabel(want)}`,
    got && `${server}: ${idLabel(got)}`,
  ]
    .filter(Boolean)
    .join(', ');
  const film = p.kind === 'movie' && p.reason !== 'differentId';
  const lengths =
    p.kind === 'movie' && p.expected.fileRuntime && p.expected.runtime
      ? `file ${p.expected.fileRuntime} min, film ${p.expected.runtime} min`
      : '';
  const rename =
    film && fileMisnamed(p.expected)
      ? `rename the file in ${arr} (it is named "${p.expected.file}") so ${server} does not match it wrongly again`
      : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');

  if (film && fileLooksWrong(p.expected)) {
    return {
      title: `${arr}'s file in "${p.folder}" may not be ${titled(p.expected)}`,
      detail: join(
        p.reason === 'unmatched'
          ? `${server} has not matched it`
          : `${server} matched it to ${titled(p.matched)}${ids ? ` (${ids})` : ''}`,
        lengths,
        `Replace it in ${arr} (search for a correct release) rather than fixing the match`
      ),
    };
  }
  if (p.reason === 'unmatched') {
    return {
      title: `${server} has not matched "${p.folder}"`,
      detail: join(
        `${arr} has ${titled(p.expected)} there`,
        lengths,
        fix,
        rename
      ),
    };
  }
  if (p.reason === 'differentId') {
    return {
      title: `${server} and ${arr} use different entries for ${titled(p.expected)}`,
      detail: `The same title by ${p.matched.imdbId && p.matched.imdbId === p.expected.imdbId ? `IMDb (${p.matched.imdbId})` : 'another id'}, but ${ids}, so Seerr's ${server} scan marks ${server}'s entry as in the library rather than the one requested · ${fix}; if ${server} finds nothing, ${arr}'s entry may be the outdated one`,
    };
  }
  return {
    title: sameName(p.matched, p.expected)
      ? `${server} matched "${p.folder}" to a different ${p.kind === 'movie' ? 'film' : 'series'} named ${titled(p.matched)}`
      : `${server} matched "${p.folder}" to ${titled(p.matched)}`,
    detail: join(
      `${arr} has ${titled(p.expected)} there${ids ? ` (${ids})` : ''}`,
      lengths,
      fix,
      rename
    ),
  };
};

/**
 * Folders the media server matched to another title than Sonarr or Radarr
 * has in them, from the nightly Match Check. Each opens the title Sonarr or Radarr
 * has, whose page says the same.
 */
const plexMatchesCheck = async (page: Page): Promise<HealthCheck> => {
  const report = await plexMatchCheck.lastReport();
  const items = report.problems.slice(page.skip, page.skip + page.take);
  const recent = await getRepository(MatchProblem).find({
    where: { resolvedAt: IsNull() },
    order: { foundAt: 'DESC' },
  });
  const recentMedia = new Map(
    (
      await getRepository(Media).find({
        select: { id: true, tmdbId: true, mediaType: true, foreignId: true },
        where: {
          id: In(recent.flatMap((r) => (r.mediaId ? [r.mediaId] : []))),
        },
      })
    ).map((m) => [m.id, m])
  );
  // The nightly list may have the same problem: counted once.
  const nightly = new Set(
    report.problems.map(
      (p) => `${p.mediaServer ?? 'Plex'}|${p.folder.toLowerCase()}`
    )
  );
  const newOnes = recent.filter((row) => {
    const p = JSON.parse(row.problem) as PlexMatchProblem;
    return !nightly.has(`${row.mediaServer}|${p.folder.toLowerCase()}`);
  }).length;
  // Sonarr may not know a series' TMDB id; Seerr's own row for it does.
  const byTvdb = new Map(
    (
      await getRepository(Media).find({
        select: { tvdbId: true, tmdbId: true },
        where: {
          mediaType: MediaType.TV,
          tvdbId: In(
            items.flatMap((p) =>
              !p.expected.tmdbId && p.expected.tvdbId ? [p.expected.tvdbId] : []
            )
          ),
        },
      })
    ).map((m) => [m.tvdbId, m.tmdbId])
  );
  return {
    id: 'plexMatches',
    group: 'media',
    status: report.error
      ? 'warning'
      : report.problems.length || recent.length
        ? 'warning'
        : 'ok',
    count: report.problems.length,
    recentCount: newOnes,
    recent: recent.slice(0, ITEM_LIMIT).map((row) => {
      const p = JSON.parse(row.problem) as PlexMatchProblem;
      const media = row.mediaId ? recentMedia.get(row.mediaId) : undefined;
      return {
        ...plexMatchText(p),
        at: row.foundAt.toISOString(),
        href:
          p.kind === 'music'
            ? p.expected.mbid
              ? `/music/album/${p.expected.mbid}`
              : undefined
            : media
              ? `/${media.mediaType}/${media.tmdbId}`
              : undefined,
      };
    }),
    detail: report.error
      ? `The last check could not finish: ${report.error}`
      : report.finishedAt
        ? [
            `${report.checked} checked ${ago(new Date(report.finishedAt))}`,
            report.notChecked
              ? `${report.notChecked} could not be compared (no folder, or no id both sides have)`
              : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : 'Runs nightly (Settings → Jobs → Match Check)',
    items: items.map((p) => ({
      ...plexMatchText(p),
      href: (() => {
        const tmdbId =
          p.expected.tmdbId ??
          (p.expected.tvdbId ? byTvdb.get(p.expected.tvdbId) : undefined);
        return tmdbId
          ? `/${p.kind === 'movie' ? 'movie' : 'tv'}/${tmdbId}`
          : undefined;
      })(),
    })),
  };
};

/**
 * Collections the library has part of. Not a problem, so never a warning:
 * listed for finishing a series of films off. The list is built in the
 * background; until the first one is ready, the row says so.
 */
const collectionGapsCheck = (page: Page): HealthCheck => {
  const gaps = getCollectionGaps();
  if (!gaps) {
    return {
      id: 'collectionGaps',
      group: 'media',
      name: 'Collections partly in your library — checking your library, look again shortly',
      status: 'ok',
      count: 0,
      items: [],
    };
  }
  return {
    id: 'collectionGaps',
    group: 'media',
    status: 'ok',
    count: gaps.length,
    items: gaps.slice(page.skip, page.skip + page.take).map((gap) => ({
      title: gap.name,
      detail: [
        `${gap.inLibrary} of ${gap.total} in your library`,
        gap.requested ? `${gap.requested} requested` : undefined,
        `${gap.missing} missing`,
      ]
        .filter(Boolean)
        .join(' · '),
      href: `/collection/${gap.id}`,
    })),
  };
};

/**
 * Backfill: titles it could not search, packs waiting on an admin, and
 * downloads that failed this week; Download Check's findings and the admin
 * agent's conversations waiting on an admin, while each is on. Only when
 * Backfill is on.
 */
/**
 * Seerr AI's quality profiles (Settings → Quality), on servers an admin
 * manages: one someone changed or removed in Radarr or Sonarr, a TRaSH
 * Guides update that changes a format an admin moved (the admin's choice
 * stays), a server that couldn't be checked, and TRaSH Guides not reached
 * for 3 days. From the last hourly check.
 */
const qualityChecks = async (): Promise<HealthCheck[]> => {
  const managed = getSettings().quality.servers.filter((s) => s.managed);
  if (!managed.length) return [];
  const href = '/settings/quality';
  const items: HealthItem[] = [];
  // Only servers still managed: one that was stopped or removed keeps its
  // last state.
  const keys = new Set(managed.map((s) => `${s.kind}:${s.serverId}`));
  const states = lastStates().filter((s) =>
    keys.has(`${s.kind}:${s.serverId}`)
  );
  for (const state of states) {
    const app = state.kind === 'radarr' ? 'Radarr' : 'Sonarr';
    for (const change of state.changed) {
      items.push({
        title: `${state.name}: ${change.name}`,
        detail: change.removed ? `removed in ${app}` : `changed in ${app}`,
        href,
      });
    }
    for (const name of state.clashes) {
      items.push({
        title: `${state.name}: ${name}`,
        detail: 'TRaSH Guides changed its score; your choice stays',
        href,
      });
    }
    if (state.status === 'unreachable') {
      items.push({
        title: state.name,
        detail: 'could not be reached to check its quality profiles',
        href,
      });
    }
  }
  if (managed.some((s) => Object.values(s.presets).includes('trash'))) {
    const trash = await readTrashState();
    const lastGood = Date.parse(trash.checkedAt ?? '') || 0;
    if (trash.failedAt && Date.now() - lastGood > 3 * DAY_MS) {
      items.push({
        title: 'TRaSH Guides',
        detail: `not reached for 3 days${trash.error ? `: ${trash.error}` : ''}`,
        href,
      });
    }
  }
  return [
    {
      id: 'qualityProfiles',
      group: 'services',
      reachable: true,
      status: items.length ? 'warning' : 'ok',
      count: items.length,
      detail: items.length
        ? `${managed.length} managed`
        : `${managed.length} managed, in step`,
      items: items.slice(0, ITEM_LIMIT),
    },
  ];
};

const backfillChecks = async (
  page: Page = FIRST_PAGE
): Promise<HealthCheck[]> => {
  if (!getSettings().backfill.enabled) {
    return [];
  }
  const series = getRepository(BackfillSeries);
  const seriesHref = (row: BackfillSeries) => `/backfill/series/${row.id}`;
  const [errored, waiting, failed] = await Promise.all([
    series.findAndCount({
      where: {
        status: In(['stuck', 'none']),
        searchError: Not(IsNull()),
      },
      order: { lastSearchedAt: 'DESC' },
      skip: page.skip,
      take: page.take,
    }),
    series.findAndCount({
      where: { status: 'found' },
      order: { lastSearchedAt: 'ASC' },
      skip: page.skip,
      take: page.take,
    }),
    getRepository(BackfillJob).findAndCount({
      where: {
        status: 'failed',
        finishedAt: MoreThanOrEqual(new Date(Date.now() - 7 * DAY_MS)),
      },
      order: { finishedAt: 'DESC' },
      skip: page.skip,
      take: page.take,
    }),
  ]);
  const titles = new Map(
    (
      await series.find({
        where: { id: In(failed[0].map((job) => job.seriesId)) },
      })
    ).map((row) => [row.id, row.title])
  );
  const [findings, asking] = await Promise.all([
    getRepository(DownloadCheck).findAndCount({
      where: { status: 'waiting' },
      order: { createdAt: 'DESC' },
      skip: page.skip,
      take: page.take,
    }),
    aiFeatureOn('aiAgent')
      ? getRepository(AgentRun).findAndCount({
          select: { id: true, title: true, question: true, finishedAt: true },
          where: { status: 'waiting' },
          order: { finishedAt: 'DESC' },
          skip: page.skip,
          take: page.take,
        })
      : null,
  ]);
  const checking = downloadCheck.mode() !== 'off' || findings[1] > 0;
  return [
    {
      id: 'backfillSearchErrors',
      group: 'backfill',
      status: errored[1] > 0 ? 'warning' : 'ok',
      count: errored[1],
      items: errored[0].map((row) => ({
        title: row.title,
        detail: [
          row.searchError,
          row.lastSearchedAt ? `tried ${ago(row.lastSearchedAt)}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        href: seriesHref(row),
      })),
    },
    {
      id: 'backfillAwaiting',
      group: 'backfill',
      status: waiting[1] > 0 ? 'warning' : 'ok',
      count: waiting[1],
      items: waiting[0].map((row) => ({
        title: row.title,
        detail: row.lastSearchedAt
          ? `found ${ago(row.lastSearchedAt)}`
          : undefined,
        href: seriesHref(row),
      })),
    },
    {
      id: 'backfillFailed',
      group: 'backfill',
      status: failed[1] > 0 ? 'warning' : 'ok',
      count: failed[1],
      items: failed[0].map((job) => ({
        title: titles.get(job.seriesId) ?? job.title,
        detail: [job.error, job.finishedAt ? ago(job.finishedAt) : '']
          .filter(Boolean)
          .join(' · '),
        href: `/backfill/jobs/${job.id}`,
      })),
    },
    ...(checking
      ? [
          {
            id: 'downloadCheckWaiting',
            group: 'backfill' as const,
            status: findings[1] > 0 ? ('warning' as const) : ('ok' as const),
            count: findings[1],
            items: findings[0].map((row) => ({
              title: row.episodes
                ? `${row.itemTitle} ${row.episodes}`
                : row.itemTitle,
              detail: [row.title, ago(row.createdAt)].join(' · '),
              href: '/backfill#download-check',
            })),
          },
        ]
      : []),
    ...(asking
      ? [
          {
            id: 'agentWaiting',
            group: 'backfill' as const,
            status: asking[1] > 0 ? ('warning' as const) : ('ok' as const),
            count: asking[1],
            items: asking[0].map((run) => ({
              title: run.title ?? `#${run.id}`,
              detail: [
                run.question?.split('\n')[0].slice(0, 160),
                run.finishedAt ? ago(run.finishedAt) : '',
              ]
                .filter(Boolean)
                .join(' · '),
              href: `/backfill/agent/${run.id}`,
            })),
          },
        ]
      : []),
  ];
};

const userChecks = async (page: Page = FIRST_PAGE): Promise<HealthCheck[]> => {
  const [users, count] = await getRepository(User).findAndCount({
    where: { plexTokenExpiredAt: Not(IsNull()) },
    order: { plexTokenExpiredAt: 'DESC' },
    skip: page.skip,
    take: page.take,
  });

  return [
    {
      id: 'plexSignIn',
      group: 'users',
      status: count > 0 ? 'warning' : 'ok',
      count,
      items: users.map((user) => ({
        title: user.displayName,
        detail: user.plexTokenExpiredAt
          ? `expired ${ago(user.plexTokenExpiredAt)}`
          : undefined,
        href: `/users/${user.id}`,
      })),
    },
  ];
};

/**
 * A group that throws becomes one row saying so, rather than failing the
 * whole page: the other checks still say what they found.
 */
const guarded = async (
  group: HealthCheck['group'],
  run: () => Promise<HealthCheck[]>
): Promise<HealthCheck[]> => {
  try {
    return await run();
  } catch (e) {
    return [
      {
        id: `${group}Unavailable`,
        group,
        name: 'Could not run these checks',
        status: 'error',
        count: 1,
        detail: e instanceof Error ? e.message : String(e),
        items: [],
      },
    ];
  }
};

export const runHealthChecks = async (): Promise<{
  checkedAt: Date;
  checks: HealthCheck[];
  /** What Download Check and the admin agent did this week. */
  activity?: HealthActivity;
}> => {
  const [activity, ...groups] = await Promise.all([
    // Only worth counting while Backfill is on; a week it can't count is
    // left out rather than failing the page.
    getSettings().backfill.enabled
      ? healthActivity().catch(() => undefined)
      : undefined,
    guarded('services', serviceChecks),
    guarded('services', qualityChecks),
    guarded('backfill', backfillChecks),
    guarded('requests', requestChecks),
    guarded('media', mediaChecks),
    guarded('users', userChecks),
  ]);

  return {
    checkedAt: new Date(),
    checks: groups.flat(),
    ...(activity ? { activity } : {}),
  };
};

type OneCheck = (page: Page) => Promise<HealthCheck | undefined>;

/** One check of a group that is only run whole. */
const oneOf =
  (group: (page: Page) => Promise<HealthCheck[]>, id: string): OneCheck =>
  async (page) =>
    (await group(page)).find((check) => check.id === id);

/** Each check with a list to page through, run on its own. */
const PAGED = new Map<string, OneCheck>([
  ['failedRequests', failedRequests],
  ['neverSent', neverSent],
  ['awaitingApproval', awaitingApproval],
  ['unlinkedRequests', unlinkedRequests],
  [
    'stuckProcessing',
    (page) => stuckProcessing(new Date(Date.now() - WEEK_MS), page),
  ],
  [
    'musicNotOnServer',
    async (page) => (musicOn() ? musicNotOnServer(page) : undefined),
  ],
  [
    'musicNoRelease',
    async (page) => (musicOn() ? musicNoRelease(page) : undefined),
  ],
  ['missingTvdb', missingTvdb],
  ['collectionGaps', async (page) => collectionGapsCheck(page)],
  ['plexMatches', plexMatchesCheck],
  ['plexSignIn', oneOf(userChecks, 'plexSignIn')],
  ...[
    'backfillSearchErrors',
    'backfillAwaiting',
    'backfillFailed',
    'downloadCheckWaiting',
    'agentWaiting',
  ].map((id): [string, OneCheck] => [id, oneOf(backfillChecks, id)]),
  ['qualityProfiles', oneOf(qualityChecks, 'qualityProfiles')],
]);

/** Further than any list goes. */
const LAST_PAGE = 100_000;

/** One page of one check's list: the page shows ten at a time. */
export const runHealthCheck = async (
  id: string,
  pageNumber: number
): Promise<HealthCheck | undefined> => {
  const check = PAGED.get(id);
  if (!check) {
    return undefined;
  }
  const page = Number.isFinite(pageNumber)
    ? Math.min(LAST_PAGE, Math.max(1, Math.floor(pageNumber)))
    : 1;
  return check({ skip: (page - 1) * ITEM_LIMIT, take: ITEM_LIMIT });
};

/** Every title "Search all" would search: stuck, and Radarr or Sonarr has it. */
export const searchableStuckTitles = async (): Promise<
  { media: Media; is4k: boolean }[]
> => {
  const check = await stuckProcessing(
    new Date(Date.now() - WEEK_MS),
    EVERYTHING,
    false
  );
  const wanted = check.items.flatMap((item) =>
    item.searchable ? [item.searchable] : []
  );
  if (!wanted.length) {
    return [];
  }

  const media = await getRepository(Media).find({
    where: {
      id: In(wanted.map((w) => w.mediaId)),
      mediaType: In(VIDEO_MEDIA_TYPES),
    },
  });
  const byId = new Map(media.map((m) => [m.id, m]));
  return wanted.flatMap((w) => {
    const found = byId.get(w.mediaId);
    return found ? [{ media: found, is4k: w.is4k }] : [];
  });
};
