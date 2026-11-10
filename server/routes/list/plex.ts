/**
 * Plex Lists: the signed-in person's own lists on Plex, read and changed with
 * their Plex sign-in.
 */
import type PlexListsAPI from '@server/api/plexLists';
import { MAX_TITLE, PlexListsError } from '@server/api/plexLists';
import type { User } from '@server/entity/User';
import {
  autoRequestedLists,
  changePlexList,
  copyPlexList,
  createPlexList,
  mayAutoRequest,
  myPlexLists,
  ownPlexList,
  plexHasTitle,
  plexListTitles,
  plexListsFor,
  plexListsWith,
  setPlexListAutoRequest,
} from '@server/lib/plexLists';
import type { RequestMissingResult } from '@server/lib/requestMissing';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';

const plexRoutes = Router();

/** Plex's problems in the person's words, with a fitting status. */
const reply = (e: unknown, next: NextFunction, what: string) => {
  if (e instanceof PlexListsError) {
    const [status, message] =
      e.problem === 'auth'
        ? [401, 'Plex refused your sign-in. Sign out and in again with Plex.']
        : e.problem === 'missing'
          ? [404, e.message]
          : e.problem === 'unknownTitle'
            ? [422, e.message]
            : e.problem === 'changed'
              ? [
                  502,
                  'Plex changed how its lists work, so Seerr AI cannot read them right now.',
                ]
              : [502, 'Plex could not be reached. Try again in a moment.'];
    if (e.problem !== 'missing' && e.problem !== 'unknownTitle') {
      logger.warn(`Could not ${what}`, {
        label: 'Plex Lists',
        problem: e.problem,
        errorMessage: e.message,
      });
    }
    return next({ status, message });
  }
  logger.error(`Could not ${what}`, {
    label: 'Plex Lists',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return next({ status: 500, message: `Could not ${what}.` });
};

/** The person's Plex client, or a 404 when they didn't sign in with Plex. */
const clientFor = async (
  req: Request,
  next: NextFunction
): Promise<PlexListsAPI | undefined> => {
  const api = await plexListsFor(req.user?.id as number);
  if (!api) {
    next({ status: 404, message: 'Plex Lists need a Plex sign-in.' });
  }
  return api ?? undefined;
};

/** What requesting did, as the person is told; retrying is the sync's. */
const forPerson = ({ outcome, message }: RequestMissingResult) => ({
  outcome,
  ...(message !== undefined && { message }),
});

const mediaTypeOf = (value: unknown): 'movie' | 'tv' | undefined =>
  value === 'movie' || value === 'tv' ? value : undefined;

plexRoutes.get('/plex', isAuthenticated(), async (req, res, next) => {
  try {
    const user = req.user as User;
    const api = await plexListsFor(user.id);
    // Without a Plex sign-in there's no section, not an error.
    if (!api) {
      return res.status(200).json({ available: false, lists: [] });
    }
    const [lists, autoRequested] = await Promise.all([
      myPlexLists(user.id, api),
      autoRequestedLists(user.id),
    ]);
    return res.status(200).json({
      available: true,
      canAutoRequest: mayAutoRequest(user),
      lists: lists.map((list) => ({
        id: list.id,
        owner: list.owner,
        slug: list.slug,
        title: list.title,
        itemCount: list.itemCount,
        privacy: list.privacy,
        autoRequest: autoRequested.has(list.id),
      })),
    });
  } catch (e) {
    return reply(e, next, 'read your Plex lists');
  }
});

plexRoutes.post('/plex', isAuthenticated(), async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? '').trim();
    if (!title) {
      return next({ status: 400, message: 'A list name is required.' });
    }
    if (title.length > MAX_TITLE) {
      return next({
        status: 400,
        message: `A Plex list name can be at most ${MAX_TITLE} characters.`,
      });
    }
    // With a title to put on it: checked first, so a list isn't left
    // empty on Plex when Plex doesn't have the title.
    const tmdbId =
      req.body?.tmdbId === undefined ? undefined : Number(req.body.tmdbId);
    const mediaType = mediaTypeOf(req.body?.mediaType);
    if (
      tmdbId !== undefined &&
      (!Number.isInteger(tmdbId) || tmdbId < 1 || !mediaType)
    ) {
      return next({ status: 400, message: 'A title is required.' });
    }
    const user = req.user as User;
    const api = await clientFor(req, next);
    if (!api) return;
    if (tmdbId !== undefined && mediaType) {
      await plexHasTitle(api, tmdbId, mediaType);
    }
    const list = await createPlexList(
      user.id,
      api,
      title,
      req.body?.ranked === true
    );
    const request =
      tmdbId !== undefined && mediaType
        ? await changePlexList(user, api, list, 'add', tmdbId, mediaType)
        : undefined;
    return res.status(201).json({
      id: list.id,
      owner: list.owner,
      slug: list.slug,
      title: list.title,
      ...(request && { request: forPerson(request) }),
    });
  } catch (e) {
    return reply(e, next, 'start the Plex list');
  }
});

