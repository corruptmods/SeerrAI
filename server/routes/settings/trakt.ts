import TraktAPI, { TraktError } from '@server/api/trakt';
import { getSettings } from '@server/lib/settings';
import { forgetWatched } from '@server/lib/watched';
import logger from '@server/logger';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Client ID of the admin's own Trakt app (Settings → Services). Never sent
 * back, only whether one is set; tested with Trakt before saving. Also
 * whether what people watched on Trakt is used, off unless turned on.
 */
const traktSettingsRoutes = Router();

const clientId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{20,128}$/);

const traktBody = z.object({ clientId });

/** The Client ID can be left out to keep the saved one. */
const saveBody = z.object({
  clientId: clientId.optional(),
  watchHistory: z.boolean().optional(),
});

const shown = () => ({
  hasClientId: !!getSettings().trakt.clientId,
  watchHistory: !!getSettings().trakt.watchHistory,
});

const checked = async (clientId: string) => {
  try {
    await new TraktAPI(clientId).check();
    return undefined;
  } catch (e) {
    const message =
      e instanceof TraktError ? e.message : 'Could not reach Trakt.';
    logger.warn('Trakt did not accept the Client ID', {
      label: 'Trakt',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return {
      status: 400,
      message,
      problem: e instanceof TraktError ? e.problem : 'unreachable',
    };
  }
};

traktSettingsRoutes.get('/', (_req, res) => {
  res.status(200).json(shown());
});

traktSettingsRoutes.post('/test', async (req, res) => {
  const parsed = traktBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ message: 'That is not a Trakt Client ID.', problem: 'format' });
  }
  const failed = await checked(parsed.data.clientId);
  if (failed) {
    return res.status(failed.status).json(failed);
  }
  return res.status(200).json({ ok: true });
});

traktSettingsRoutes.post('/', async (req, res) => {
  const parsed = saveBody.safeParse(req.body);
  const settings = getSettings();
  const newId = parsed.success ? parsed.data.clientId : undefined;
  if (!parsed.success || (!newId && !settings.trakt.clientId)) {
    return res
      .status(400)
      .json({ message: 'That is not a Trakt Client ID.', problem: 'format' });
  }
  if (newId) {
    const failed = await checked(newId);
    if (failed) {
      return res.status(failed.status).json(failed);
    }
  }
  settings.trakt = {
    ...settings.trakt,
    ...(newId && { clientId: newId }),
    ...(parsed.data.watchHistory !== undefined && {
      watchHistory: parsed.data.watchHistory,
    }),
  };
  await settings.save();
  // Watched titles from Trakt come and go with the switch.
  forgetWatched();
  return res.status(200).json(shown());
});

traktSettingsRoutes.delete('/', async (_req, res) => {
  const settings = getSettings();
  settings.trakt = {};
  await settings.save();
  forgetWatched();
  return res.status(200).json(shown());
});

export default traktSettingsRoutes;
