import TautulliAPI from '@server/api/tautulli';
import { keptSecret } from '@server/lib/savedSecret';
import type { TautulliSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import semver from 'semver';
import { z } from 'zod';

/*
 * Tautulli's address and API key, set up from Settings → Services like
 * Bazarr: the key is never sent back, a blank one on saving or testing keeps
 * the saved one (for the same address only), and the connection is tested
 * before anything is saved.
 */
const tautulliSettingsRoutes = Router();

const tautulliBody = z.object({
  // Just the host: no scheme, path, port or spaces.
  hostname: z
    .string()
    .trim()
    .regex(/^[^\s/:]+$/),
  port: z.coerce.number().int().min(1).max(65535),
  useSsl: z.boolean().default(false),
  // Joined straight onto the address: "/tautulli", never "tautulli/".
  urlBase: z
    .string()
    .trim()
    .default('')
    .transform((base) => base.replace(/^\/*/, '/').replace(/\/+$/, '')),
  apiKey: z.string().default(''),
  externalUrl: z
    .string()
    .trim()
    .default('')
    .refine((url) => !url || /^https?:\/\/\S+$/.test(url))
    .transform((url) => url.replace(/\/+$/, '')),
});

const EMPTY: Required<TautulliSettings> = {
  hostname: '',
  port: 8181,
  useSsl: false,
  urlBase: '',
  apiKey: '',
  externalUrl: '',
};

/** What the settings page is shown: no key, only that one is set. */
const shown = (tautulli: TautulliSettings) => ({
  ...tautulli,
  apiKey: '',
  hasApiKey: !!tautulli.apiKey,
});

const withKey = (body: z.infer<typeof tautulliBody>): TautulliSettings => {
  const saved = getSettings().tautulli;
  return {
    hostname: body.hostname,
    port: body.port,
    useSsl: body.useSsl,
    urlBase: body.urlBase,
    apiKey: keptSecret(body.apiKey, body, saved, saved.apiKey),
    externalUrl: body.externalUrl,
  };
};

/** Its version, if it answers and is new enough (2.9 or later). */
const check = async (tautulli: TautulliSettings): Promise<string> => {
  const info = await new TautulliAPI(tautulli).getInfo();
  const version = info?.tautulli_version;
  if (!version) throw new Error('Tautulli did not accept the API key.');
  if (!semver.gte(semver.coerce(version) ?? '0.0.0', '2.9.0')) {
    throw new Error(`Tautulli ${version} is too old; 2.9 or later is needed.`);
  }
  return version;
};

const connectionFailed = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  logger.warn('Could not connect to Tautulli', {
    label: 'API',
    errorMessage: message,
  });
  return {
    status: 400,
    message: message.startsWith('Tautulli ')
      ? message
      : 'Could not reach Tautulli, or it did not accept the API key.',
  };
};

tautulliSettingsRoutes.get('/', (_req, res) => {
  res.status(200).json(shown(getSettings().tautulli));
});

tautulliSettingsRoutes.post('/test', async (req, res, next) => {
  const parsed = tautulliBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the Tautulli details.' });
  }
  const tautulli = withKey(parsed.data);
  if (!tautulli.apiKey) {
    return next({ status: 400, message: 'Enter Tautulli’s API key.' });
  }
  try {
    return res.status(200).json({ version: await check(tautulli) });
  } catch (e) {
    return next(connectionFailed(e));
  }
});

tautulliSettingsRoutes.post('/', async (req, res, next) => {
  const parsed = tautulliBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the Tautulli details.' });
  }
  const tautulli = withKey(parsed.data);
  if (!tautulli.apiKey) {
    return next({ status: 400, message: 'Enter Tautulli’s API key.' });
  }
  try {
    await check(tautulli);
  } catch (e) {
    return next(connectionFailed(e));
  }
  const settings = getSettings();
  settings.tautulli = tautulli;
  await settings.save();
  return res.status(200).json(shown(settings.tautulli));
});

tautulliSettingsRoutes.delete('/', async (_req, res) => {
  const settings = getSettings();
  settings.tautulli = { ...EMPTY };
  await settings.save();
  return res.status(200).json(shown(settings.tautulli));
});

export default tautulliSettingsRoutes;