plexRoutes.get('/plex/contains', isAuthenticated(), async (req, res, next) => {
  try {
    const tmdbId = Number(req.query.tmdbId);
    const mediaType = mediaTypeOf(req.query.mediaType);
    if (!Number.isInteger(tmdbId) || tmdbId < 1 || !mediaType) {
      return next({ status: 400, message: 'A title is required.' });
    }
    const user = req.user as User;
    const api = await plexListsFor(user.id);
    if (!api) {
      return res.status(200).json([]);
    }
    const lists = await plexListsWith(user.id, api, tmdbId, mediaType);
    return res.status(200).json(
      lists.map(({ summary, contains }) => ({
        id: summary.id,
        owner: summary.owner,
        slug: summary.slug,
        title: summary.title,
        contains,
      }))
    );
  } catch (e) {
    return reply(e, next, 'read your Plex lists');
  }
});

plexRoutes.get<{ owner: string; slug: string }>(
  '/plex/:owner/:slug',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const user = req.user as User;
      const api = await clientFor(req, next);
      if (!api) return;
      const summary = await ownPlexList(
        user.id,
        api,
        req.params.owner,
        req.params.slug
      );
      const [{ detail, titles }, autoRequested] = await Promise.all([
        plexListTitles(api, summary),
        autoRequestedLists(user.id),
      ]);
      return res.status(200).json({
        id: summary.id,
        owner: summary.owner,
        slug: summary.slug,
        title: detail.title,
        description: detail.description,
        ranked: detail.ranked,
        privacy: detail.privacy,
        truncated: detail.truncated,
        autoRequest: autoRequested.has(summary.id),
        autoRequestProblem: autoRequested.get(summary.id)?.problem ?? undefined,
        canAutoRequest: mayAutoRequest(user),
        items: titles.map((title) => ({
          plexId: title.plexId,
          title: title.title,
          year: title.year,
          tmdbId: title.tmdbId,
          mediaType: title.mediaType,
        })),
      });
    } catch (e) {
      return reply(e, next, 'read the Plex list');
    }
  }
);

plexRoutes.post<{ owner: string; slug: string }>(
  '/plex/:owner/:slug/copy',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const user = req.user as User;
      const api = await clientFor(req, next);
      if (!api) return;
      const summary = await ownPlexList(
        user.id,
        api,
        req.params.owner,
        req.params.slug
      );
      const { list, added, unmatched } = await copyPlexList(user, api, summary);
      return res
        .status(201)
        .json({ id: list.id, name: list.name, added, unmatched });
    } catch (e) {
      return reply(e, next, 'copy the Plex list');
    }
  }
);

plexRoutes.put<{ owner: string; slug: string }>(
  '/plex/:owner/:slug/auto-request',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const user = req.user as User;
      const enabled = req.body?.enabled === true;
      if (enabled && !mayAutoRequest(user)) {
        return next({
          status: 403,
          message: 'You are not allowed to have titles requested for you.',
        });
      }
      const api = await clientFor(req, next);
      if (!api) return;
      const summary = await ownPlexList(
        user.id,
        api,
        req.params.owner,
        req.params.slug
      );
      await setPlexListAutoRequest(user.id, api, summary, enabled);
      return res.status(200).json({ autoRequest: enabled });
    } catch (e) {
      return reply(e, next, 'change auto-request for the Plex list');
    }
  }
);

const changeItem =
  (change: 'add' | 'remove') =>
  async (
    req: Request<{ owner: string; slug: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const source = change === 'add' ? req.body : req.query;
      const tmdbId = Number(source?.tmdbId);
      const mediaType = mediaTypeOf(source?.mediaType);
      if (!Number.isInteger(tmdbId) || tmdbId < 1 || !mediaType) {
        return next({ status: 400, message: 'A title is required.' });
      }
      const user = req.user as User;
      const api = await clientFor(req as Request, next);
      if (!api) return;
      const summary = await ownPlexList(
        user.id,
        api,
        req.params.owner,
        req.params.slug
      );
      const request = await changePlexList(
        user,
        api,
        summary,
        change,
        tmdbId,
        mediaType
      );
      return change === 'add'
        ? res.status(201).json({
            added: true,
            ...(request && { request: forPerson(request) }),
          })
        : res.status(204).end();
    } catch (e) {
      return reply(
        e,
        next,
        change === 'add'
          ? 'add the title to the Plex list'
          : 'remove the title from the Plex list'
      );
    }
  };

plexRoutes.post<{ owner: string; slug: string }>(
  '/plex/:owner/:slug/item',
  isAuthenticated(),
  changeItem('add')
);

plexRoutes.delete<{ owner: string; slug: string }>(
  '/plex/:owner/:slug/item',
  isAuthenticated(),
  changeItem('remove')
);

export default plexRoutes;
