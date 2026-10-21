import { isTorrentClient } from '@server/api/downloadclients';
import ProwlarrAPI from '@server/api/prowlarr';
import backfill from '@server/lib/backfill/engine';
import { GROUP_NAME, setGroupBlocked } from '@server/lib/blockedGroups';
import { keptSecret } from '@server/lib/savedSecret';
import type { BackfillSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Backfill's settings. Prowlarr's API key is never sent back; a blank one
 * keeps the saved key, but only for the same address, so the key can't be
 * sent somewhere new. With Backfill on, Prowlarr is tested before saving.
 */
const backfillSettingsRoutes = Router();

const body = z.object({
  enabled: z.boolean(),
  prowlarr: z.object({
    hostname: z
      .string()
      .trim()
      .regex(/^[^\s/:]*$/),
    port: z.coerce.number().int().min(1).max(65535),
    useSsl: z.boolean().default(false),
    urlBase: z.string().trim().default(''),
    apiKey: z.string().default(''),
  }),
  torrentClientId: z.number().int().nullable(),
  usenetClientId: z.number().int().nullable(),
  category: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[\w.-]+$/),
  includeMovies: z.boolean().default(true),
  stuckAfterHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30),
  includeCutoffUnmet: z.boolean(),
  includeSpecials: z.boolean(),
  searchesPerScan: z.coerce.number().int().min(1).max(50),
  researchAfterDays: z.coerce.number().int().min(1).max(365),
  autoApprove: z.object({
    enabled: z.boolean(),
    minScore: z.coerce.number().int().min(-10_000_000).max(10_000_000),
    maxSizeGb: z.coerce.number().min(1).max(10000),
  }),
  maxActiveJobs: z.coerce.number().int().min(1).max(10),
  minFreeSpaceGb: z.coerce.number().min(0).max(100000),
  stallHours: z.coerce.number().int().min(0).max(720),
  replaceFailed: z.boolean().default(true),
  historyDays: z.coerce.number().int().min(0).max(3650).default(90),
  agent: z
    .object({
      autoRun: z.boolean(),
      maxAutoRunsPerDay: z.coerce.number().int().min(0).max(200),
      maxGrabsPerDay: z.coerce.number().int().min(0).max(200),
      maxSteps: z.coerce.number().int().min(5).max(80),
      autoContinue: z.coerce.number().int().min(0).max(10).default(3),
      maxSizeGb: z.coerce.number().min(1).max(10000).default(40),
      instructions: z.string().trim().max(2000).default(''),
      keepDays: z.coerce.number().int().min(0).max(3650).default(30),
    })
    .default({
      autoRun: true,
      maxAutoRunsPerDay: 12,
      maxGrabsPerDay: 10,
      maxSteps: 30,
      autoContinue: 3,
      maxSizeGb: 40,
      instructions: '',
      keepDays: 30,
    }),
});

const shown = (settings: BackfillSettings) => ({
  ...settings,
  prowlarr: {
    ...settings.prowlarr,
    apiKey: '',
    hasApiKey: !!settings.prowlarr.apiKey,
  },
  torrentClients: backfill.clientsFor('torrent'),
  usenetClients: backfill.clientsFor('usenet'),
});

type ProwlarrBody = z.infer<typeof body>['prowlarr'];

const keyFor = (prowlarr: ProwlarrBody): string => {
  const saved = getSettings().backfill.prowlarr;
  return keptSecret(prowlarr.apiKey, prowlarr, saved, saved.apiKey);
};

const withKey = (data: z.infer<typeof body>): BackfillSettings => ({
  ...data,
  prowlarr: { ...data.prowlarr, apiKey: keyFor(data.prowlarr) },
  // Changed only through /blocked-groups and /download-check.
  blockedGroups: getSettings().backfill.blockedGroups,
  downloadCheck: getSettings().backfill.downloadCheck,
});

const prowlarrFailed = (e: unknown) => {
  const status =
    typeof e === 'object' && e && 'response' in e
      ? (e as { response?: { status?: number } }).response?.status
      : undefined;
  logger.warn('Could not connect to Prowlarr', {
    label: 'Backfill',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return {
    status: 400,
    message:
      status === 401 || status === 403
        ? 'Prowlarr did not accept the API key.'
        : 'Could not reach Prowlarr.',
  };
};

backfillSettingsRoutes.get('/', (_req, res) => {
  res.status(200).json(shown(getSettings().backfill));
});

backfillSettingsRoutes.post('/test', async (req, res, next) => {
  const parsed = body.shape.prowlarr.safeParse(req.body);
  if (!parsed.success || !parsed.data.hostname) {
    return next({ status: 400, message: 'Check the Prowlarr details.' });
  }
  const apiKey = keyFor(parsed.data);
  if (!apiKey) {
    return next({ status: 400, message: 'Enter Prowlarr’s API key.' });
  }
  try {
    const version = await new ProwlarrAPI({
      ...parsed.data,
      apiKey,
    }).getVersion();
    return res.status(200).json({ version });
  } catch (e) {
    return next(prowlarrFailed(e));
  }
});

backfillSettingsRoutes.put('/', async (req, res, next) => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the Backfill settings.' });
  }
  const next_ = withKey(parsed.data);
  const clients = getSettings().downloadClients;
  if (
    next_.torrentClientId !== null &&
    !clients.some(
      (c) => c.id === next_.torrentClientId && isTorrentClient(c.type)
    )
  ) {
    return next({ status: 400, message: 'Choose a torrent client.' });
  }
  if (
    next_.usenetClientId !== null &&
    !clients.some(
      (c) => c.id === next_.usenetClientId && !isTorrentClient(c.type)
    )
  ) {
    return next({ status: 400, message: 'Choose a Usenet client.' });
  }
  if (next_.enabled) {
    if (!next_.prowlarr.hostname || !next_.prowlarr.apiKey) {
      return next({
        status: 400,
        message: 'Backfill needs Prowlarr’s address and API key.',
      });
    }
    try {
      await new ProwlarrAPI(next_.prowlarr).getVersion();
    } catch (e) {
      return next(prowlarrFailed(e));
    }
  }
  const settings = getSettings();
  settings.backfill = next_;
  await settings.save();
  return res.status(200).json(shown(next_));
});

/**
 * Turns Download Check off, to Report only, or on. Apart from the form: it
 * needs nothing else of Backfill's to be set up.
 */
backfillSettingsRoutes.put('/download-check', async (req, res, next) => {
  const parsed = z
    .object({ mode: z.enum(['off', 'report', 'on']) })
    .safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Choose Off, Report only or On.' });
  }
  const settings = getSettings();
  settings.backfill = {
    ...settings.backfill,
    downloadCheck: { mode: parsed.data.mode },
  };
  await settings.save();
  logger.info(`Download Check is now ${parsed.data.mode}`, {
    label: 'Download Check',
  });
  return res.status(200).json(settings.backfill.downloadCheck);
});

/**
 * Blocks a release group, or unblocks one: saved, and Radarr and Sonarr
 * brought in line. Answers the list, and what could not be updated.
 */
backfillSettingsRoutes.post('/blocked-groups', async (req, res, next) => {
  const parsed = z
    .object({
      group: z.string().trim().regex(GROUP_NAME),
      blocked: z.boolean(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Name a release group.' });
  }
  try {
    return res
      .status(200)
      .json(await setGroupBlocked(parsed.data.group, parsed.data.blocked));
  } catch (e) {
    return next({
      status: 400,
      message: e instanceof Error ? e.message : String(e),
    });
  }
});

export default backfillSettingsRoutes;
