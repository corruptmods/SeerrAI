import TraktAPI, { TraktError } from '@server/api/trakt';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { z } from 'zod';

/*
 * The Client ID of the admin's own Trakt app, set up from Settings →
 * Services. Like other keys it is never sent back, only whether one is set,
 * and it is tested with Trakt before it is saved.
 */
const traktSettingsRoutes = Router();

const traktBody = z.object({
  clientId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{20,128}$/),
});

const shown = () => ({ hasClientId: !!getSettings().trakt.clientId });

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
  const settings = getSettings();
  settings.trakt = { clientId: parsed.data.clientId };
  await settings.save();
  return res.status(200).json(shown());
});

traktSettingsRoutes.delete('/', async (_req, res) => {
  const settings = getSettings();
  settings.trakt = {};
  await settings.save();
  return res.status(200).json(shown());
});

export default traktSettingsRoutes;
