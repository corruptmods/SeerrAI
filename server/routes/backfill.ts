import { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import type { BackfillKind } from '@server/entity/BackfillSeries';
import BackfillSeries from '@server/entity/BackfillSeries';
import backfill, { isMissing } from '@server/lib/backfill/engine';
import type { PlanEntry } from '@server/lib/backfill/plan';
import { selectEntries } from '@server/lib/backfill/plan';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { In, MoreThanOrEqual, Not, Raw } from 'typeorm';
import { z } from 'zod';

/*
 * Backfill, for admins only (mounted with Permission.ADMIN). Reading works
 * whether or not Backfill is set up; searching and approving need it on.
 */
const backfillRoutes = Router();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const fail = (next: NextFunction, e: unknown, status = 400) => {
  logger.warn('Backfill request refused', {
    label: 'Backfill',
    errorMessage: message(e),
  });
  return next({ status, message: message(e) });
};

const notFound = (e: unknown) =>
  e instanceof Error && e.name === 'EntityNotFoundError';

const idParam = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error('Not a valid id.');
  }
  return id;
};

const requireReady = (res: Response, next: NextFunction): boolean => {
  const readiness = backfill.readiness();
  if (!readiness.ready) {
    next({ status: 400, message: readiness.problem });
    return false;
  }
  return true;
};

/** What a page needs of a plan entry; the import paths stay here. */
const entryView = (entry: PlanEntry) => ({
  index: entry.index,
  name: entry.path.split('/').pop(),
  size: entry.size,
  episodeIds: entry.episodeIds,
  absolute: entry.absolute,
  season: entry.season,
  episode: entry.episode,
  quality: entry.quality?.quality.name,
  version: entry.quality?.revision.version,
  score: entry.score,
  action: entry.action,
  reason: entry.reason,
  replaces: entry.replaces,
  matchedBy: entry.matchedBy,
  why: entry.why,
});

/** A candidate without its Prowlarr links, which carry Prowlarr's key. */
const candidateView = (c: BackfillCandidate, withPlan = false) => ({
  id: c.id,
  seriesId: c.seriesId,
  title: c.title,
  indexer: c.indexer,
  protocol: c.protocol,
  size: c.size,
  seeders: c.seeders,
  publishDate: c.publishDate,
  status: c.status,
  reason: c.reason,
  summary: c.summary,
  createdAt: c.createdAt,
  plan: withPlan ? c.plan.map(entryView) : undefined,
});

const jobView = (job: BackfillJob, withDetail = false) => ({
  id: job.id,
  seriesId: job.seriesId,
  candidateId: job.candidateId,
  title: job.title,
  status: job.status,
  stage: job.stage,
  mode: job.mode,
  protocol: job.protocol,
  progress: job.progress,
  size: job.size,
  sizeLeft: job.sizeLeft,
  speed: job.speed,
  secondsLeft: job.secondsLeft,
  imported: job.imported,
  replaced: job.replaced,
  rejected: job.rejected,
  fileCount: job.files.length,
  error: job.error,
  // When a job waiting on its indexer's download limit is tried again.
  retryAt:
    job.status === 'queued' &&
    job.indexerWait &&
    Date.parse(job.indexerWait.until) > Date.now()
      ? job.indexerWait.until
      : null,
  approvedByName: job.approvedByName,
  // Once failed, what became of it: the download that replaced it, or the
  // admin agent's conversation looking for one.
  followUp: job.followUp,
  replacedById: job.replacedById,
  agentRunId: job.agentRunId,
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  files: withDetail
    ? job.files.map((file) => ({
        ...entryView(file),
        state: file.state,
        note: file.note,
      }))
    : undefined,
  log: withDetail ? job.log : undefined,
});

