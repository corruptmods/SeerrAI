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
  applyProgress,
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
import { randomUUID } from 'crypto';
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
    av1LastResort: z.boolean(),
  }),
  nudges: z
    .record(
      z.string().regex(/^(seerr|trash):[\w-]{1,64}$/),
      z.enum(['up', 'down', 'never'])
    )
    .refine((nudges) => Object.keys(nudges).length <= 1000, {
      message: 'Too many formats moved.',
    }),
  bandStep: z.union(BAND_STEPS.map((n) => z.literal(n))),
  requestPreset: z
    .union([presetKey.exclude(['anime']), z.literal('keep')])
    .optional(),
  animeRequestPreset: z.enum(['anime', 'keep']).optional(),
});

const body = z.object({
  trash: z.object({ autoApply: z.boolean(), fillGaps: z.boolean() }),
  servers: z
    .array(serverBody)
    .max(100)
    .refine(
      (servers) =>
        new Set(servers.map((s) => `${s.kind}:${s.serverId}`)).size ===
        servers.length,
      { message: 'A server is listed twice.' }
    ),
});

const refOf = (params: { kind?: string; serverId?: string }) => {
  const parsed = z
    .object({ kind, serverId: z.coerce.number().int().min(0) })
    .safeParse(params);
  return parsed.success ? (parsed.data as QualityServerRef) : undefined;
};

interface Answer {
  status: number;
  body: unknown;
}

/** An error as the page is told it. */
const answerFor = (e: unknown, what: string): Answer => {
  if (e instanceof QualityError) {
    const status =
      e.code === 'not-found'
        ? 404
        : e.code === 'busy' ||
            e.code === 'stale' ||
            e.code === 'undo-newer-first'
          ? 409
          : 400;
    return { status, body: { code: e.code, message: e.message } };
  }
  const message = e instanceof Error ? e.message : String(e);
  logger.warn(`Quality: could not ${what}`, {
    label: 'Quality',
    errorMessage: message,
  });
  return { status: 502, body: { code: 'unreachable', message } };
};

const failed = (res: Response, e: unknown, what: string) => {
  const { status, body } = answerFor(e, what);
  return res.status(status).json(body);
};

/*
 * Applies and undoes can take minutes on a big server, longer than a proxy
 * in front of Seerr AI waits for an answer (it answers 502 and the page
 * sees a network error, while the work goes on). One that isn't done in a
 * few seconds answers 202 with a job, and the page asks how it went.
 */
let waitMs = 4000;

/** For tests: how long a request waits before answering with a job. */
export const setJobWaitForTests = (ms: number) => {
  waitMs = ms;
};
const KEEP_MS = 30 * 60_000;
const jobs = new Map<
  string,
  { ref?: QualityServerRef; at: number; answer?: Answer }
>();

const runJob = async (
  res: Response,
  ref: QualityServerRef | undefined,
  work: () => Promise<Answer>
) => {
  for (const [id, job] of jobs) {
    if (Date.now() - job.at > KEEP_MS) jobs.delete(id);
  }
  const id = randomUUID();
  const job: { ref?: QualityServerRef; at: number; answer?: Answer } = {
    ref,
    at: Date.now(),
  };
  jobs.set(id, job);
  const finished = work().then((answer) => {
    job.answer = answer;
  });
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  await Promise.race([finished, waited]);
  clearTimeout(timer);
  if (job.answer) {
    jobs.delete(id);
    return res.status(job.answer.status).json(job.answer.body);
  }
  return res.status(202).json({ job: id });
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
  // Undo writes to the server, so only while Seerr AI manages it.
  const managed = new Set(
    getSettings()
      .quality.servers.filter((s) => s.managed)
      .map((s) => `${s.kind}:${s.serverId}`)
  );
  return entries.map((entry) => {
    const key = `${entry.serverKind}:${entry.serverId}`;
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
      canUndo: managed.has(key) && newest.get(key) === entry.id,
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
        requestPreset: config.requestPreset,
        animeRequestPreset: config.animeRequestPreset,
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
        appliedChoices: saved?.appliedChoices,
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

const previewBody = z.object({ restoreKept: z.boolean().optional() });

qualityRoutes.post('/servers/:kind/:serverId/preview', async (req, res) => {
  const ref = refOf(req.params);
  if (!ref) return res.status(404).json({ code: 'not-found' });
  const parsed = previewBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ code: 'bad-request' });
  try {
    // Never apply a copy of TRaSH Guides more than a day old (the
    // daily check may not have run, say while the server was off).
    const config = configFor(ref);
    if (config.managed && Object.values(config.presets).includes('trash')) {
      await refreshTrashIfOlder(24 * 60 * 60 * 1000);
    }
    return res.status(200).json(await preview(ref, parsed.data));
  } catch (e) {
    return failed(res, e, 'make a preview');
  }
});

// How far an apply under way has got, for the page's progress bar.
qualityRoutes.get('/servers/:kind/:serverId/apply/progress', (req, res) => {
  const ref = refOf(req.params);
  if (!ref) return res.status(404).json({ code: 'not-found' });
  return res.status(200).json({ progress: applyProgress(ref) });
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
  /** The preview's: nothing is applied if what it showed has changed. */
  token: z.string().max(64).optional(),
});

qualityRoutes.post('/servers/:kind/:serverId/apply', async (req, res) => {
  const ref = refOf(req.params);
  if (!ref) return res.status(404).json({ code: 'not-found' });
  const parsed = applyBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ code: 'bad-request' });
  const userId = req.user?.id ?? null;
  return runJob(res, ref, async () => {
    try {
      const result = await apply(ref, { ...parsed.data, userId });
      await stateOf(ref);
      return { status: 200, body: result };
    } catch (e) {
      return answerFor(e, 'apply');
    }
  });
});

// How a slow apply or undo went: done with its answer, or still going.
qualityRoutes.get('/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ code: 'not-found' });
  if (!job.answer) {
    return res.status(200).json({
      done: false,
      progress: job.ref ? applyProgress(job.ref) : null,
    });
  }
  return res
    .status(200)
    .json({ done: true, status: job.answer.status, body: job.answer.body });
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

/** Choices on the page not saved yet, for What it does. */
const choicesBody = serverBody
  .pick({ presets: true, adjustments: true, nudges: true, bandStep: true })
  .partial();

// What it does with the page's choices, saved or not.
qualityRoutes.post(
  '/servers/:kind/:serverId/presets/:preset',
  async (req, res) => {
    const ref = refOf(req.params);
    const preset = presetOf(req.params.preset);
    if (!ref || !preset) return res.status(404).json({ code: 'not-found' });
    const parsed = z
      .object({ choices: choicesBody.optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ code: 'bad-request' });
    try {
      return res
        .status(200)
        .json(await describe(ref, preset, parsed.data.choices));
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
      .object({
        title: z.string().trim().min(3).max(300),
        choices: choicesBody.optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: 'bad-request' });
    try {
      return res
        .status(200)
        .json(
          await tryName(ref, preset, parsed.data.title, parsed.data.choices)
        );
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
  return runJob(res, undefined, async () => {
    try {
      return { status: 200, body: await undo(id) };
    } catch (e) {
      return answerFor(e, 'undo');
    }
  });
});

export default qualityRoutes;
