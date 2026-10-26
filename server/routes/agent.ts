import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import BackfillSeries from '@server/entity/BackfillSeries';
import type {
  AgentOverview,
  AgentRunDetail,
  AgentRunSummary,
} from '@server/interfaces/api/agentInterfaces';
import agent, { NoSuchRun, proposalOf } from '@server/lib/agent';
import backfill from '@server/lib/backfill/engine';
import { getSettings } from '@server/lib/settings';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { In } from 'typeorm';
import { z } from 'zod';

/*
 * The admin agent, for admins: what it has done (each run with its steps)
 * and asking it to do something.
 */
const agentRoutes = Router();

const PAGE = 25;

const iso = (date: Date | null | undefined) =>
  date ? new Date(date).toISOString() : null;

const summaryOf = (run: AgentRun): AgentRunSummary => ({
  id: run.id,
  trigger: run.trigger,
  status: run.status,
  ask: run.ask,
  title: run.title,
  kind: run.kind,
  summary: run.summary,
  error: run.error,
  question: run.question,
  actions: run.actions,
  steps: run.steps.length,
  requestedByName: run.requestedByName,
  createdAt: new Date(run.createdAt).toISOString(),
  finishedAt: iso(run.finishedAt),
});

const titleSchema = z.object({
  kind: z.enum(['series', 'movie', 'album']),
  serverId: z.coerce.number().int().min(0),
  arrId: z.coerce.number().int().min(1),
});

agentRoutes.get('/', async (req, res) => {
  const page = Math.max(0, Number(req.query.page) || 0);
  // One title's conversations, for its page.
  const title = titleSchema.safeParse(req.query);
  const [runs, total] = await getRepository(AgentRun).findAndCount({
    ...(title.success ? { where: title.data } : {}),
    order: { id: 'DESC' },
    take: PAGE,
    skip: page * PAGE,
  });
  const body: AgentOverview = {
    problem: agent.problem(req.user),
    autoRun: getSettings().backfill.agent.autoRun,
    busy: agent.isBusy(),
    runs: runs.map(summaryOf),
    total,
    // Across every page, so Clear finished is offered whichever page is open.
    finished: await getRepository(AgentRun).count({
      where: { status: In(['done', 'failed']) },
    }),
  };
  return res.status(200).json(body);
});

agentRoutes.get<{ id: string }>('/:id', async (req, res, next) => {
  const run = await getRepository(AgentRun).findOne({
    where: { id: Number(req.params.id) || 0 },
  });
  if (!run) return next({ status: 404, message: 'There is no such run.' });
  const row =
    run.kind && run.serverId !== null && run.arrId !== null
      ? await getRepository(BackfillSeries).findOne({
          where: { kind: run.kind, serverId: run.serverId, arrId: run.arrId },
        })
      : null;
  const body: AgentRunDetail = {
    ...summaryOf(run),
    steps: run.steps,
    proposal: (() => {
      const proposal = run.status === 'waiting' ? proposalOf(run) : undefined;
      return proposal
        ? {
            id: proposal.id,
            at: proposal.at,
            changes: proposal.changes.map(({ kind, headline, details }) => ({
              kind,
              headline,
              details,
            })),
          }
        : null;
    })(),
    backfillId: row?.id ?? null,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
  };
  return res.status(200).json(body);
});

/**
 * A title in Sonarr, Radarr or Lidarr, by its name there, or null if it is
 * not.
 */
const nameOf = async (
  title: z.infer<typeof titleSchema>
): Promise<string | null> => {
  try {
    if (title.kind === 'album') {
      if (!backfill.readiness().music) return null;
      const lidarr = backfill.lidarrFor(title.serverId);
      const album = await lidarr.getAlbumDetail(title.arrId);
      const artist = await lidarr.getArtistDetail(album.artistId);
      return `${album.title} by ${artist.artistName}`;
    }
    if (title.kind === 'series') {
      return (
        await backfill.sonarrFor(title.serverId).getSeriesDetail(title.arrId)
      ).title;
    }
    return (
      await backfill.radarrFor(title.serverId).getMovieDetail(title.arrId)
    ).title;
  } catch {
    return null;
  }
};