const seriesView = (row: BackfillSeries) => ({
  id: row.id,
  kind: row.kind,
  serverId: row.serverId,
  arrId: row.arrId,
  tvdbId: row.tvdbId,
  tmdbId: row.tmdbId,
  title: row.title,
  year: row.year,
  seriesType: row.seriesType,
  poster: row.poster,
  status: backfill.isSearching(row.id) ? 'searching' : row.status,
  missing: row.missing,
  belowCutoff: row.belowCutoff,
  searchTerms: row.searchTerms ?? [],
  lastArrSearchAt: row.lastArrSearchAt,
  lastSearchedAt: row.lastSearchedAt,
  searchError: row.searchError,
  agentAutoRunAt: row.agentAutoRunAt,
});

const FILTERS: Record<string, BackfillSeries['status'][]> = {
  active: ['stuck', 'searching', 'found', 'none', 'downloading'],
  found: ['found'],
  ignored: ['ignored'],
  done: ['done'],
};

/**
 * A title search, as typed: any part of the name, upper or lower case. The
 * LIKE wildcards in it are taken literally.
 */
const titleSearch = (raw: unknown) => {
  const q = String(raw ?? '')
    .trim()
    .slice(0, 100)
    .toLowerCase();
  if (!q) return undefined;
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return {
    where: Raw((column) => `LOWER(${column}) LIKE :titleSearch ESCAPE '\\'`, {
      titleSearch: pattern,
    }),
    matches: (row: { title: string }) => row.title.toLowerCase().includes(q),
  };
};

backfillRoutes.get('/', async (req, res, next) => {
  try {
    const filter =
      FILTERS[String(req.query.filter ?? 'active')] ?? FILTERS.active;
    const search = titleSearch(req.query.q);
    const seriesRepo = getRepository(BackfillSeries);
    const rows = await seriesRepo.find({
      where: {
        status: In(filter),
        ...(search ? { title: search.where } : {}),
      },
      order: { missing: 'DESC', title: 'ASC' },
      take: 500,
    });
    const all = await seriesRepo.find({
      where: { status: In(FILTERS.active) },
    });
    const ready = await getRepository(BackfillCandidate).find({
      where: { status: 'ready' },
    });
    const bestBySeries = new Map<number, BackfillCandidate>();
    for (const c of ready) {
      const held = bestBySeries.get(c.seriesId);
      const score = (x: BackfillCandidate) =>
        (x.summary?.fill ?? 0) * 1e6 +
        (x.summary?.upgrade ?? 0) * 1e3 +
        (x.summary?.score ?? 0) / 1e3;
      if (!held || score(c) > score(held)) bestBySeries.set(c.seriesId, c);
    }
    const jobsRepo = getRepository(BackfillJob);
    const active = await backfill.withLiveProgress(
      await jobsRepo.find({
        where: {
          status: In(['queued', 'downloading', 'paused', 'importing']),
        },
        order: { createdAt: 'ASC' },
      })
    );
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const finished = await jobsRepo.find({
      where: { status: 'done', finishedAt: MoreThanOrEqual(weekAgo) },
    });
    const titles = new Map(
      (
        await seriesRepo.find({
          where: { id: In([...active, ...finished].map((j) => j.seriesId)) },
        })
      ).map((row) => [row.id, row])
    );
    // A title already being backfilled is not waiting on anyone, whatever
    // other packs its search found.
    const waiting = all.filter(
      (row) =>
        row.status === 'found' &&
        bestBySeries.has(row.id) &&
        !backfill.isSearching(row.id)
    );
    const awaiting = waiting.length;
    // While searching, each tab counts what matches, so the tab a title is
    // on shows at a glance.
    const matches = search?.matches ?? (() => true);
    const counts = {
      all: all.filter(matches).length,
      found: waiting.filter(matches).length,
      ignored: await seriesRepo.count({
        where: {
          status: 'ignored',
          ...(search ? { title: search.where } : {}),
        },
      }),
      done: await seriesRepo.count({
        where: { status: 'done', ...(search ? { title: search.where } : {}) },
      }),
    };
    res.status(200).json({
      readiness: backfill.readiness(),
      scanning: backfill.status().running,
      searchAll: backfill.searchAllStatus(),
      stats: {
        stuck: all.length,
        missing: all.reduce((n, row) => n + row.missing, 0),
        awaiting,
        filledThisWeek: finished.reduce((n, job) => n + job.imported, 0),
        filledTitles: [
          ...new Set(
            finished
              .map((job) => titles.get(job.seriesId)?.title)
              .filter(Boolean)
          ),
        ],
      },
      counts,
      series: rows.map((row) => ({
        ...seriesView(row),
        best: bestBySeries.has(row.id)
          ? candidateView(bestBySeries.get(row.id)!)
          : undefined,
        readyCount: ready.filter((c) => c.seriesId === row.id).length,
        job: active.find((j) => j.seriesId === row.id)
          ? jobView(active.find((j) => j.seriesId === row.id)!)
          : undefined,
      })),
      jobs: active.map((job) => ({
        ...jobView(job),
        series: titles.has(job.seriesId)
          ? seriesView(titles.get(job.seriesId)!)
          : undefined,
      })),
      awaiting: waiting.map((row) => ({
        ...candidateView(bestBySeries.get(row.id)!),
        series: seriesView(row),
      })),
    });
  } catch (e) {
    return fail(next, e, 500);
  }
});

