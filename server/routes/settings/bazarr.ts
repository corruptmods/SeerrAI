import BazarrAPI from '@server/api/bazarr';
import type { BazarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Bazarr's address and API key. Like the download clients, the key is never
 * sent back, a blank one on saving or testing keeps the saved one, and the
 * connection is tested before anything is saved.
 */
const bazarrSettingsRoutes = Router();

const bazarrBody = z.object({
  // Just the host: no scheme, path, port or spaces.
  hostname: z
    .string()
    .trim()
    .regex(/^[^\s/:]+$/),
  port: z.coerce.number().int().min(1).max(65535),
  useSsl: z.boolean().default(false),
  urlBase: z.string().trim().default(''),
  apiKey: z.string().default(''),
});

const EMPTY: BazarrSettings = {
  hostname: '',
  port: 6767,
  useSsl: false,
  urlBase: '',
  apiKey: '',
};

/** What the settings page is shown: no key, only that one is set. */
const shown = (bazarr: BazarrSettings) => ({
  ...bazarr,
  apiKey: '',
  hasApiKey: !!bazarr.apiKey,
});

const withKey = (body: z.infer<typeof bazarrBody>): BazarrSettings => ({
  hostname: body.hostname,
  port: body.port,
  useSsl: body.useSsl,
  urlBase: body.urlBase,
  apiKey: body.apiKey || getSettings().bazarr.apiKey,
});

const connectionFailed = (e: unknown) => {
  const status =
    typeof e === 'object' && e && 'response' in e
      ? (e as { response?: { status?: number } }).response?.status
      : undefined;
  logger.warn('Could not connect to Bazarr', {
    label: 'API',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return {
    status: 400,
    message:
      status === 401 || status === 403
        ? 'Bazarr did not accept the API key.'
        : 'Could not reach Bazarr.',
  };
};

bazarrSettingsRoutes.get('/', (_req, res) => {
  res.status(200).json(shown(getSettings().bazarr));
});

bazarrSettingsRoutes.post('/test', async (req, res, next) => {
  const parsed = bazarrBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the Bazarr details.' });
  }
  const bazarr = withKey(parsed.data);
  if (!bazarr.apiKey) {
    return next({ status: 400, message: 'Enter Bazarr’s API key.' });
  }
  try {
    const version = await new BazarrAPI(bazarr).getVersion();
    return res.status(200).json({ version });
  } catch (e) {
    return next(connectionFailed(e));
  }
});

bazarrSettingsRoutes.put('/', async (req, res, next) => {
  const parsed = bazarrBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the Bazarr details.' });
  }
  const bazarr = withKey(parsed.data);
  if (!bazarr.apiKey) {
    return next({ status: 400, message: 'Enter Bazarr’s API key.' });
  }
  try {
    await new BazarrAPI(bazarr).getVersion();
  } catch (e) {
    return next(connectionFailed(e));
  }
  const settings = getSettings();
  settings.bazarr = bazarr;
  await settings.save();
  return res.status(200).json(shown(bazarr));
});

bazarrSettingsRoutes.delete('/', async (_req, res) => {
  const settings = getSettings();
  settings.bazarr = { ...EMPTY };
  await settings.save();
  return res.status(200).json(shown(settings.bazarr));
});

export default bazarrSettingsRoutes;
