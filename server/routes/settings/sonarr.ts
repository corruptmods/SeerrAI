import SonarrAPI from '@server/api/servarr/sonarr';
import { cleanProfileFolders } from '@server/constants/requestDefaults';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { answerHostRefused } from '@server/utils/hostRefused';
import { Router } from 'express';

const sonarrRoutes = Router();

// One default per type (4K or not): clear the others of that type.
const clearDefaults = (servers: SonarrSettings[], is4k: boolean) => {
  servers
    .filter((sonarrInstance) => sonarrInstance.is4k === is4k)
    .forEach((sonarrInstance) => {
      sonarrInstance.isDefault = false;
    });
};

sonarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.sonarr);
});

sonarrRoutes.post('/', async (req, res) => {
  const settings = getSettings();

  const newSonarr = req.body as SonarrSettings;
  newSonarr.profileFolders = cleanProfileFolders(newSonarr.profileFolders);
  // Never reuse a removed server's id: titles keep the id of their server.
  newSonarr.id = settings.newId('sonarr');

  if (req.body.isDefault) {
    clearDefaults(settings.sonarr, req.body.is4k);
  }

  settings.sonarr = [...settings.sonarr, newSonarr];
  await settings.save();

  return res.status(201).json(newSonarr);
});

sonarrRoutes.post('/test', async (req, res, next) => {
  try {
    const sonarr = new SonarrAPI({
      apiKey: req.body.apiKey,
      url: SonarrAPI.buildUrl(req.body, '/api/v3'),
    });

    const systemStatus = await sonarr.getSystemStatus();
    const sonarrMajorVersion = Number(systemStatus.version.split('.')[0]);

    const urlBase = systemStatus.urlBase;
    const profiles = await sonarr.getProfiles();
    const folders = await sonarr.getRootFolders();
    const languageProfiles =
      sonarrMajorVersion <= 3 ? await sonarr.getLanguageProfiles() : null;
    const tags = await sonarr.getTags();

    return res.status(200).json({
      profiles,
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
      })),
      languageProfiles,
      tags,
      urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Sonarr', {
      label: 'Sonarr',
      message: e.message,
    });

    // Refused for the hostname used: tell the admin how to allow it.
    if (answerHostRefused(res, 'Sonarr', e)) return;
    next({ status: 500, message: 'Failed to connect to Sonarr' });
  }
});

sonarrRoutes.put<{ id: string }>('/:id', async (req, res) => {
  const settings = getSettings();

  const sonarrIndex = settings.sonarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (sonarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  if (req.body.isDefault) {
    clearDefaults(settings.sonarr, req.body.is4k);
  }

  settings.sonarr[sonarrIndex] = {
    ...req.body,
    id: Number(req.params.id),
    // Kept when not sent, so a client that doesn't know them can't drop them.
    profileFolders:
      req.body.profileFolders === undefined
        ? settings.sonarr[sonarrIndex].profileFolders
        : cleanProfileFolders(req.body.profileFolders),
  } as SonarrSettings;
  await settings.save();

  return res.status(200).json(settings.sonarr[sonarrIndex]);
});

sonarrRoutes.delete<{ id: string }>('/:id', async (req, res) => {
  const settings = getSettings();

  const sonarrIndex = settings.sonarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (sonarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  const removed = settings.sonarr.splice(sonarrIndex, 1);
  await settings.save();

  return res.status(200).json(removed[0]);
});

export default sonarrRoutes;