/**
 * Searches every stuck title, one at a time with a pause between; the
 * overview follows its progress. DELETE stops it after the current title.
 */
backfillRoutes.post('/search-all', (req, res, next) => {
  if (!requireReady(res, next)) return;
  try {
    backfill.startSearchAll(req.user).catch((e) =>
      logger.error('Searching everything stuck failed', {
        label: 'Backfill',
        errorMessage: message(e),
      })
    );
    return res.status(202).json({ started: true });
  } catch (e) {
    return fail(next, e, 409);
  }
});

backfillRoutes.delete('/search-all', (_req, res) =>
  res.status(200).json({ stopping: backfill.stopSearchAll() })
);

backfillRoutes.post('/scan', (_req, res, next) => {
  if (!requireReady(res, next)) return;
  if (!backfill.status().running) {
    backfill.scan();
  }
  return res.status(202).json({ started: true });
});

/** Every series Sonarr has and movie Radarr has, for starting by hand. */
backfillRoutes.get('/library', async (_req, res, next) => {
  try {
    const settings = getSettings();
    const out: {
      kind: BackfillKind;
      serverId: number;
      serverName: string;
      arrId: number;
      title: string;
      year: number;
    }[] = [];
    const seen = new Set<string>();
    // A server that is down leaves its titles out rather than the list.
    const orNothing = <T>(name: string, load: () => Promise<T[]>) =>
      load().catch((e): T[] => {
        logger.warn('Backfill could not list a server', {
          label: 'Backfill',
          server: name,
          errorMessage: message(e),
        });
        return [];
      });
    for (const server of settings.sonarr) {
      for (const s of await orNothing(server.name, () =>
        backfill.sonarrFor(server.id).getAllSeries()
      )) {
        if (seen.has(`tv:${s.tvdbId}`)) continue;
        seen.add(`tv:${s.tvdbId}`);
        out.push({
          kind: 'series',
          serverId: server.id,
          serverName: server.name,
          arrId: s.id,
          title: s.title,
          year: s.year,
        });
      }
    }
    if (settings.backfill.includeMovies) {
      for (const server of settings.radarr) {
        for (const m of await orNothing(server.name, () =>
          backfill.radarrFor(server.id).getAllMovies()
        )) {
          if (seen.has(`movie:${m.tmdbId}`)) continue;
          seen.add(`movie:${m.tmdbId}`);
          out.push({
            kind: 'movie',
            serverId: server.id,
            serverName: server.name,
            arrId: m.id,
            title: m.title,
            year: m.year,
          });
        }
      }
    }
    out.sort((a, b) => a.title.localeCompare(b.title));
    return res.status(200).json(out);
  } catch (e) {
    return fail(next, e, 500);
  }
});

const trackBody = z.object({
  kind: z.enum(['series', 'movie']),
  serverId: z.number().int(),
  arrId: z.number().int(),
});

