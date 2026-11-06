import RadarrAPI from '@server/api/servarr/radarr';
import { cleanProfileFolders } from '@server/constants/requestDefaults';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { answerHostRefused } from '@server/utils/hostRefused';
import { Router } from 'express';

const radarrRoutes = Router();

// One default per type (4K or not): clear the others of that type.
const clearDefaults = (servers: RadarrSettings[], is4k: boolean) => {
  servers
    .filter((radarrInstance) => radarrInstance.is4k === is4k)
    .forEach((radarrInstance) => {
      radarrInstance.isDefault = false;
    });
};

radarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.radarr);
});

radarrRoutes.post('/', async (req, res) => {
  const settings = getSettings();

  const newRadarr = req.body as RadarrSettings;
  newRadarr.profileFolders = cleanProfileFolders(newRadarr.profileFolders);
  // Never reuse a removed server's id: titles keep the id of their server.
  newRadarr.id = settings.newId('radarr');

  if (req.body.isDefault) {
    clearDefaults(settings.radarr, req.body.is4k);
  }

  settings.radarr = [...settings.radarr, newRadarr];
  await settings.save();

  return res.status(201).json(newRadarr);
});

radarrRoutes.post<
  undefined,
  Record<string, unknown>,
  RadarrSettings & { tagLabel?: string }
>('/test', async (req, res, next) => {
  try {
    const radarr = new RadarrAPI({
      apiKey: req.body.apiKey,
      url: RadarrAPI.buildUrl(req.body, '/api/v3'),
    });

    const urlBase = await radarr
      .getSystemStatus()
      .then((value) => value.urlBase)
      .catch(() => req.body.baseUrl);
    const profiles = await radarr.getProfiles();
    const folders = await radarr.getRootFolders();
    const tags = await radarr.getTags();

    return res.status(200).json({
      profiles,
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
      })),
      tags,
      urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Radarr', {
      label: 'Radarr',
      message: e.message,
    });

    // Refused for the hostname used: tell the admin how to allow it.
    if (answerHostRefused(res, 'Radarr', e)) return;
    next({ status: 500, message: 'Failed to connect to Radarr' });
  }
});

radarrRoutes.put<{ id: string }, RadarrSettings, RadarrSettings>(
  '/:id',
  async (req, res, next) => {
    const settings = getSettings();

    const radarrIndex = settings.radarr.findIndex(
      (r) => r.id === Number(req.params.id)
    );

    if (radarrIndex === -1) {
      return next({ status: 404, message: 'Settings instance not found' });
    }

    if (req.body.isDefault) {
      clearDefaults(settings.radarr, req.body.is4k);
    }

    settings.radarr[radarrIndex] = {
      ...req.body,
      id: Number(req.params.id),
      // Kept when not sent, so a client that doesn't know them can't drop them.
      profileFolders:
        req.body.profileFolders === undefined
          ? settings.radarr[radarrIndex].profileFolders
          : cleanProfileFolders(req.body.profileFolders),
    } as RadarrSettings;
    await settings.save();

    return res.status(200).json(settings.radarr[radarrIndex]);
  }
);

radarrRoutes.get<{ id: string }>('/:id/profiles', async (req, res, next) => {
  const settings = getSettings();

  const radarrSettings = settings.radarr.find(
    (r) => r.id === Number(req.params.id)
  );

  if (!radarrSettings) {
    return next({ status: 404, message: 'Settings instance not found' });
  }

  const radarr = new RadarrAPI({
    apiKey: radarrSettings.apiKey,
    url: RadarrAPI.buildUrl(radarrSettings, '/api/v3'),
  });

  const profiles = await radarr.getProfiles();

  return res.status(200).json(
    profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
    }))
  );
});

radarrRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  const settings = getSettings();

  const radarrIndex = settings.radarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (radarrIndex === -1) {
    return next({ status: 404, message: 'Settings instance not found' });
  }

  const removed = settings.radarr.splice(radarrIndex, 1);
  await settings.save();

  return res.status(200).json(removed[0]);
});

export default radarrRoutes;
