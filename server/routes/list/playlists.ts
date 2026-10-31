/**
 * Playlists: linking one to a Spotify or Apple Music playlist, unlinking
 * it, and taking a song off.
 */
import { getRepository } from '@server/datasource';
import { MediaListSong } from '@server/entity/MediaList';
import { loadAccessibleList } from '@server/lib/listAccess';
import playlists, { PlaylistLinkError } from '@server/lib/playlists';
import { PlaylistSourceError } from '@server/lib/playlists/sources';
import { musicAllowed, playlistView } from '@server/lib/playlists/view';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { perUserRateLimit } from '@server/middleware/perUserRateLimit';
import type { Request } from 'express';
import { Router } from 'express';

const playlistRoutes = Router();

const NOT_FOUND = { status: 404, message: 'Playlist not found.' };

/** The playlist in the path, when this person may see it. */
const playlistFor = async (req: Request<{ listId: string }>) => {
  const access = await loadAccessibleList(
    Number(req.params.listId),
    req.user?.id as number
  );
  return access?.list.kind === 'music' ? access : null;
};

/**
 * Each link reads a page from Spotify or Apple Music, and brings in up to
 * hundreds of songs to look for on MusicBrainz, which answers the whole
 * server a request a second: so a person links only so many in a while,
 * and not while many of their songs are still waiting to be looked for.
 */
const linkRate = perUserRateLimit({ windowMs: 10 * 60_000, limit: 20 });
/** A person's songs waiting to be looked for, past which nothing is linked. */
export const MOST_SONGS_MATCHING = 1000;

/** Links a playlist; its songs are read now, and requested for the linker. */
playlistRoutes.post<{ listId: string }>(
  '/:listId/link',
  isAuthenticated(),
  linkRate,
  async (req, res, next) => {
    try {
      const access = await playlistFor(req);
      if (!access) {
        return next(NOT_FOUND);
      }
      if (!access.isOwner) {
        return next({
          status: 403,
          message: 'Only the playlist’s owner can link it.',
        });
      }
      if (!musicAllowed(req.user)) {
        return next({ status: 403, message: 'Music is turned off.' });
      }
      const matching = await getRepository(MediaListSong).count({
        where: { requestForId: req.user!.id, state: 'matching' },
      });
      if (matching >= MOST_SONGS_MATCHING) {
        return next({
          status: 429,
          message:
            'Songs from your playlists are still being looked for. Try again once they are found.',
        });
      }
      await playlists.link(access.list, String(req.body.url ?? ''), req.user!);
      // Read again as linked; gone if it was deleted meanwhile.
      const linked = await playlistFor(req);
      if (!linked) {
        return next(NOT_FOUND);
      }
      return res.status(200).json(await playlistView(linked.list));
    } catch (e) {
      if (e instanceof PlaylistLinkError || e instanceof PlaylistSourceError) {
        return next({ status: 400, message: e.message });
      }
      logger.error('Could not link a playlist', {
        label: 'API',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return next({ status: 500, message: 'Could not link the playlist.' });
    }
  }
);

/** Unlinks it; its songs stay. */
playlistRoutes.delete<{ listId: string }>(
  '/:listId/link',
  isAuthenticated(),
  async (req, res, next) => {
    const access = await playlistFor(req);
    if (!access) {
      return next(NOT_FOUND);
    }
    if (!access.isOwner) {
      return next({
        status: 403,
        message: 'Only the playlist’s owner can unlink it.',
      });
    }
    await playlists.unlink(access.list);
    return res.status(204).send();
  }
);

/**
 * Takes a song off; a request made for it stands. On a linked playlist it
 * is kept, out of sight, so reading the playlist again doesn't bring it
 * back.
 */
playlistRoutes.delete<{ listId: string; songId: string }>(
  '/:listId/song/:songId',
  isAuthenticated(),
  async (req, res, next) => {
    const access = await playlistFor(req);
    if (!access) {
      return next(NOT_FOUND);
    }
    const where = { id: Number(req.params.songId), listId: access.list.id };
    const result = access.list.sourceUrl
      ? await getRepository(MediaListSong).update(where, { state: 'removed' })
      : await getRepository(MediaListSong).delete(where);
    if (!result.affected) {
      return next({ status: 404, message: 'That song is not on it.' });
    }
    return res.status(204).send();
  }
);

/** Looks for a song that wasn't found, or couldn't be requested, again. */
playlistRoutes.post<{ listId: string; songId: string }>(
  '/:listId/song/:songId/retry',
  isAuthenticated(),
  async (req, res, next) => {
    const access = await playlistFor(req);
    if (!access) {
      return next(NOT_FOUND);
    }
    const song = await getRepository(MediaListSong).findOne({
      where: { id: Number(req.params.songId), listId: access.list.id },
    });
    if (!song) {
      return next({ status: 404, message: 'That song is not on it.' });
    }
    await playlists.retry(song);
    return res.status(204).send();
  }
);

export default playlistRoutes;