/** Follows a series or a movie (from a title page, or picked by hand). */
backfillRoutes.post('/series', async (req, res, next) => {
  const parsed = trackBody.safeParse(req.body);
  if (!parsed.success) return next({ status: 400, message: 'Bad request.' });
  try {
    const row = await backfill.track(
      parsed.data.kind,
      parsed.data.serverId,
      parsed.data.arrId
    );
    if (row.status === 'ignored' || row.status === 'done') {
      await getRepository(BackfillSeries).update(row.id, { status: 'stuck' });
      row.status = 'stuck';
    }
    return res.status(200).json(seriesView(row));
  } catch (e) {
    return fail(next, e);
  }
});

/**
 * Backfill's state for a title, for its page and the requests list: each
 * title Backfill follows, with every download it has running. Complete
 * titles only with `all`, for a title's page to link to.
 */
backfillRoutes.get('/lookup', async (req, res, next) => {
  try {
    // The validator hands the comma-separated list over as an array.
    const raw = req.query.tmdbIds as unknown;
    const tmdbIds = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 100);
    if (!tmdbIds.length) return res.status(200).json([]);
    const everything = ['1', 'true'].includes(String(req.query.all ?? ''));
    const rows = await getRepository(BackfillSeries).find({
      where: {
        tmdbId: In(tmdbIds),
        ...(everything ? {} : { status: Not('done') }),
      },
    });
    const jobs = await backfill.withLiveProgress(
      await getRepository(BackfillJob).find({
        where: {
          seriesId: In(rows.map((r) => r.id)),
          status: In(['queued', 'downloading', 'paused', 'importing']),
        },
        order: { createdAt: 'ASC' },
      })
    );
    const ready = await getRepository(BackfillCandidate).find({
      where: { seriesId: In(rows.map((r) => r.id)), status: 'ready' },
    });
    return res.status(200).json(
      rows.map((row) => {
        const own = jobs
          .filter((j) => j.seriesId === row.id)
          .map((j) => jobView(j));
        return {
          ...seriesView(row),
          readyCount: ready.filter((c) => c.seriesId === row.id).length,
          job: own[0],
          jobs: own,
        };
      })
    );
  } catch (e) {
    return fail(next, e, 500);
  }
});

interface SeriesOnDisk {
  title: string;
  year: number;
  seriesType: string;
  profile: string;
  minFormatScore: number;
  names: string[];
  coverage: {
    id: number;
    season: number;
    episode: number;
    absolute?: number;
    title?: string;
    airDate?: string;
    state: 'missing' | 'onDisk' | 'unaired' | 'unmonitored';
    quality?: string;
    score?: number;
    belowCutoff?: boolean;
  }[];
}

interface MovieOnDisk {
  title: string;
  year: number;
  profile: string;
  minFormatScore: number;
  names: string[];
  available: boolean;
  file?: { quality: string; score?: number; belowCutoff?: boolean };
}

/** A series' episodes as Sonarr has them, for its page. */
const seriesOnDisk = async (row: BackfillSeries): Promise<SeriesOnDisk> => {
  const ctx = await backfill.context(row);
  const files = new Map(ctx.files.map((f) => [f.id, f]));
  const specials = getSettings().backfill.includeSpecials;
  return {
    title: ctx.series.title,
    year: ctx.series.year,
    seriesType: ctx.series.seriesType,
    profile: ctx.profile.name,
    minFormatScore: ctx.profile.minFormatScore,
    names: ctx.names,
    coverage: ctx.episodes
      .filter((ep) => specials || ep.seasonNumber > 0)
      .sort(
        (a, b) =>
          a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
      )
      .map((ep) => {
        const file = ep.hasFile ? files.get(ep.episodeFileId) : undefined;
        return {
          id: ep.id,
          season: ep.seasonNumber,
          episode: ep.episodeNumber,
          absolute: ep.absoluteEpisodeNumber,
          title: ep.title,
          airDate: ep.airDateUtc,
          state: ep.hasFile
            ? 'onDisk'
            : isMissing(ep, true)
              ? 'missing'
              : !ep.monitored
                ? 'unmonitored'
                : 'unaired',
          quality: file?.quality.quality.name,
          score: file?.customFormatScore,
          belowCutoff: file
            ? (file as { qualityCutoffNotMet?: boolean }).qualityCutoffNotMet
            : undefined,
        };
      }),
  };
};

