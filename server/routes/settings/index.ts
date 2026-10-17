import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import { MIN_IMAGE_CACHE_MAX_MB } from '@server/constants/images';
import { MediaType } from '@server/constants/media';
import { cleanThemeDefaults } from '@server/constants/theme';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { PlexConnection } from '@server/interfaces/api/plexInterfaces';
import type {
  LogMessage,
  LogsResultsResponse,
  SettingsAboutResponse,
} from '@server/interfaces/api/settingsInterfaces';
import { refreshMusicJobs, scheduledJobs } from '@server/job/schedule';
import animeCheck from '@server/lib/animeCheck';
import type { AvailableCacheIds } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import resourceMonitor from '@server/lib/containerResources';
import { cleanFeatureList } from '@server/lib/features';
import {
  runHealthCheck,
  runHealthChecks,
  searchableStuckTitles,
} from '@server/lib/health';
import ImageProxy, { imageConversionAvailable } from '@server/lib/imageproxy';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import { applyMediaServerLogin } from '@server/lib/mediaServerAdmin';
import {
  MEDIA_ID,
  MEDIA_SERVER_KINDS,
  serverName,
} from '@server/lib/mediaServers';
import type { MusicImageSource } from '@server/lib/music/imageSources';
import { MUSIC_IMAGE_ORIGINS } from '@server/lib/music/imageSources';
import { Permission } from '@server/lib/permissions';
import type { MediaServerName } from '@server/lib/plexMatchCheck';
import plexMatchCheck from '@server/lib/plexMatchCheck';
import { plexFullScanner } from '@server/lib/scanners/plex';
import { searchAllMissing } from '@server/lib/searchMissing';
import { cleanSeasons, seasonSettings } from '@server/lib/seasons';
import type { JobId, MainSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { requireMusicSettings } from '@server/middleware/music';
import { perUserRateLimit } from '@server/middleware/perUserRateLimit';
import discoverSettingRoutes from '@server/routes/settings/discover';
import { appDataPath } from '@server/utils/appDataVolume';
import { getAppVersion } from '@server/utils/appVersion';
import { dnsCache } from '@server/utils/dnsCache';
import { isProxyAddress } from '@server/utils/trustedProxies';
import type { DnsEntries, DnsStats } from 'dns-caching';
import { Router } from 'express';
import fs from 'fs';
import { escapeRegExp, merge, omit, set, sortBy } from 'lodash';
import { rescheduleJob } from 'node-schedule';
import path from 'path';
import { URL } from 'url';
import { z } from 'zod';
import aiSettingsRoutes from './ai';
import backfillSettingsRoutes from './backfill';
import bazarrSettingsRoutes from './bazarr';
import serverCssRoutes from './customCss';
import downloadClientRoutes from './downloadClients';
import jellyfinSettingsRoutes from './jellyfin';
import lidarrRoutes from './lidarr';
import maintainerrSettingsRoutes from './maintainerr';
import mediaServerRoutes from './mediaServers';
import metadataRoutes from './metadata';
import musicSettingsRoutes from './music';
import notificationRoutes from './notifications';
import oidcSettingsRoutes from './oidc';
import radarrRoutes from './radarr';
import sonarrRoutes from './sonarr';
import tautulliSettingsRoutes from './tautulli';
import traktSettingsRoutes from './trakt';

const settingsRoutes = Router();

settingsRoutes.use('/notifications', notificationRoutes);
settingsRoutes.use('/radarr', radarrRoutes);
settingsRoutes.use('/maintainerr', maintainerrSettingsRoutes);
settingsRoutes.use('/trakt', traktSettingsRoutes);
settingsRoutes.use('/bazarr', bazarrSettingsRoutes);
settingsRoutes.use('/tautulli', tautulliSettingsRoutes);
settingsRoutes.use('/backfill', backfillSettingsRoutes);
settingsRoutes.use('/download-clients', downloadClientRoutes);
settingsRoutes.use('/ai', aiSettingsRoutes);
settingsRoutes.use('/sonarr', sonarrRoutes);
settingsRoutes.use('/lidarr', lidarrRoutes);
settingsRoutes.use('/music', musicSettingsRoutes);
settingsRoutes.use('/discover', discoverSettingRoutes);
settingsRoutes.use('/metadatas', metadataRoutes);
settingsRoutes.use('/jellyfin', jellyfinSettingsRoutes('jellyfin'));
settingsRoutes.use('/emby', jellyfinSettingsRoutes('emby'));
settingsRoutes.use('/media-servers', mediaServerRoutes);
settingsRoutes.use('/oidc', oidcSettingsRoutes);
settingsRoutes.use('/appearance/css', serverCssRoutes);

const libraryUpdateSchema = z.object({
  enabled: z.boolean(),
});

const filteredMainSettings = (
  user: User,
  main: MainSettings
): Partial<MainSettings> => {
  if (!user?.hasPermission(Permission.ADMIN)) {
    return omit(main, 'apiKey');
  }

  return main;
};

settingsRoutes.get('/main', (req, res, next) => {
  const settings = getSettings();

  if (!req.user) {
    return next({ status: 400, message: 'User missing from request.' });
  }

  res.status(200).json(filteredMainSettings(req.user, settings.main));
});

settingsRoutes.post('/main', async (req, res, next) => {
  const settings = getSettings();

  const limitAsked = (req.body as { imageCacheMaxMb?: unknown })
    .imageCacheMaxMb;
  if (limitAsked !== undefined) {
    const mb = Number(limitAsked);
    if (!Number.isInteger(mb) || mb < MIN_IMAGE_CACHE_MAX_MB) {
      return next({
        status: 400,
        message: `The image cache limit must be a whole number of MB, at least ${MIN_IMAGE_CACHE_MAX_MB}.`,
      });
    }
    req.body.imageCacheMaxMb = mb;
  }
  const limitBefore = ImageProxy.sizeLimit();

  // The primary media server is changed under Settings → Media Servers.
  const update = omit(req.body, 'mediaServerType');
  settings.main = merge(settings.main, update);
  // The one switch for media server sign-in shown here stands for each
  // connected server's own.
  applyMediaServerLogin(update.mediaServerLogin);
  await settings.save();

  // A lower limit takes effect now, not at the next cleanup.
  if (ImageProxy.sizeLimit() < limitBefore) {
    ImageProxy.trimToLimit().catch(() => undefined);
  }

  return res.status(200).json(settings.main);
});

/*
 * The fork's optional features: which are turned off for everyone. Set as a
 * whole list, since /main merges and a merge cannot remove a list entry.
 */
settingsRoutes.get('/features', (_req, res) => {
  return res
    .status(200)
    .json({ disabled: getSettings().main.disabledFeatures ?? [] });
});

settingsRoutes.post('/features', async (req, res, next) => {
  const disabled = cleanFeatureList(
    (req.body as { disabled?: unknown }).disabled
  );
  if (!disabled) {
    return next({ status: 400, message: 'A list of features is required.' });
  }
  const settings = getSettings();
  settings.main.disabledFeatures = disabled;
  await settings.save();
  // The music jobs stop while music is off for everyone.
  refreshMusicJobs();
  return res.status(200).json({ disabled });
});

/*
 * What counts as anime: the countries whose anime is left out unless it is
 * in Japanese (utils/isAnime). Set as a whole list, like the features.
 */
settingsRoutes.get('/anime', (_req, res) => {
  return res.status(200).json({
    excludedCountries: getSettings().main.animeExcludedCountries ?? [],
  });
});

settingsRoutes.post('/anime', async (req, res, next) => {
  const asked = (req.body as { excludedCountries?: unknown }).excludedCountries;
  if (
    !Array.isArray(asked) ||
    asked.some((code) => typeof code !== 'string' || !/^[a-z]{2}$/i.test(code))
  ) {
    return next({
      status: 400,
      message: 'A list of two-letter country codes is required.',
    });
  }
  const excludedCountries = [
    ...new Set(asked.map((code: string) => code.toUpperCase())),
  ].sort();
  const settings = getSettings();
  settings.main.animeExcludedCountries = excludedCountries;
  await settings.save();
  return res.status(200).json({ excludedCountries });
});

/*
 * The server's default look (Settings → Appearance): what everyone sees who
 * has not chosen their own, and the sign-in page. Everyone can still choose
 * their own in their profile.
 */
settingsRoutes.get('/appearance', (_req, res) => {
  return res
    .status(200)
    .json({ default: getSettings().fullPublicSettings.themeDefault });
});

settingsRoutes.post('/appearance', async (req, res, next) => {
  const body = req.body as Record<string, unknown>;
  const asked = cleanThemeDefaults(body.default);
  if (!asked || Object.keys(body).some((key) => key !== 'default')) {
    return next({
      status: 400,
      message: 'A mode, accent and dark background are required.',
    });
  }
  const settings = getSettings();
  settings.appearance.default = asked;
  await settings.save();
  return res.status(200).json({ default: asked });
});

/*
 * The seasonal themes this server runs, and when (Settings → Appearance).
 * Everyone can still switch them off for themselves.
 */
settingsRoutes.get('/appearance/seasons', (_req, res) => {
  return res
    .status(200)
    .json({ seasons: seasonSettings(getSettings().appearance.seasons) });
});

settingsRoutes.post('/appearance/seasons', async (req, res, next) => {
  const body = req.body as Record<string, unknown>;
  const settings = getSettings();
  const seasons = cleanSeasons(
    body.seasons,
    seasonSettings(settings.appearance.seasons)
  );
  if (!seasons || Object.keys(body).some((key) => key !== 'seasons')) {
    return next({
      status: 400,
      message:
        'Each season needs to be on or off, with a first and last day such as 10-24.',
    });
  }
  settings.appearance.seasons = seasons;
  await settings.save();
  return res.status(200).json({ seasons });
});

settingsRoutes.get('/network', (req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.network);
});

