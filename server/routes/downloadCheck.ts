import { getRepository } from '@server/datasource';
import type { CheckStatus } from '@server/entity/DownloadCheck';
import DownloadCheck from '@server/entity/DownloadCheck';
import type {
  DownloadCheckOverview,
  DownloadCheckRow,
} from '@server/interfaces/api/downloadCheckInterfaces';
import downloadCheck, { DecideError } from '@server/lib/downloadCheck';
import { getSettings } from '@server/lib/settings';
import { Router } from 'express';
import { MoreThan } from 'typeorm';
import { z } from 'zod';

/*
 * Download Check's findings for the Backfill page (admins only, as all of
 * /backfill): the newest, everything waiting for an admin, and the week's
 * counts; and an admin's choice about one.
 */
const downloadCheckRoutes = Router();

const SHOWN = 60;
const WEEK_MS = 7 * 24 * 3600_000;

const view = (row: DownloadCheck): DownloadCheckRow => {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.params || '{}');
  } catch {
    params = {};
  }
  const servers =
    row.app === 'sonarr' ? getSettings().sonarr : getSettings().radarr;
  return {
    id: row.id,
    app: row.app,
    server: servers.find((s) => s.id === row.serverId)?.name,
    stage: row.stage,
    title: row.title,
    itemId: row.itemId,
    itemTitle: row.itemTitle,
    episodes: row.episodes,
    poster: row.poster ?? undefined,
    finding: row.finding,
    action: row.action,
    status: row.status,
    params,
    detail: row.detail || undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

downloadCheckRoutes.get('/', async (_req, res, next) => {
  try {
    const repo = getRepository(DownloadCheck);
    const [newest, waiting, week] = await Promise.all([
      repo.find({ order: { createdAt: 'DESC', id: 'DESC' }, take: SHOWN }),
      repo.find({
        where: { status: 'waiting' satisfies CheckStatus },
        order: { createdAt: 'DESC' },
      }),
      repo.find({
        select: { action: true, status: true },
        where: { createdAt: MoreThan(new Date(Date.now() - WEEK_MS)) },
      }),
    ]);
    const shown = new Map<number, DownloadCheck>();
    for (const row of [...waiting, ...newest]) shown.set(row.id, row);
    const counted = (action: string) =>
      week.filter((r) => r.status === 'done' && r.action === action).length;
    const overview: DownloadCheckOverview = {
      mode: downloadCheck.mode(),
      rows: [...shown.values()]
        .sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id
        )
        .map(view),
      week: {
        rejected: counted('reject'),
        imported: counted('import'),
        cleared: counted('clear') + counted('drop'),
        found: week.length,
      },
      waiting: waiting.length,
    };
    return res.status(200).json(overview);
  } catch (e) {
    return next({ status: 500, message: (e as Error).message });
  }
});

const choice = z.object({
  choice: z.enum(['reject', 'import', 'clear', 'drop', 'dismiss']),
});

/** Does what a finding says, imports or rejects it instead, or leaves it. */
downloadCheckRoutes.post('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  const parsed = choice.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    return next({ status: 400, message: 'Choose what to do with it.' });
  }
  const row = await getRepository(DownloadCheck).findOne({ where: { id } });
  if (!row) return next({ status: 404, message: 'That’s not there any more.' });
  if (
    parsed.data.choice !== 'dismiss' &&
    !(['would', 'waiting', 'failed'] satisfies CheckStatus[]).includes(
      row.status as 'would'
    )
  ) {
    return next({ status: 409, message: 'That’s been dealt with already.' });
  }
  try {
    const done = await downloadCheck.decide(id, parsed.data.choice);
    if (done.status === 'failed') {
      return next({ status: 502, message: done.error ?? 'That didn’t work.' });
    }
    return res.status(200).json(view(done));
  } catch (e) {
    if (e instanceof DecideError) {
      return next({ status: 409, message: e.message });
    }
    return next({ status: 500, message: (e as Error).message });
  }
});

export default downloadCheckRoutes;
