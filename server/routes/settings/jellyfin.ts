import type { JellyfinLibrary } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import { ApiErrorCode } from '@server/constants/error';
import type { JellyfinFamilyKind } from '@server/constants/server';
import { linkedJellyfinUsers } from '@server/lib/jellyfinUsers';
import {
  hostnameOf,
  jellyfinAdmin,
  jellyfinClient,
  jellyfinFamily,
  serverName,
} from '@server/lib/mediaServers';
import { jellyfinScanners } from '@server/lib/scanners/jellyfin';
import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { ApiError } from '@server/types/error';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import { Router } from 'express';
import { omit, sortBy } from 'lodash';
import { z } from 'zod';

const libraryUpdateSchema = z.object({
  enabled: z.boolean(),
});

/**
 * Settings for a Jellyfin or an Emby server: the same pages and calls for
 * both, mounted at /settings/jellyfin and /settings/emby.
 */
const jellyfinSettingsRoutes = (kind: JellyfinFamilyKind): Router => {
  const routes = Router();
  const name = serverName(kind);
  const scanners = jellyfinScanners(kind);

  routes.get('/', (_req, res) => {
    res.status(200).json(jellyfinFamily(kind));
  });

  routes.post('/', async (req, res, next) => {
    const settings = getSettings();

    try {
      const admin = await jellyfinAdmin(kind);
      if (!admin) {
        throw new Error('No admin user.');
      }

      const tempSettings = { ...jellyfinFamily(kind), ...req.body };

      const client = new JellyfinAPI(
        hostnameOf(tempSettings),
        tempSettings.apiKey,
        admin.deviceId ?? '',
        kind
      );

      const result = await client.getSystemInfo();

      if (!result?.Id) {
        throw new ApiError(result?.status, ApiErrorCode.InvalidUrl);
      }

      // Whether the server is connected, and whether people may sign in
      // with it, are changed under Settings → Media Servers.
      Object.assign(settings[kind], omit(req.body, 'connected', 'signIn'));
      settings[kind].serverId = result.Id;
      settings[kind].name = result.ServerName;
      await settings.save();
    } catch (e) {
      if (e instanceof ApiError) {
        logger.error(`Something went wrong testing ${name} connection`, {
          label: 'API',
          status: e.statusCode,
          errorMessage: ApiErrorCode.InvalidUrl,
        });

        return next({
          status: e.statusCode,
          message: ApiErrorCode.InvalidUrl,
        });
      } else {
        logger.error('Something went wrong', {
          label: 'API',
          errorMessage: e.message,
        });

        return next({
          status: e.statusCode ?? 500,
          message: ApiErrorCode.Unknown,
        });
      }
    }

    return res.status(200).json(jellyfinFamily(kind));
  });

  routes.get('/library', (_req, res) => {
    return res.status(200).json(jellyfinFamily(kind).libraries);
  });

  routes.put('/library/:libraryId', async (req, res, next) => {
    const settings = getSettings();

    const bodyResult = libraryUpdateSchema.safeParse(req.body);

    if (!bodyResult.success) {
      return next({ status: 400, message: 'Invalid request body.' });
    }

    const library = settings[kind].libraries.find(
      (l) => l.id === req.params.libraryId
    );

    if (!library) {
      return next({ status: 404, message: 'Library does not exist.' });
    }

    library.enabled = bodyResult.data.enabled;
    await settings.save();

    return res.status(200).json(library);
  });

  routes.post('/library/sync', async (_req, res, next) => {
    const settings = getSettings();

    const client = await jellyfinClient(kind, { asAdmin: true });

    let libraries: JellyfinLibrary[];

    try {
      libraries = await client.getLibraries();

      if (libraries.length === 0) {
        // Check if no libraries are found due to the fallback to user views
        // This only affects LDAP users
        const account = await client.getUser();

        // Automatic Library grouping is not supported when user views are used to get library
        if (account.Configuration.GroupedFolders?.length > 0) {
          return next({
            status: 501,
            message: ApiErrorCode.SyncErrorGroupedFolders,
          });
        }

        return next({
          status: 404,
          message: ApiErrorCode.SyncErrorNoLibraries,
        });
      }
    } catch (e) {
      return next({
        status: e.statusCode ?? 500,
        message: e.errorCode ?? ApiErrorCode.Unknown,
      });
    }

    const newLibraries: Library[] = libraries.map((library) => {
      const existing = settings[kind].libraries.find(
        (l) => l.id === library.key
      );

      return {
        id: library.key,
        name: library.title,
        enabled: existing?.enabled ?? false,
        type: library.type,
        lastScan: existing?.lastScan,
      };
    });

    settings[kind].libraries = newLibraries;
    await settings.save();

    return res.status(200).json(settings[kind].libraries);
  });

  routes.get('/users', async (_req, res) => {
    const client = await jellyfinClient(kind, { asAdmin: true });
    const resp = await client.getUsers();

    // People already imported are left out, as on Import Plex Users: they
    // are refreshed on every import instead.
    const linked = await linkedJellyfinUsers(
      resp.users.map((user) => user.Id),
      kind
    );
    const users = resp.users
      .filter((user) => !linked.has(normalizeJellyfinGuid(user.Id) ?? ''))
      .map((user) => ({
        username: user.Name,
        id: user.Id,
        thumb: `/avatarproxy/${user.Id}?server=${kind}`,
        email: user.Name,
      }));

    return res.status(200).json(sortBy(users, 'username'));
  });

  routes.get('/sync', (_req, res) => {
    return res.status(200).json(scanners.full.status());
  });

  routes.post('/sync', (req, res) => {
    if (req.body.cancel) {
      scanners.full.cancel();
    } else if (req.body.start) {
      scanners.full.run();
    }
    return res.status(200).json(scanners.full.status());
  });

  return routes;
};

export default jellyfinSettingsRoutes;