settingsRoutes.post('/network', async (req, res) => {
  const settings = getSettings();
  const { trustedProxies: asked, ...rest } = req.body as {
    trustedProxies?: string[];
  };

  // Also Trust These Proxies: kept as entered, each checked the way Express
  // will read it when the server starts, so a typo can't keep it from
  // starting or quietly trust nothing.
  const trustedProxies = asked
    ?.map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const invalidProxy = trustedProxies?.find((entry) => !isProxyAddress(entry));
  if (invalidProxy !== undefined) {
    return res.status(400).json({
      message: `"${invalidProxy}" is not an address or range, such as 203.0.113.5 or 203.0.113.0/24.`,
      invalidProxy,
    });
  }

  settings.network = merge(settings.network, rest);
  // The whole list, set rather than merged: a merge keeps the entries past
  // the end of a shorter list.
  if (trustedProxies) {
    settings.network.trustedProxies = trustedProxies;
  }
  await settings.save();

  return res.status(200).json(settings.network);
});

settingsRoutes.post('/main/regenerate', async (req, res, next) => {
  const settings = getSettings();

  const main = await settings.regenerateApiKey();

  if (!req.user) {
    return next({ status: 500, message: 'User missing from request.' });
  }

  return res.status(200).json(filteredMainSettings(req.user, main));
});

