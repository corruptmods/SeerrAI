import { getRepository } from '@server/datasource';
import QualityApply from '@server/entity/QualityApply';
import { User } from '@server/entity/User';
import type { QualityServerRef } from '@server/lib/quality/arr';
import { serverSettingsOf } from '@server/lib/quality/arr';
import {
  describe,
  recentGrabs,
  serverFormats,
  tryName,
} from '@server/lib/quality/describe';
import {
  QualityError,
  allServers,
  apply,
  configFor,
  keepChanges,
  preview,
  stateOf,
  undo,
} from '@server/lib/quality/engine';
import {
  TRASH_CREDIT,
  readTrashState,
  refreshTrash,
  refreshTrashIfOlder,
} from '@server/lib/quality/trash';
import type { QualityServerSettings } from '@server/lib/quality/types';
import { BAND_STEPS, PRESET_KEYS } from '@server/lib/quality/types';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { Response } from 'express';
import { Router } from 'express';
import { In } from 'typeorm';
import { z } from 'zod';

/*
 * Settings → Quality. Saving only saves; nothing reaches Radarr or Sonarr
 * until an admin presses Apply on a server's preview (or turned on TRaSH
 * Guides updates applying on their own).
 */
const qualityRoutes = Router();

const kind = z.enum(['radarr', 'sonarr']);
const presetKey = z.enum(PRESET_KEYS);
const source = z.enum(['seerr', 'trash', 'off']);

const serverBody = z.object({
  kind,
  serverId: z.number().int().min(0),
  managed: z.boolean(),
  presets: z.partialRecord(presetKey, source),
  adjustments: z.object({
    preferUsenet: z.enum(['equal', 'always', 'none']),
    torrentWaitHours: z.coerce.number().min(0).max(168),
    fileSize: z.enum(['small', 'balanced', 'best']),
    languages: z.enum(['english-or-original', 'original', 'any']),
    hdr: z.boolean(),
    x265At1080p: z.boolean(),
    dualAudioAnime: z.boolean(),
    singleEpisodes: z.boolean(),
    burnedInLastResort: z.boolean(),
  }),
  nudges: z.record(
    z.string().regex(/^(seerr|trash):[\w-]{1,64}$/),
    z.enum(['up', 'down', 'never'])
  ),
  bandStep: z.union(BAND_STEPS.map((n) => z.literal(n))),
});

const body = z.object({
  trash: z.object({ autoApply: z.boolean(), fillGaps: z.boolean() }),
  servers: z.array(serverBody).max(100),
});

const refOf = (params: { kind?: string; serverId?: string }) => {
  const parsed = z
    .object({ kind, serverId: z.coerce.number().int().min(0) })
    .safeParse(params);
  return parsed.success ? (parsed.data as QualityServerRef) : undefined;
};

const failed = (res: Response, e: unknown, what: string) => {
  if (e instanceof QualityError) {
    const status =
      e.code === 'not-found'
        ? 404
        : e.code === 'busy' || e.code === 'undo-newer-first'
          ? 409
          : 400;
    return res.status(status).json({ code: e.code, message: e.message });
  }
  const message = e instanceof Error ? e.message : String(e);
  logger.warn(`Quality: could not ${what}`, {
    label: 'Quality',
    errorMessage: message,
  });
  return res.status(502).json({ code: 'unreachable', message });
};

