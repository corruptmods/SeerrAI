import MaintainerrAPI from '@server/api/maintainerr';
import { refreshDeletingSoon } from '@server/lib/deletingSoon';
import type { MaintainerrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

/*
 * Maintainerr servers, managed like Radarr and Sonarr: a list, added and
 * edited through a dialog, each tested before it is saved. Saving without a
 * working connection is refused, so a typo cannot quietly leave badges
 * missing.
 */
const maintainerrSettingsRoutes = Router();

const testConnection = async (server: MaintainerrSettings) =>
  new MaintainerrAPI(server).getVersion();

const connectionFailed = (e: Error) => {
  logger.error('Something went wrong testing the Maintainerr connection', {
    label: 'API',
    errorMessage: e.message,
  });
  return { status: 500, message: 'Unable to connect to Maintainerr.' };
};

maintainerrSettingsRoutes.get('/', (_req, res) => {
  res.status(200).json(getSettings().maintainerr);
});

maintainerrSettingsRoutes.post('/test', async (req, res, next) => {
  try {
    const version = await testConnection(req.body as MaintainerrSettings);
    return res.status(200).json({ version });
  } catch (e) {
    return next(connectionFailed(e));
  }
});

maintainerrSettingsRoutes.post('/', async (req, res, next) => {
  const settings = getSettings();
  const incoming = req.body as MaintainerrSettings;

  try {
    await testConnection(incoming);
  } catch (e) {
    return next(connectionFailed(e));
  }

  // Never a removed server's id, as for Radarr and Sonarr.
  const server: MaintainerrSettings = {
    ...incoming,
    id: settings.newId('maintainerr'),
  };

  settings.maintainerr = [...settings.maintainerr, server];
  await settings.save();
  void refreshDeletingSoon();

  return res.status(201).json(server);
});

maintainerrSettingsRoutes.put<{ id: string }>(
  '/:id',
  async (req, res, next) => {
    const settings = getSettings();
    const index = settings.maintainerr.findIndex(
      (s) => s.id === Number(req.params.id)
    );

    if (index === -1) {
      return next({ status: 404, message: 'Maintainerr server not found.' });
    }

    const updated: MaintainerrSettings = {
      ...(req.body as MaintainerrSettings),
      id: Number(req.params.id),
    };

    try {
      await testConnection(updated);
    } catch (e) {
      return next(connectionFailed(e));
    }

    settings.maintainerr = settings.maintainerr.map((s, i) =>
      i === index ? updated : s
    );
    await settings.save();
    void refreshDeletingSoon();

    return res.status(200).json(updated);
  }
);

maintainerrSettingsRoutes.delete<{ id: string }>(
  '/:id',
  async (req, res, next) => {
    const settings = getSettings();
    const server = settings.maintainerr.find(
      (s) => s.id === Number(req.params.id)
    );

    if (!server) {
      return next({ status: 404, message: 'Maintainerr server not found.' });
    }

    settings.maintainerr = settings.maintainerr.filter((s) => s !== server);
    await settings.save();
    void refreshDeletingSoon();

    return res.status(200).json(server);
  }
);

export default maintainerrSettingsRoutes;