const DEFAULT_ASK = 'Get whatever is missing.';

agentRoutes.post('/ask', async (req, res, next) => {
  const body = z
    .object({
      text: z.string().trim().max(1000).default(''),
      title: titleSchema.optional(),
    })
    .refine((b) => b.title || b.text.length >= 3)
    .safeParse(req.body);
  if (!body.success) {
    return next({ status: 400, message: 'Say what to look for.' });
  }
  if (!req.user) return next({ status: 403, message: 'Sign in first.' });
  let about: { title: z.infer<typeof titleSchema>; name: string } | undefined;
  if (body.data.title) {
    const name = await nameOf(body.data.title);
    if (!name) {
      return next({
        status: 400,
        message: 'That title is not in Sonarr, Radarr or Lidarr.',
      });
    }
    about = { title: body.data.title, name };
  }
  try {
    const run = await agent.ask(body.data.text || DEFAULT_ASK, req.user, about);
    return res.status(202).json(summaryOf(run));
  } catch (e) {
    return next({
      status: 409,
      message: e instanceof Error ? e.message : 'The agent cannot run now.',
    });
  }
});

agentRoutes.post<{ id: string }>('/:id/reply', async (req, res, next) => {
  const body = z
    .object({ text: z.string().trim().min(1).max(1000) })
    .safeParse(req.body);
  if (!body.success) {
    return next({ status: 400, message: 'Say something to it.' });
  }
  if (!req.user) return next({ status: 403, message: 'Sign in first.' });
  try {
    const run = await agent.reply(
      Number(req.params.id) || 0,
      body.data.text,
      req.user
    );
    return res.status(202).json(summaryOf(run));
  } catch (e) {
    return next({
      status: e instanceof NoSuchRun ? 404 : 409,
      message: e instanceof Error ? e.message : 'It cannot answer now.',
    });
  }
});

/** Stops a run before its next step; what it started carries on. */
agentRoutes.post<{ id: string }>('/:id/stop', async (req, res, next) => {
  if (!req.user) return next({ status: 403, message: 'Sign in first.' });
  try {
    const run = await agent.stop(Number(req.params.id) || 0, req.user);
    return res.status(202).json(summaryOf(run));
  } catch (e) {
    return next({
      status: e instanceof NoSuchRun ? 404 : 409,
      message: e instanceof Error ? e.message : 'It cannot be stopped now.',
    });
  }
});

/** Approving or declining what a run proposed, by the proposal's id. */
const decision =
  (approve: boolean) =>
  async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    const body = z.object({ proposal: z.string().uuid() }).safeParse(req.body);
    if (!body.success) {
      return next({ status: 400, message: 'Say which changes.' });
    }
    if (!req.user) return next({ status: 403, message: 'Sign in first.' });
    try {
      const id = Number(req.params.id) || 0;
      const run = approve
        ? await agent.approve(id, body.data.proposal, req.user)
        : await agent.decline(id, body.data.proposal, req.user);
      return res.status(202).json(summaryOf(run));
    } catch (e) {
      return next({
        status: 409,
        message: e instanceof Error ? e.message : 'It cannot be decided now.',
      });
    }
  };

agentRoutes.post<{ id: string }>('/:id/approve', decision(true));
agentRoutes.post<{ id: string }>('/:id/decline', decision(false));

agentRoutes.post('/clear', async (_req, res) => {
  const deleted = await agent.clearFinished();
  return res.status(200).json({ deleted });
});

agentRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  try {
    const removed = await agent.remove(Number(req.params.id) || 0);
    if (!removed) {
      return next({ status: 404, message: 'There is no such run.' });
    }
    return res.status(204).send();
  } catch (e) {
    return next({
      status: 409,
      message: e instanceof Error ? e.message : 'It cannot be deleted now.',
    });
  }
});

export default agentRoutes;
