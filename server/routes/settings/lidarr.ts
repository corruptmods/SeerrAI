import LidarrAPI from '@server/api/servarr/lidarr';
import { refreshMusicJobs } from '@server/job/schedule';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { requireMusicSettings } from '@server/middleware/music';
import { Router } from 'express';

/*
 * Lidarr servers, for music, set up from Settings → Services like Radarr's.
 * There is no 4K Lidarr, so one server is the default. Adding a default
 * Lidarr is what makes music appear for everyone; while an admin has music
 * turned off for everyone, these settings are gone too.
 */
const lidarrRoutes = Router();

lidarrRoutes.use(requireMusicSettings);

/** A server as saved: never 4K. */
const asSaved = (body: LidarrSettings, id: number): LidarrSettings => ({
  ...body,
  id,
  is4k: false,
});

/** One default at a time: a new default takes over from the old one. */
const clearDefaults = (except?: number) => {
  for (const server of getSettings().lidarr) {
    if (server.id !== except) {
      server.isDefault = false;
    }
  }
};

lidarrRoutes.get('/', (_req, res) => {
  res.status(200).json(getSettings().lidarr);
});

lidarrRoutes.post('/', async (req, res) => {
  const settings = getSettings();
  // Never a removed server's id: artists keep the id of the server they
  // are on.
  const newLidarr = asSaved(
    req.body as LidarrSettings,
    settings.newId('lidarr')
  );
  if (newLidarr.isDefault) {
    clearDefaults();
  }
  settings.lidarr = [...settings.lidarr, newLidarr];
  await settings.save();
  // The music jobs run once there is a default Lidarr.
  refreshMusicJobs();
  return res.status(201).json(newLidarr);
});

lidarrRoutes.post<
  undefined,
  Record<string, unknown>,
  Pick<LidarrSettings, 'hostname' | 'port' | 'apiKey' | 'useSsl' | 'baseUrl'>
>('/test', async (req, res, next) => {
  try {
    const lidarr = new LidarrAPI({
      apiKey: req.body.apiKey,
      url: LidarrAPI.buildUrl(req.body as LidarrSettings, '/api/v1'),
    });

    const urlBase = await lidarr
      .getSystemStatus()
      .then((value) => value.urlBase)
      .catch(() => req.body.baseUrl);
    const profiles = await lidarr.getProfiles();
    const metadataProfiles = await lidarr.getMetadataProfiles();
    const folders = await lidarr.getRootFolders();
    const tags = await lidarr.getTags();

    return res.status(200).json({
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
      })),
      metadataProfiles: metadataProfiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
      })),
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
      })),
      tags,
      urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Lidarr', {
      label: 'Lidarr',
      message: e instanceof Error ? e.message : String(e),
    });
    next({ status: 500, message: 'Failed to connect to Lidarr' });
  }
});

lidarrRoutes.put<{ id: string }, LidarrSettings, LidarrSettings>(
  '/:id',
  async (req, res, next) => {
    const settings = getSettings();
    const id = Number(req.params.id);
    const index = settings.lidarr.findIndex((server) => server.id === id);
    if (index === -1) {
      return next({ status: 404, message: 'Settings instance not found' });
    }
    if (req.body.isDefault) {
      clearDefaults(id);
    }
    settings.lidarr[index] = asSaved(req.body, id);
    await settings.save();
    refreshMusicJobs();
    return res.status(200).json(settings.lidarr[index]);
  }
);

lidarrRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  const settings = getSettings();
  const index = settings.lidarr.findIndex(
    (server) => server.id === Number(req.params.id)
  );
  if (index === -1) {
    return next({ status: 404, message: 'Settings instance not found' });
  }
  const [removed] = settings.lidarr.splice(index, 1);
  await settings.save();
  refreshMusicJobs();
  return res.status(200).json(removed);
});

export default lidarrRoutes;
