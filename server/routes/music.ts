import {
  MusicBrainzBusyError,
  isMbid,
  musicBrainz,
} from '@server/api/musicbrainz';
import { MediaType } from '@server/constants/media';
import mediaForViewer from '@server/lib/mediaForViewer';
import { mediaHistory } from '@server/lib/mediaHistory';
import { artistImages, musicImageUrl } from '@server/lib/music/artistImage';
import {
  albumLinks,
  albumStatuses,
  artistMedia,
  artistStatuses,
  markBeingAdded,
} from '@server/lib/music/library';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { requireMusic } from '@server/middleware/music';
import type {
  MusicAlbumResult,
  MusicPage,
  MusicSearchResponse,
} from '@server/models/Music';
import {
  mapAlbumDetails,
  mapAlbumResult,
  mapArtistDetails,
  mapArtistResult,
  mapTracks,
} from '@server/models/Music';
import type { NextFunction } from 'express';
import { Router } from 'express';

/*
 * Music to browse: search, artists, their albums and track lists, from
 * MusicBrainz; pictures from Lidarr's lookup, TheAudioDB and the Cover Art
 * Archive. Only once Lidarr is set up, and only for people with music on.
 *
 * MusicBrainz answers one request a second for the whole server. When it
 * would keep someone waiting too long, they are told it is busy (503) and
 * the page can try again.
 */
const musicRoutes = Router();

musicRoutes.use(requireMusic);

/** MusicBrainz lists this many of an artist's albums a page. */
const ALBUMS_PER_PAGE = 100;

const statusOf = (e: unknown): number | undefined =>
  (e as { response?: { status?: number } })?.response?.status;

/** A MusicBrainz failure, in words for the page and in the log. */
const mbFailed = (next: NextFunction, e: unknown, what: string) => {
  if (e instanceof MusicBrainzBusyError) {
    return next({ status: 503, message: e.message });
  }
  if (statusOf(e) === 404) {
    return next({ status: 404, message: `MusicBrainz has no such ${what}.` });
  }
  logger.warn(`MusicBrainz could not give a ${what}`, {
    label: 'Music',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return next({ status: 502, message: 'MusicBrainz did not answer.' });
};

// How much a search shows, and whether music can be searched anywhere at
// all, are an admin's choice (Settings → Music).
musicRoutes.get('/search', async (req, res, next) => {
  const search = getSettings().music.search;
  if (!search.inAll && !search.musicPage && !search.chip) {
    return next({ status: 403, message: 'Music search is turned off.' });
  }
  const query = String(req.query.query ?? '').trim();
  if (!query) {
    return res
      .status(200)
      .json({ artists: [], albums: [] } satisfies MusicSearchResponse);
  }
  try {
    const mb = musicBrainz();
    const [artists, albums] = await Promise.all([
      mb.searchArtists(query, { limit: search.artists }),
      mb.searchReleaseGroups(query, { limit: search.albums }),
    ]);
    const artistList = artists.artists ?? [];
    const albumList = albums['release-groups'] ?? [];
    const [knownArtists, knownAlbums] = await Promise.all([
      artistStatuses(artistList.map((a) => a.id)),
      albumStatuses(albumList.map((a) => a.id)),
    ]);
    return res.status(200).json({
      artists: artistList.map((a) => mapArtistResult(a, knownArtists)),
      albums: albumList.map((a) => mapAlbumResult(a, knownAlbums)),
    } satisfies MusicSearchResponse);
  } catch (e) {
    return mbFailed(next, e, 'search');
  }
});

musicRoutes.get<{ mbid: string }>('/artist/:mbid', async (req, res, next) => {
  const { mbid } = req.params;
  try {
    const mb = musicBrainz();
    const artist = await mb.getArtist(mbid);
    // The biography is a nicety: without it (a mirror that has none, a
    // busy queue) the page still shows.
    const biography = await mb.getWikipediaExtract(mbid).catch(() => null);
    const media = await artistMedia(mbid);
    return res.status(200).json(
      mapArtistDetails(artist, {
        biography,
        mediaInfo: mediaForViewer(media, req.user),
      })
    );
  } catch (e) {
    return mbFailed(next, e, 'artist');
  }
});

musicRoutes.get<{ mbid: string }>(
  '/artist/:mbid/albums',
  async (req, res, next) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    try {
      const found = await musicBrainz().getArtistReleaseGroups(
        req.params.mbid,
        { page: page - 1 }
      );
      const groups = found['release-groups'] ?? [];
      const statuses = await albumStatuses(groups.map((g) => g.id));
      const total = found['release-group-count'] ?? groups.length;
      return res.status(200).json({
        page,
        totalPages: Math.max(1, Math.ceil(total / ALBUMS_PER_PAGE)),
        totalResults: total,
        results: await markBeingAdded(
          groups.map((g) => mapAlbumResult(g, statuses))
        ),
      } satisfies MusicPage<MusicAlbumResult>);
    } catch (e) {
      return mbFailed(next, e, 'artist');
    }
  }
);

musicRoutes.get<{ mbid: string }>(
  '/artist/:mbid/image',
  async (req, res, next) => {
    try {
      const images = await artistImages(req.params.mbid);
      const image =
        req.query.kind === 'backdrop' ? images.backdrop : images.photo;
      if (!image) {
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return next({ status: 404, message: 'No picture of this artist.' });
      }
      // Kept by the browser for a day; the picture itself much longer.
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.redirect(302, musicImageUrl(image));
    } catch (e) {
      logger.warn('Could not find an artist’s picture', {
        label: 'Music',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return next({ status: 404, message: 'No picture of this artist.' });
    }
  }
);

/**
 * What has happened to an artist and their albums, newest first, for the
 * manage panel: requests, approvals, albums arriving or leaving. Kept by
 * the artist's MusicBrainz id, so it outlives Seerr's own record of them.
 */
musicRoutes.get<{ mbid: string }>(
  '/artist/:mbid/history',
  isAuthenticated([Permission.MANAGE_REQUESTS, Permission.ADMIN], {
    type: 'or',
  }),
  async (req, res, next) => {
    if (!isMbid(req.params.mbid)) {
      return next({ status: 400, message: 'Not a MusicBrainz id.' });
    }
    try {
      return res.status(200).json(
        await mediaHistory({
          mediaType: MediaType.MUSIC,
          foreignId: req.params.mbid,
        })
      );
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

musicRoutes.get<{ mbid: string }>('/album/:mbid', async (req, res, next) => {
  try {
    const group = await musicBrainz().getReleaseGroup(req.params.mbid);
    const artistId = group['artist-credit']?.[0]?.artist.id;
    const [statuses, media, playLinks] = await Promise.all([
      albumStatuses([group.id]),
      artistId ? artistMedia(artistId) : undefined,
      albumLinks(group.id),
    ]);
    const [album] = await markBeingAdded([
      mapAlbumDetails(group, {
        status: statuses.get(group.id),
        mediaInfo: mediaForViewer(media, req.user),
        playLinks,
      }),
    ]);
    return res.status(200).json(album);
  } catch (e) {
    return mbFailed(next, e, 'album');
  }
});

musicRoutes.get<{ mbid: string }>(
  '/album/:mbid/tracks',
  async (req, res, next) => {
    try {
      const media = await musicBrainz().getTracks(req.params.mbid);
      return res.status(200).json({ tracks: mapTracks(media) });
    } catch (e) {
      return mbFailed(next, e, 'album');
    }
  }
);

export default musicRoutes;
