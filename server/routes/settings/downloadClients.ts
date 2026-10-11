import { downloadClientFor } from '@server/api/downloadclients';
import downloadTracker from '@server/lib/downloadtracker';
import type { DownloadClientSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Download clients Seerr reads directly, managed like Maintainerr: a list,
 * added and edited through a dialog, each tested before it is saved.
 *
 * The SABnzbd API key and the qBittorrent password are never sent back.
 * Each client says only whether one is saved, and a blank one on saving or
 * testing means "keep the saved one".
 */
const downloadClientRoutes = Router();

const clientBody = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1),
  type: z.enum(['sabnzbd', 'qbittorrent']),
  // Just the host: no scheme, path, port or spaces.
  hostname: z
    .string()
    .trim()
    .regex(/^[^\s/:]+$/),
  port: z.coerce.number().int().min(1).max(65535),
  useSsl: z.boolean().default(false),
  urlBase: z.string().trim().default(''),
  apiKey: z.string().default(''),
  username: z.string().trim().default(''),
  password: z.string().default(''),
});

type ClientBody = z.infer<typeof clientBody>;

/** What the settings page is shown: no key or password, only that one is set. */
const shown = (client: DownloadClientSettings) => ({
  ...client,
  apiKey: '',
  password: '',
  hasApiKey: !!client.apiKey,
  hasPassword: !!client.password,
});

/** The client as it will be saved, keeping a saved secret left blank. */
const withSecrets = (
  body: ClientBody,
  id: number,
  saved?: DownloadClientSettings
): DownloadClientSettings => ({
  id,
  name: body.name,
  type: body.type,
  hostname: body.hostname,
  port: body.port,
  useSsl: body.useSsl,
  urlBase: body.urlBase,
  apiKey: body.type === 'sabnzbd' ? body.apiKey || saved?.apiKey || '' : '',
  username: body.type === 'qbittorrent' ? body.username : '',
  password:
    body.type === 'qbittorrent' ? body.password || saved?.password || '' : '',
});

const connectionFailed = (client: DownloadClientSettings, e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  logger.warn('Could not connect to a download client', {
    label: 'API',
    client: client.name,
    errorMessage: message,
  });
  // The client's own words when they say what is wrong (a wrong key or
  // password); otherwise that it couldn't be reached.
  return {
    status: 400,
    message: /SABnzbd:|qBittorrent did not accept/.test(message)
      ? message
      : `Could not reach ${client.name || 'the download client'}.`,
  };
};

const savedClient = (id?: number) =>
  id === undefined
    ? undefined
    : getSettings().downloadClients.find((client) => client.id === id);

downloadClientRoutes.get('/', (_req, res) => {
  res.status(200).json(getSettings().downloadClients.map(shown));
});

downloadClientRoutes.post('/test', async (req, res, next) => {
  const parsed = clientBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the client details.' });
  }
  const client = withSecrets(
    parsed.data,
    parsed.data.id ?? -1,
    savedClient(parsed.data.id)
  );
  try {
    const version = await downloadClientFor(client).getVersion();
    return res.status(200).json({ version });
  } catch (e) {
    return next(connectionFailed(client, e));
  }
});

downloadClientRoutes.post('/', async (req, res, next) => {
  const parsed = clientBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the client details.' });
  }
  const settings = getSettings();
  const client = withSecrets(
    parsed.data,
    Math.max(-1, ...settings.downloadClients.map((c) => c.id)) + 1
  );

  try {
    await downloadClientFor(client).getVersion();
  } catch (e) {
    return next(connectionFailed(client, e));
  }

  settings.downloadClients = [...settings.downloadClients, client];
  await settings.save();
  void downloadTracker.updateLive();

  return res.status(201).json(shown(client));
});

downloadClientRoutes.put<{ id: string }>('/:id', async (req, res, next) => {
  const settings = getSettings();
  const id = Number(req.params.id);
  const saved = savedClient(id);
  if (!saved) {
    return next({ status: 404, message: 'Download client not found.' });
  }
  const parsed = clientBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the client details.' });
  }
  const client = withSecrets(parsed.data, id, saved);

  try {
    await downloadClientFor(client).getVersion();
  } catch (e) {
    return next(connectionFailed(client, e));
  }

  settings.downloadClients = settings.downloadClients.map((c) =>
    c.id === id ? client : c
  );
  await settings.save();
  void downloadTracker.updateLive();

  return res.status(200).json(shown(client));
});

downloadClientRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  const settings = getSettings();
  const saved = savedClient(Number(req.params.id));
  if (!saved) {
    return next({ status: 404, message: 'Download client not found.' });
  }

  settings.downloadClients = settings.downloadClients.filter(
    (c) => c !== saved
  );
  await settings.save();
  void downloadTracker.updateLive();

  return res.status(200).json(shown(saved));
});

export default downloadClientRoutes;