/** A movie and its file as Radarr has them, for its page. */
const movieOnDisk = async (row: BackfillSeries): Promise<MovieOnDisk> => {
  const ctx = await backfill.movieContext(row);
  return {
    title: ctx.movie.title,
    year: ctx.movie.year,
    profile: ctx.profile.name,
    minFormatScore: ctx.profile.minFormatScore,
    names: ctx.names,
    available: ctx.movie.isAvailable,
    file: ctx.file
      ? {
          quality: ctx.file.quality.quality.name,
          score: ctx.file.customFormatScore,
          belowCutoff: ctx.file.qualityCutoffNotMet,
        }
      : undefined,
  };
};

backfillRoutes.get('/series/:id', async (req, res, next) => {
  try {
    const id = idParam(req);
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { id },
    });
    const candidates = await getRepository(BackfillCandidate).find({
      where: { seriesId: id },
      order: { createdAt: 'DESC' },
    });
    const jobs = await backfill.withLiveProgress(
      await getRepository(BackfillJob).find({
        where: { seriesId: id },
        order: { createdAt: 'DESC' },
        take: 20,
      })
    );
    let sonarr: SeriesOnDisk | undefined;
    let movie: MovieOnDisk | undefined;
    let arrError: string | undefined;
    try {
      if (row.kind === 'movie') {
        movie = await movieOnDisk(row);
      } else {
        sonarr = await seriesOnDisk(row);
      }
    } catch (e) {
      arrError = message(e);
    }
    return res.status(200).json({
      series: seriesView(row),
      readiness: backfill.readiness(),
      sonarr,
      movie,
      arrError,
      candidates: candidates.map((c) => candidateView(c, true)),
      jobs: jobs.map((j) => jobView(j)),
    });
  } catch (e) {
    return fail(next, e, notFound(e) ? 404 : 500);
  }
});

const updateBody = z.object({
  searchTerms: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  ignored: z.boolean().optional(),
});

backfillRoutes.put('/series/:id', async (req, res, next) => {
  const parsed = updateBody.safeParse(req.body);
  if (!parsed.success) return next({ status: 400, message: 'Bad request.' });
  try {
    const id = idParam(req);
    const repo = getRepository(BackfillSeries);
    const row = await repo.findOneOrFail({ where: { id } });
    if (parsed.data.searchTerms) {
      row.searchTerms = [...new Set(parsed.data.searchTerms)];
    }
    if (parsed.data.ignored === true) {
      row.status = 'ignored';
    } else if (parsed.data.ignored === false && row.status === 'ignored') {
      row.status = 'stuck';
    }
    await repo.update(id, {
      searchTerms: row.searchTerms,
      status: row.status,
    });
    return res.status(200).json(seriesView(row));
  } catch (e) {
    return fail(next, e, notFound(e) ? 404 : 400);
  }
});

const searchBody = z.object({
  searchTerms: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
});

backfillRoutes.post('/series/:id/search', async (req, res, next) => {
  if (!requireReady(res, next)) return;
  const parsed = searchBody.safeParse(req.body ?? {});
  if (!parsed.success) return next({ status: 400, message: 'Bad request.' });
  try {
    const id = idParam(req);
    const repo = getRepository(BackfillSeries);
    const row = await repo.findOneOrFail({ where: { id } });
    if (row.status === 'downloading') {
      return next({
        status: 400,
        message: 'A backfill is running for this title; end it first.',
      });
    }
    if (parsed.data.searchTerms) {
      await repo.update(id, {
        searchTerms: [...new Set(parsed.data.searchTerms)],
      });
    }
    if (row.status === 'ignored') {
      await repo.update(id, { status: 'stuck' });
    }
    backfill.startSearch(id, req.user, { ai: true });
    return res.status(202).json({ started: true });
  } catch (e) {
    return fail(next, e, notFound(e) ? 404 : 400);
  }
});

