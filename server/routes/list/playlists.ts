/**
 * Playlists: linking to a Spotify or Apple Music playlist, unlinking, and
 * removing songs.
 */
import { getRepository } from '@server/datasource';
import { MediaListSong } from '@server/entity/MediaList';
import { loadAccessibleList } from '@server/lib/listAccess';
import { searchAgainNow } from '@server/lib/music/songFetchWaits';
import playlists, { PlaylistLinkError } from '@server/lib/playlists';
import { PlaylistSourceError } from '@server/lib/playlists/sources';
import { musicAllowed, playlistView } from '@server/lib/playlists/view';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { perUserRateLimit } from '@server/middleware/perUserRateLimit';
import type { Request } from 'express';
import { Router } from 'express';
import { In } from 'typeorm';

const playlistRoutes = Router();

const NOT_FOUND = { status: 404, message: 'Playlist not found.' };

/** The playlist in the path, if the user may see it. */
const playlistFor = async (req: Request<{ listId: string }>) => {
  const access = await loadAccessibleList(
    Number(req.params.listId),
    req.user?.id as number
  );
  return access?.list.kind === 'music' ? access : null;
};

/**
 * Each link reads a Spotify or Apple Music page and can queue hundreds of
 * songs for MusicBrainz, which allows the whole server one request a second,
 * so links are rate limited and refused while many songs still wait.
 */
const linkRate = perUserRateLimit({ windowMs: 10 * 60_000, limit: 20 });
/** Each search queries every music indexer, so allow only a few per user. */
const searchAgainRate = perUserRateLimit({ windowMs: 10 * 60_000, limit: 5 });
/** Max songs a user may have awaiting a match before linking is refused. */
export const MOST_SONGS_MATCHING = 1000;

/** Links a playlist; its songs are read now and requested for the linker. */
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
      // Re-read as linked; missing if deleted meanwhile.
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

/** Unlinks a playlist; its songs stay. */
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
 * Removes a song; its request stands. On a linked playlist it is kept hidden
 * so re-reading the playlist doesn't bring it back.
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

/** Retries a song that wasn't found or couldn't be requested. */
playlistRoutes.post<{ listId: string; songId: string }>(
  '/:listId/song/:songId/retry',
  isAuthenticated(),
  async (req, res, next) => {
    const access = await playlistFor(req);
    if (!access) {
      return next(NOT_FOUND);
    }
    // Songs are requested in the owner's name.
    if (!access.isOwner) {
      return next({
        status: 403,
        message: 'Only the playlist’s owner can try its songs again.',
      });
    }
    if (!musicAllowed(req.user)) {
      return next({ status: 403, message: 'Music is turned off.' });
    }
    const song = await getRepository(MediaListSong).findOne({
      where: { id: Number(req.params.songId), listId: access.list.id },
    });
    if (!song) {
      return next({ status: 404, message: 'That song is not on it.' });
    }
    const refused = await playlists.retry(song);
    if (refused) {
      return next({ status: 403, message: refused });
    }
    return res.status(204).send();
  }
);

/**
 * Searches now for albums of requested songs that found nothing and would
 * otherwise wait hours. Returns how many.
 */
playlistRoutes.post<{ listId: string }>(
  '/:listId/search-again',
  isAuthenticated(),
  searchAgainRate,
  async (req, res, next) => {
    const access = await playlistFor(req);
    if (!access) {
      return next(NOT_FOUND);
    }
    if (!access.isOwner) {
      return next({
        status: 403,
        message: 'Only the playlist’s owner can search for its songs again.',
      });
    }
    // Requested, or approved by an admin after waiting.
    const songs = await getRepository(MediaListSong).find({
      select: { recordingMbid: true },
      where: {
        listId: access.list.id,
        state: In(['requested', 'approval']),
      },
    });
    const albums = await searchAgainNow(
      songs.flatMap((song) => (song.recordingMbid ? [song.recordingMbid] : []))
    );
    return res.status(200).json({ albums });
  }
);

export default playlistRoutes;