const historyOf = async () => {
  const entries = await getRepository(QualityApply).find({
    order: { id: 'DESC' },
    take: 50,
  });
  const userIds = [
    ...new Set(entries.map((e) => e.userId).filter((id) => id !== null)),
  ] as number[];
  const users = userIds.length
    ? await getRepository(User).find({ where: { id: In(userIds) } })
    : [];
  const newest = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.serverKind}:${entry.serverId}`;
    if (!entry.undoneAt && !newest.has(key)) newest.set(key, entry.id);
  }
  return entries.map((entry) => {
    const server = serverSettingsOf({
      kind: entry.serverKind,
      serverId: entry.serverId,
    });
    return {
      id: entry.id,
      kind: entry.serverKind,
      serverId: entry.serverId,
      serverName: server?.name ?? '',
      created: entry.summary.created,
      updated: entry.summary.updated,
      trash: !!entry.summary.trash,
      moved: entry.moved.length,
      by: users.find((u) => u.id === entry.userId)?.displayName ?? null,
      createdAt: entry.createdAt,
      undoneAt: entry.undoneAt,
      canUndo: newest.get(`${entry.serverKind}:${entry.serverId}`) === entry.id,
    };
  });
};

const shown = async () => {
  const quality = getSettings().quality;
  const trash = await readTrashState();
  const servers = await Promise.all(
    allServers().map(async (ref) => {
      const config = configFor(ref);
      const state = await stateOf(ref);
      return {
        ...state,
        managed: config.managed,
        presets: config.presets,
        adjustments: config.adjustments,
        nudges: config.nudges,
        bandStep: config.bandStep,
      };
    })
  );
  return {
    trash: {
      ...quality.trash,
      commit: trash.commit,
      checkedAt: trash.checkedAt,
      failedAt: trash.failedAt,
      error: trash.error,
      credit: TRASH_CREDIT,
    },
    servers,
    history: await historyOf(),
  };
};

qualityRoutes.get('/', async (_req, res, next) => {
  try {
    return res.status(200).json(await shown());
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

qualityRoutes.put('/', async (req, res, next) => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: parsed.error.issues[0]?.message });
  }
  const known = new Set(allServers().map((r) => `${r.kind}:${r.serverId}`));
  const servers = parsed.data.servers.filter((s) =>
    known.has(`${s.kind}:${s.serverId}`)
  );
  const settings = getSettings();
  const current = settings.quality;
  settings.quality = {
    trash: parsed.data.trash,
    servers: servers.map((s): QualityServerSettings => {
      const saved = current.servers.find(
        (c) => c.kind === s.kind && c.serverId === s.serverId
      );
      return {
        ...s,
        trashCommit: saved?.trashCommit,
        trashRaw: saved?.trashRaw,
      };
    }),
  };
  await settings.save();
  const usesTrash = settings.quality.servers.some(
    (s) => s.managed && Object.values(s.presets).includes('trash')
  );
  if (usesTrash && !(await readTrashState()).commit) {
    // First time TRaSH Guides is chosen: fetch it now, not in an hour.
    await refreshTrash();
  }
  return res.status(200).json(await shown());
});

qualityRoutes.post('/trash/check', async (_req, res) => {
  const state = await refreshTrash();
  return res.status(200).json({
    commit: state.commit,
    checkedAt: state.checkedAt,
    failedAt: state.failedAt,
    error: state.error,
  });
});

qualityRoutes.post('/servers/:kind/:serverId/preview', async (req, res) => {
  const ref = refOf(req.params);
  if (!ref) return res.status(404).json({ code: 'not-found' });
  try {
    // Never apply a copy of TRaSH Guides more than a day old (the
    // daily check may not have run, say while the server was off).
    const config = configFor(ref);
    if (config.managed && Object.values(config.presets).includes('trash')) {
      await refreshTrashIfOlder(24 * 60 * 60 * 1000);
    }
    return res.status(200).json(await preview(ref));
  } catch (e) {
    return failed(res, e, 'make a preview');
  }
});

const applyBody = z.object({
  move: z
    .array(
      z.object({
        fromProfileId: z.number().int(),
        preset: presetKey,
      })
    )
    .max(50)
    .optional(),
  restoreKept: z.boolean().optional(),
});

qualityRoutes.post('/servers/:kind/:serverId/apply', async (req, res) => {
  const ref = refOf(req.params);
  if (!ref) return res.status(404).json({ code: 'not-found' });
  const parsed = applyBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ code: 'bad-request' });
  try {
    const result = await apply(ref, {
      ...parsed.data,
      userId: req.user?.id ?? null,
    });
    await stateOf(ref);
    return res.status(200).json(result);
  } catch (e) {
    return failed(res, e, 'apply');
  }
});

qualityRoutes.post('/servers/:kind/:serverId/keep', async (req, res) => {
  const ref = refOf(req.params);
  if (!ref) return res.status(404).json({ code: 'not-found' });
  try {
    return res.status(200).json({ kept: await keepChanges(ref) });
  } catch (e) {
    return failed(res, e, 'keep changes');
  }
});

qualityRoutes.get('/servers/:kind/:serverId/formats', async (req, res) => {
  const ref = refOf(req.params);
  if (!ref) return res.status(404).json({ code: 'not-found' });
  try {
    return res.status(200).json(await serverFormats(ref));
  } catch (e) {
    return failed(res, e, 'list formats');
  }
});

const presetOf = (value: string | undefined) => {
  const parsed = presetKey.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

qualityRoutes.get(
  '/servers/:kind/:serverId/presets/:preset',
  async (req, res) => {
    const ref = refOf(req.params);
    const preset = presetOf(req.params.preset);
    if (!ref || !preset) return res.status(404).json({ code: 'not-found' });
    try {
      return res.status(200).json(await describe(ref, preset));
    } catch (e) {
      return failed(res, e, 'describe a preset');
    }
  }
);

qualityRoutes.post(
  '/servers/:kind/:serverId/presets/:preset/try',
  async (req, res) => {
    const ref = refOf(req.params);
    const preset = presetOf(req.params.preset);
    if (!ref || !preset) return res.status(404).json({ code: 'not-found' });
    const parsed = z
      .object({ title: z.string().trim().min(3).max(300) })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: 'bad-request' });
    try {
      return res
        .status(200)
        .json(await tryName(ref, preset, parsed.data.title));
    } catch (e) {
      return failed(res, e, 'try a release name');
    }
  }
);

qualityRoutes.get(
  '/servers/:kind/:serverId/presets/:preset/grabs',
  async (req, res) => {
    const ref = refOf(req.params);
    const preset = presetOf(req.params.preset);
    if (!ref || !preset) return res.status(404).json({ code: 'not-found' });
    try {
      return res.status(200).json(await recentGrabs(ref, preset));
    } catch (e) {
      return failed(res, e, 'read recent grabs');
    }
  }
);

qualityRoutes.post('/history/:applyId/undo', async (req, res) => {
  const id = Number(req.params.applyId);
  if (!Number.isInteger(id)) return res.status(404).json({ code: 'not-found' });
  try {
    return res.status(200).json(await undo(id));
  } catch (e) {
    return failed(res, e, 'undo');
  }
});

export default qualityRoutes;
