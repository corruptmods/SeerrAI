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
import { Router } from 'express';

const playlistRoutes = Router();

/** Links a playlist; its songs are read now, and requested for the linker. */
playlistRoutes.post<{ listId: string }>(
  '/:listId/link',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const access = await loadAccessibleList(
        Number(req.params.listId),
        req.user?.id as number
      );
      if (!access || access.list.kind !== 'music') {
        return next({ status: 404, message: 'Playlist not found.' });
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
      await playlists.link(access.list, String(req.body.url ?? ''), req.user!);
      const list = (await loadAccessibleList(access.list.id, req.user!.id))!;
      return res.status(200).json(await playlistView(list.list));
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
    const access = await loadAccessibleList(
      Number(req.params.listId),
      req.user?.id as number
    );
    if (!access || access.list.kind !== 'music') {
      return next({ status: 404, message: 'Playlist not found.' });
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
    const access = await loadAccessibleList(
      Number(req.params.listId),
      req.user?.id as number
    );
    if (!access || access.list.kind !== 'music') {
      return next({ status: 404, message: 'Playlist not found.' });
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
    const access = await loadAccessibleList(
      Number(req.params.listId),
      req.user?.id as number
    );
    if (!access || access.list.kind !== 'music') {
      return next({ status: 404, message: 'Playlist not found.' });
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