const approveBody = z.object({
  mode: z.enum(['missing', 'all']),
  confirm: z.string().optional(),
  /** Leave out the files only the AI second opinion placed. */
  includeAi: z.boolean().optional(),
});

backfillRoutes.post('/candidates/:id/approve', async (req, res, next) => {
  if (!requireReady(res, next)) return;
  const parsed = approveBody.safeParse(req.body);
  if (!parsed.success) return next({ status: 400, message: 'Bad request.' });
  try {
    const id = idParam(req);
    const candidate = await getRepository(BackfillCandidate).findOneOrFail({
      where: { id },
    });
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: candidate.seriesId },
    });
    // Replacing files deletes the old ones for good: typing the title
    // confirms it, on the server as well as in the page.
    const replaces = selectEntries(
      candidate.plan,
      parsed.data.mode,
      parsed.data.includeAi ?? true
    ).reduce((n, e) => n + e.replaces, 0);
    if (
      replaces > 0 &&
      (parsed.data.confirm ?? '').trim().toLowerCase() !==
        row.title.trim().toLowerCase()
    ) {
      return next({
        status: 400,
        message: `This replaces ${replaces} file${replaces === 1 ? '' : 's'} on disk. Type the title to confirm.`,
      });
    }
    // A call made with the API key acts as an account (the owner's, unless
    // it names another) but was made by whatever holds the key: the job
    // says so, rather than that the person approved it.
    const viaApiKey =
      !!req.user &&
      !!getSettings().main.apiKey &&
      req.header('X-API-Key') === getSettings().main.apiKey;
    const job = await backfill.approve(id, {
      mode: parsed.data.mode,
      user: req.user,
      includeAi: parsed.data.includeAi,
      by: viaApiKey ? `${req.user?.displayName} (API key)` : undefined,
    });
    return res.status(200).json(jobView(job));
  } catch (e) {
    return fail(next, e, notFound(e) ? 404 : 400);
  }
});

backfillRoutes.post('/candidates/:id/skip', async (req, res, next) => {
  try {
    await backfill.skip(idParam(req));
    return res.status(200).json({ skipped: true });
  } catch (e) {
    return fail(next, e, notFound(e) ? 404 : 400);
  }
});

backfillRoutes.get('/jobs/:id', async (req, res, next) => {
  try {
    const [job] = await backfill.withLiveProgress([
      await getRepository(BackfillJob).findOneOrFail({
        where: { id: idParam(req) },
      }),
    ]);
    const row = await getRepository(BackfillSeries).findOne({
      where: { id: job.seriesId },
    });
    return res.status(200).json({
      ...jobView(job, true),
      series: row ? seriesView(row) : undefined,
    });
  } catch (e) {
    return fail(next, e, notFound(e) ? 404 : 500);
  }
});

backfillRoutes.post('/jobs/:id/pause', async (req, res, next) => {
  try {
    return res.status(200).json(jobView(await backfill.pause(idParam(req))));
  } catch (e) {
    return fail(next, e, notFound(e) ? 404 : 400);
  }
});

backfillRoutes.post('/jobs/:id/resume', async (req, res, next) => {
  try {
    return res.status(200).json(jobView(await backfill.resume(idParam(req))));
  } catch (e) {
    return fail(next, e, notFound(e) ? 404 : 400);
  }
});

backfillRoutes.post('/jobs/:id/end', async (req, res, next) => {
  try {
    return res
      .status(200)
      .json(jobView(await backfill.end(idParam(req), req.user)));
  } catch (e) {
    return fail(next, e, notFound(e) ? 404 : 400);
  }
});

export default backfillRoutes;