settingsRoutes.get('/plex', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.plex);
});

settingsRoutes.post('/plex', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();
  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });

    // Whether Plex is connected, and whether people may sign in with it,
    // are changed under Settings → Media Servers.
    Object.assign(settings.plex, omit(req.body, 'connected', 'signIn'));

    const plexClient = new PlexAPI({ plexToken: admin.plexToken });

    const result = await plexClient.getStatus();

    if (!result?.MediaContainer?.machineIdentifier) {
      throw new Error('Server not found');
    }

    settings.plex.machineId = result.MediaContainer.machineIdentifier;
    settings.plex.name = result.MediaContainer.friendlyName;

    await settings.save();
  } catch (e) {
    logger.error('Something went wrong testing Plex connection', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to connect to Plex.',
    });
  }

  return res.status(200).json(settings.plex);
});

settingsRoutes.get('/plex/devices/servers', async (req, res, next) => {
  const userRepository = getRepository(User);
  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    const plexTvClient = admin.plexToken
      ? new PlexTvAPI(admin.plexToken)
      : null;
    const devices = (await plexTvClient?.getDevices())?.filter((device) => {
      return device.provides.includes('server') && device.owned;
    });
    const settings = getSettings();

    if (devices) {
      await Promise.all(
        devices.map(async (device) => {
          const plexDirectConnections: PlexConnection[] = [];

          device.connection.forEach((connection) => {
            const url = new URL(connection.uri);

            if (url.hostname !== connection.address) {
              const plexDirectConnection = { ...connection };
              plexDirectConnection.address = url.hostname;
              plexDirectConnections.push(plexDirectConnection);

              // Connect to IP addresses over HTTP
              connection.protocol = 'http';
            }
          });

          plexDirectConnections.forEach((plexDirectConnection) => {
            device.connection.push(plexDirectConnection);
          });

          await Promise.all(
            device.connection.map(async (connection) => {
              const plexDeviceSettings = {
                ...settings.plex,
                ip: connection.address,
                port: connection.port,
                useSsl: connection.protocol === 'https',
              };
              const plexClient = new PlexAPI({
                plexToken: admin.plexToken,
                plexSettings: plexDeviceSettings,
                timeout: 5000,
              });

              try {
                await plexClient.getStatus();
                connection.status = 200;
                connection.message = 'OK';
              } catch (e) {
                connection.status = 500;
                connection.message = e.message.split(':')[0];
              }
            })
          );
        })
      );
    }
    return res.status(200).json(devices);
  } catch (e) {
    logger.error('Something went wrong retrieving Plex server list', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve Plex server list.',
    });
  }
});

