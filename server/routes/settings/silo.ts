import { toSiloError } from '@server/api/silo/client';
import { MediaServerChangeError } from '@server/lib/mediaServerAdmin';
import { keptSecret } from '@server/lib/savedSecret';
import { siloFullScanner } from '@server/lib/scanners/silo';
import type { SiloSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { siloClient, siloLibraries } from '@server/lib/silo';
import type { SiloConnectInput } from '@server/lib/siloConnect';
import {
  SiloResetNeeded,
  finishSiloReset,
  siloAddressOf,
  storeSilo,
  trySilo,
} from '@server/lib/siloConnect';
import { siloUsersToImport } from '@server/lib/siloUserImport';
import logger from '@server/logger';
import type { NextFunction } from 'express';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Settings → Silo (/settings/silo): the connected Silo's address and key, its
 * film and series libraries, and its full scan. Connecting and removing it
 * is under Settings → Media Servers.
 */

const siloRoutes = Router();

const libraryUpdateSchema = z.object({ enabled: z.boolean() });

const settingsBody = z.object({
  hostname: z.string().optional(),
  ip: z.string().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  useSsl: z.boolean().optional(),
  urlBase: z.string().optional(),
  externalHostname: z.string().optional(),
  forgotPasswordUrl: z.string().optional(),
  apiKey: z.string().optional(),
  confirmReset: z.boolean().optional(),
});

/** The settings as the page sees them: never the saved key. */
const shown = (silo: SiloSettings) => {
  const rest: Partial<SiloSettings> = { ...silo };
  // Only for deleting Seerr AI's own key later.
  delete rest.keyId;
  delete rest.historyCopiedTo;
  delete rest.resetPending;
  return { ...rest, apiKey: '', hasApiKey: !!silo.apiKey };
};

const failed = (next: NextFunction, e: unknown, what: string) => {
  // A different Silo than before: the page asks, then sends confirmReset.
  if (e instanceof SiloResetNeeded) {
    return next({
      status: e.status,
      message: e.message,
      errors: ['confirmReset'],
    });
  }
  if (e instanceof MediaServerChangeError) {
    return next({ status: e.status, message: e.message });
  }
  const error = toSiloError(e);
  logger.warn(`Silo: ${what} failed`, {
    label: 'Silo',
    status: error.status,
    errorMessage: error.message,
  });
  return next({
    status: error.status === 0 || error.status >= 500 ? 502 : error.status,
    message: error.message,
  });
};

siloRoutes.get('/', (_req, res) => {
  res.status(200).json(shown(getSettings().silo));
});

/*
 * Saves the address and key after trying them. A blank key keeps the saved
 * one, but only for the same address.
 */
siloRoutes.post('/', async (req, res, next) => {
  const parsed = settingsBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }
  const settings = getSettings();
  const saved = settings.silo;
  const input: SiloConnectInput & {
    externalHostname?: string;
    forgotPasswordUrl?: string;
  } = {
    hostname: parsed.data.hostname ?? parsed.data.ip ?? saved.ip,
    port: parsed.data.port ?? saved.port,
    useSsl: parsed.data.useSsl ?? saved.useSsl,
    urlBase: parsed.data.urlBase ?? saved.urlBase,
    externalHostname: parsed.data.externalHostname,
    forgotPasswordUrl: parsed.data.forgotPasswordUrl,
  };
  const comparable = (address: ReturnType<typeof siloAddressOf>) => ({
    hostname: address.ip,
    port: address.port,
    useSsl: address.useSsl,
    urlBase: address.urlBase,
  });
  input.apiKey = keptSecret(
    parsed.data.apiKey,
    comparable(siloAddressOf(input)),
    comparable(siloAddressOf({ ...saved, hostname: saved.ip })),
    saved.apiKey
  );
  if (!input.apiKey) {
    return next({
      status: 400,
      message: 'Enter the API key again for the new address.',
    });
  }
  try {
    const connection = await trySilo(input, {
      confirmReset: parsed.data.confirmReset === true,
      actingUserId: req.user?.id ?? 0,
    });
    const before = { ...saved };
    let reset: string | undefined;
    try {
      ({ reset } = await storeSilo(input, connection, {
        connect: false,
        by: { userId: req.user?.id },
      }));
      // A different Silo is saved marked resetPending, so nothing signs in
      // through it until the old one is forgotten below.
      await settings.save();
    } catch (e) {
      settings.silo = before;
      throw e;
    }
    if (reset) {
      await finishSiloReset({ sessionId: req.sessionID });
    }
    return res
      .status(200)
      .json({ ...shown(settings.silo), ...(reset ? { notice: reset } : {}) });
  } catch (e) {
    return failed(next, e, 'saving the settings');
  }
});

/** Silo's switched-on accounts not imported yet (Import Silo Users). */
siloRoutes.get('/users', async (_req, res, next) => {
  try {
    return res.status(200).json(await siloUsersToImport());
  } catch (e) {
    return failed(next, e, 'reading its accounts');
  }
});

siloRoutes.get('/library', (_req, res) => {
  res.status(200).json(getSettings().silo.libraries);
});

/** Reads Silo's film and series libraries again. */
siloRoutes.post('/library/sync', async (_req, res, next) => {
  const settings = getSettings();
  try {
    const found = await siloClient().getUserLibraries();
    settings.silo.libraries = siloLibraries(found, settings.silo.libraries);
    await settings.save();
    return res.status(200).json(settings.silo.libraries);
  } catch (e) {
    return failed(next, e, 'reading the libraries');
  }
});

siloRoutes.put<{ libraryId: string }>(
  '/library/:libraryId',
  async (req, res, next) => {
    const settings = getSettings();
    const body = libraryUpdateSchema.safeParse(req.body);
    if (!body.success) {
      return next({ status: 400, message: 'Invalid request body.' });
    }
    const library = settings.silo.libraries.find(
      (l) => l.id === req.params.libraryId
    );
    if (!library) {
      return next({ status: 404, message: 'Library does not exist.' });
    }
    library.enabled = body.data.enabled;
    await settings.save();
    return res.status(200).json(library);
  }
);

siloRoutes.get('/sync', (_req, res) => {
  res.status(200).json(siloFullScanner.status());
});

siloRoutes.post('/sync', (req, res) => {
  if (req.body.cancel) {
    siloFullScanner.cancel();
  } else if (req.body.start) {
    siloFullScanner.run();
  }
  return res.status(200).json(siloFullScanner.status());
});

export default siloRoutes;