settingsRoutes.get('/plex/library', (_req, res) => {
  const settings = getSettings();

  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.put('/plex/library/:libraryId', async (req, res, next) => {
  const settings = getSettings();

  const bodyResult = libraryUpdateSchema.safeParse(req.body);

  if (!bodyResult.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }

  const library = settings.plex.libraries.find(
    (l) => l.id === req.params.libraryId
  );

  if (!library) {
    return next({ status: 404, message: 'Library does not exist.' });
  }

  library.enabled = bodyResult.data.enabled;
  await settings.save();

  return res.status(200).json(library);
});

// Plex's music libraries, listed by the sync below. Only while music is on
// for everyone.
settingsRoutes.get('/plex/music-library', requireMusicSettings, (_req, res) => {
  return res.status(200).json(getSettings().plex.musicLibraries ?? []);
});

settingsRoutes.put(
  '/plex/music-library/:libraryId',
  requireMusicSettings,
  async (req, res, next) => {
    const settings = getSettings();
    const bodyResult = libraryUpdateSchema.safeParse(req.body);
    if (!bodyResult.success) {
      return next({ status: 400, message: 'Invalid request body.' });
    }
    const library = (settings.plex.musicLibraries ?? []).find(
      (l) => l.id === req.params.libraryId
    );
    if (!library) {
      return next({ status: 404, message: 'Library does not exist.' });
    }
    library.enabled = bodyResult.data.enabled;
    await settings.save();
    return res.status(200).json(library);
  }
);

settingsRoutes.post('/plex/library/sync', async (_req, res, next) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: { id: true, plexToken: true },
    where: { id: 1 },
  });
  const plexapi = new PlexAPI({ plexToken: admin.plexToken });

  try {
    await plexapi.syncLibraries();
  } catch (e) {
    return next({
      status: e.statusCode ?? 500,
      message: e.errorCode ?? ApiErrorCode.Unknown,
    });
  }

  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.get('/plex/sync', (_req, res) => {
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.post('/plex/sync', (req, res) => {
  if (req.body.cancel) {
    plexFullScanner.cancel();
  } else if (req.body.start) {
    plexFullScanner.run();
  }
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.get('/health', async (_req, res, next) => {
  try {
    return res.status(200).json(await runHealthChecks());
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

/** What Seerr's own container is using, with the last day behind it. */
settingsRoutes.get('/health/resources', async (_req, res, next) => {
  try {
    return res.status(200).json(await resourceMonitor.history());
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

/** One page of one check's list, for paging through it on the health page. */
settingsRoutes.get<{ id: string }>(
  '/health/checks/:id',
  async (req, res, next) => {
    try {
      const check = await runHealthCheck(
        req.params.id,
        Number(req.query.page ?? 1) || 1
      );
      if (!check) {
        return next({ status: 404, message: 'No such check.' });
      }
      return res.status(200).json(check);
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

/**
 * Searches Radarr and Sonarr for everything the health page lists as
 * stuck and searchable. Films go to each Radarr in one command; a series
 * whose whole aired season is missing gets a season search.
 */
settingsRoutes.post('/health/search-all-missing', async (req, res, next) => {
  try {
    const titles = await searchableStuckTitles();
    const result = await searchAllMissing(titles);

    for (const media of result.searched) {
      await recordMediaEvent({
        tmdbId: media.tmdbId,
        mediaType: media.mediaType,
        type: MediaEventType.SEARCHED,
        userId: req.user?.id,
        detail: 'Search all, from the health page',
      });
    }

    logger.info('Searched for everything missing', {
      label: 'Health',
      titles: result.titles,
      episodes: result.episodes,
      failed: result.failed.length,
      by: req.user?.displayName,
    });

    return res.status(200).json({
      titles: result.titles,
      episodes: result.episodes,
      failed: result.failed.length,
    });
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

/**
 * Removes requests no longer linked to a title — listed on the health page.
 * They cannot be sent, shown or fulfilled. Only rows with no title are
 * touched; their seasons, episode picks and watchers go with them.
 */
settingsRoutes.delete('/health/unlinked-requests', async (req, res, next) => {
  try {
    const removed = await getRepository(MediaRequest).manager.transaction(
      async (manager) => {
        const count = await manager
          .getRepository(MediaRequest)
          .createQueryBuilder('request')
          .where('request.mediaId IS NULL')
          .getCount();
        await manager
          .createQueryBuilder()
          .delete()
          .from(MediaRequest)
          .where('mediaId IS NULL')
          .execute();
        return count;
      }
    );

    logger.info('Removed requests no longer linked to a title', {
      label: 'Health',
      removed,
      by: req.user?.displayName,
    });

    return res.status(200).json({ removed });
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

settingsRoutes.get(
  '/plex/users',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const qb = userRepository.createQueryBuilder('user');

    try {
      const admin = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const plexApi = new PlexTvAPI(admin.plexToken ?? '');
      const plexUsers = (await plexApi.getUsers()).MediaContainer.User.map(
        (user) => user.$
      ).filter((user) => user.email);

      const unimportedPlexUsers: {
        id: string;
        title: string;
        username: string;
        email: string;
        thumb: string;
      }[] = [];

      const plexIds = plexUsers.map((plexUser) => plexUser.id);
      const plexEmails = plexUsers.map((plexUser) =>
        plexUser.email.toLowerCase()
      );
      if (!plexIds.length) plexIds.push('-1');
      if (!plexEmails.length) plexEmails.push('@');

      const existingUsers = await qb
        .where('user.plexId IN (:...plexIds)', { plexIds })
        .orWhere('user.email IN (:...plexEmails)', { plexEmails })
        .getMany();

      await Promise.all(
        plexUsers.map(async (plexUser) => {
          if (
            !existingUsers.find(
              (user) =>
                user.plexId === parseInt(plexUser.id) ||
                user.email === plexUser.email.toLowerCase()
            ) &&
            (await plexApi.checkUserAccess(parseInt(plexUser.id)))
          ) {
            unimportedPlexUsers.push(plexUser);
          }
        })
      );

      return res.status(200).json(sortBy(unimportedPlexUsers, 'username'));
    } catch (e) {
      logger.error('Something went wrong getting unimported Plex users', {
        label: 'API',
        errorMessage: e.message,
      });
      next({
        status: 500,
        message: 'Unable to retrieve unimported Plex users.',
      });
    }
  }
);

settingsRoutes.get(
  '/logs',
  perUserRateLimit({ windowMs: 60 * 1000, limit: 50 }),
  (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 25;
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const search = (req.query.search as string) ?? '';
    const searchRegexp = new RegExp(escapeRegExp(search), 'i');

    let filter: string[] = [];
    switch (req.query.filter) {
      case 'debug':
        filter.push('debug');
      // falls through
      case 'info':
        filter.push('info');
      // falls through
      case 'warn':
        filter.push('warn');
      // falls through
      case 'error':
        filter.push('error');
        break;
      default:
        filter = ['debug', 'info', 'warn', 'error'];
    }

    const logFile = process.env.CONFIG_DIRECTORY
      ? `${process.env.CONFIG_DIRECTORY}/logs/.machinelogs.json`
      : path.join(__dirname, '../../../config/logs/.machinelogs.json');
    const logs: LogMessage[] = [];
    const logMessageProperties = [
      'timestamp',
      'level',
      'label',
      'message',
      'data',
    ];

    const deepValueStrings = (obj: Record<string, unknown>): string[] => {
      const values = [];

      for (const val of Object.values(obj)) {
        if (typeof val === 'string') {
          values.push(val);
        } else if (typeof val === 'number') {
          values.push(val.toString());
        } else if (val !== null && typeof val === 'object') {
          values.push(...deepValueStrings(val as Record<string, unknown>));
        }
      }

      return values;
    };

    try {
      fs.readFileSync(logFile, 'utf-8')
        .split('\n')
        .forEach((line) => {
          if (!line.length) return;

          const logMessage = JSON.parse(line);

          if (!filter.includes(logMessage.level)) {
            return;
          }

          if (
            !Object.keys(logMessage).every((key) =>
              logMessageProperties.includes(key)
            )
          ) {
            Object.keys(logMessage)
              .filter((prop) => !logMessageProperties.includes(prop))
              .forEach((prop) => {
                set(logMessage, `data.${prop}`, logMessage[prop]);
              });
          }

          if (req.query.search) {
            if (
              // label and data are sometimes undefined
              !searchRegexp.test(logMessage.label ?? '') &&
              !searchRegexp.test(logMessage.message) &&
              !deepValueStrings(logMessage.data ?? {}).some((val) =>
                searchRegexp.test(val)
              )
            ) {
              return;
            }
          }

          logs.push(logMessage);
        });

      const displayedLogs = logs.reverse().slice(skip, skip + pageSize);

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(logs.length / pageSize),
          pageSize,
          results: logs.length,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: displayedLogs,
      } as LogsResultsResponse);
    } catch (error) {
      logger.error('Something went wrong while retrieving logs', {
        label: 'Logs',
        errorMessage: error.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve logs.',
      });
    }
  }
);

/** The last Match Check: folders the media server matched to another title. */
settingsRoutes.get('/plex-match-check', async (_req, res) => {
  return res.status(200).json(await plexMatchCheck.lastReport());
});

/** What the last Match Check found for one title, if anything. */
settingsRoutes.get<
  never,
  unknown,
  never,
  {
    mediaType: 'movie' | 'tv';
    tmdbId?: string;
    tvdbId?: string;
    key?: string;
  }
>('/plex-match-check/title', async (req, res) => {
  const tmdbId = req.query.tmdbId ? Number(req.query.tmdbId) : undefined;
  // Every server's id for the title Seerr has, so a server that matched a
  // folder to it wrongly is found whichever server's id the page passed.
  const media = tmdbId
    ? await getRepository(Media).findOne({
        where: {
          tmdbId,
          mediaType:
            req.query.mediaType === 'tv' ? MediaType.TV : MediaType.MOVIE,
        },
      })
    : null;
  const keys = media
    ? MEDIA_SERVER_KINDS.flatMap((kind) =>
        MEDIA_ID[kind].flatMap((column) => {
          const key = media[column];
          return key
            ? [{ mediaServer: serverName(kind) as MediaServerName, key }]
            : [];
        })
      )
    : [];
  // The id the page passed says nothing of which server it is on, so it is
  // only used when Seerr does not have the title (as a Plex rating key).
  const problems = await plexMatchCheck.problemFor(
    req.query.mediaType === 'tv' ? 'series' : 'movie',
    {
      tmdbId,
      tvdbId: req.query.tvdbId ? Number(req.query.tvdbId) : undefined,
      key: media ? undefined : req.query.key,
      keys,
    }
  );
  // `problem` is the first, for pages that show one.
  return res.status(200).json({ problem: problems[0] ?? null, problems });
});

/** The last Anime Check: series and movies that disagree with Seerr. */
settingsRoutes.get('/anime-check', async (_req, res) => {
  return res.status(200).json(await animeCheck.lastReport());
});

settingsRoutes.get('/jobs', (_req, res) => {
  return res.status(200).json(
    scheduledJobs.map((job) => ({
      id: job.id,
      name: job.name,
      type: job.type,
      interval: job.interval,
      cronSchedule: job.cronSchedule,
      nextExecutionTime: job.job.nextInvocation(),
      running: job.running ? job.running() : false,
    }))
  );
});

settingsRoutes.post<{ jobId: string }>('/jobs/:jobId/run', (req, res, next) => {
  const scheduledJob = scheduledJobs.find((job) => job.id === req.params.jobId);

  if (!scheduledJob) {
    return next({ status: 404, message: 'Job not found.' });
  }

  scheduledJob.job.invoke();

  return res.status(200).json({
    id: scheduledJob.id,
    name: scheduledJob.name,
    type: scheduledJob.type,
    interval: scheduledJob.interval,
    cronSchedule: scheduledJob.cronSchedule,
    nextExecutionTime: scheduledJob.job.nextInvocation(),
    running: scheduledJob.running ? scheduledJob.running() : false,
  });
});

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/cancel',
  (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    if (scheduledJob.cancelFn) {
      scheduledJob.cancelFn();
    }

    return res.status(200).json({
      id: scheduledJob.id,
      name: scheduledJob.name,
      type: scheduledJob.type,
      interval: scheduledJob.interval,
      cronSchedule: scheduledJob.cronSchedule,
      nextExecutionTime: scheduledJob.job.nextInvocation(),
      running: scheduledJob.running ? scheduledJob.running() : false,
    });
  }
);

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/schedule',
  async (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    const result = rescheduleJob(scheduledJob.job, req.body.schedule);
    const settings = getSettings();

    if (result) {
      settings.jobs[scheduledJob.id].schedule = req.body.schedule;
      await settings.save();

      scheduledJob.cronSchedule = req.body.schedule;

      return res.status(200).json({
        id: scheduledJob.id,
        name: scheduledJob.name,
        type: scheduledJob.type,
        interval: scheduledJob.interval,
        cronSchedule: scheduledJob.cronSchedule,
        nextExecutionTime: scheduledJob.job.nextInvocation(),
        running: scheduledJob.running ? scheduledJob.running() : false,
      });
    } else {
      return next({ status: 400, message: 'Invalid job schedule.' });
    }
  }
);

settingsRoutes.get('/cache', async (_req, res) => {
  const cacheManagerCaches = cacheManager.getAllCaches();

  const apiCaches = Object.values(cacheManagerCaches).map((cache) => ({
    id: cache.id,
    name: cache.name,
    stats: cache.getStats(),
  }));

  const [
    tmdbImageCache,
    tvdbImageCache,
    avatarImageCache,
    musicImageCaches,
    total,
    conversion,
  ] = await Promise.all([
    ImageProxy.getImageStats('tmdb'),
    ImageProxy.getImageStats('tvdb'),
    ImageProxy.getImageStats('avatar'),
    // Music's covers and pictures of artists, from their three hosts, as one.
    Promise.all(
      (Object.keys(MUSIC_IMAGE_ORIGINS) as MusicImageSource[]).map((source) =>
        ImageProxy.getImageStats(source)
      )
    ),
    ImageProxy.getTotalSize(),
    imageConversionAvailable(),
  ]);

  const stats: DnsStats | undefined = dnsCache?.getStats();
  const entries: DnsEntries | undefined = dnsCache?.getCacheEntries();

  return res.status(200).json({
    apiCaches,
    imageCache: {
      tmdb: tmdbImageCache,
      tvdb: tvdbImageCache,
      avatar: avatarImageCache,
      music: musicImageCaches.reduce(
        (sum, cache) => ({
          size: sum.size + cache.size,
          imageCount: sum.imageCount + cache.imageCount,
        }),
        { size: 0, imageCount: 0 }
      ),
    },
    imageCacheTotal: {
      size: total,
      limit: ImageProxy.sizeLimit(),
      conversion,
    },
    dnsCache: {
      stats,
      entries,
    },
  });
});

settingsRoutes.post<{ cacheId: AvailableCacheIds }>(
  '/cache/:cacheId/flush',
  (req, res, next) => {
    const cache = cacheManager.getCache(req.params.cacheId);

    if (cache) {
      cache.flush();
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post<{ dnsEntry: string }>(
  '/cache/dns/:dnsEntry/flush',
  (req, res, next) => {
    const dnsEntry = req.params.dnsEntry;

    if (dnsCache) {
      dnsCache.clear(dnsEntry);
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post(
  '/initialize',
  isAuthenticated(Permission.ADMIN),
  async (_req, res) => {
    const settings = getSettings();

    settings.public.initialized = true;
    await settings.save();

    return res.status(200).json(settings.public);
  }
);

settingsRoutes.get('/about', async (req, res) => {
  const mediaRepository = getRepository(Media);
  const mediaRequestRepository = getRepository(MediaRequest);

  const totalMediaItems = await mediaRepository.count();
  const totalRequests = await mediaRequestRepository.count();

  return res.status(200).json({
    version: getAppVersion(),
    totalMediaItems,
    totalRequests,
    tz: process.env.TZ,
    appDataPath: appDataPath(),
  } as SettingsAboutResponse);
});

export default settingsRoutes;
