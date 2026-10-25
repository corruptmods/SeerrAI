import {
  MusicBrainzBusyError,
  isMbid,
  musicBrainz,
} from '@server/api/musicbrainz';
import { MediaType, VARIOUS_ARTISTS_MBID } from '@server/constants/media';
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
import { songStandings } from '@server/lib/music/requestSongs';
import {
  rankAlbums,
  rankArtists,
  searchWhileTied,
} from '@server/lib/music/searchRank';
import { songFetchProblem } from '@server/lib/music/songFetchReady';
import { groupSongs } from '@server/lib/music/songs';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { requireMusic } from '@server/middleware/music';
import type {
  MusicAlbumResult,
  MusicPage,
  MusicSearchResponse,
  MusicSongSearchResponse,
} from '@server/models/Music';
import {
  mapAlbumDetails,
  mapAlbumResult,
  mapArtistDetails,
  mapArtistResult,
  mapSongResult,
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

const SEARCH_ARTISTS = 8;
const SEARCH_ALBUMS = 12;
const SEARCH_SONGS = 8;

/** Whose songs a search looks among: the artists of the best albums… */
const SONG_ARTISTS_FROM_ALBUMS = 3;
/** …and the best artists. */
const SONG_ARTISTS_FROM_ARTISTS = 2;

/*
 * How many a search asks MusicBrainz for, to pick the ones shown from: a
 * page of each, and further pages (up to these many) only while the
 * results are still tied on the top score. MusicBrainz scores every exact
 * match the same, so the album most people mean can be far down its list
 * (see lib/music/searchRank).
 */
const ARTIST_PAGE = 25;
const ARTIST_PAGES = 2;
const ALBUM_PAGE = 100;
const ALBUM_PAGES = 3;

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

/**
 * The artists and albums a search shows, best first. The same search asked
 * again within the hour (as the songs below ask it) is answered from
 * memory.
 */
const searchArtistsAndAlbums = async (query: string) => {
  const mb = musicBrainz();
  const [artists, albums] = await Promise.all([
    searchWhileTied(
      async (offset) => {
        const page = await mb.searchArtists(query, {
          limit: ARTIST_PAGE,
          offset,
        });
        return { count: page.count, items: page.artists ?? [] };
      },
      { pageSize: ARTIST_PAGE, maxPages: ARTIST_PAGES }
    ),
    searchWhileTied(
      async (offset) => {
        const page = await mb.searchReleaseGroups(query, {
          limit: ALBUM_PAGE,
          offset,
        });
        return { count: page.count, items: page['release-groups'] ?? [] };
      },
      { pageSize: ALBUM_PAGE, maxPages: ALBUM_PAGES }
    ),
  ]);
  const albumList = rankAlbums(albums, SEARCH_ALBUMS);
  const artistList = rankArtists(artists, albumList, SEARCH_ARTISTS);
  return { artistList, albumList };
};

musicRoutes.get('/search', async (req, res, next) => {
  const query = String(req.query.query ?? '').trim();
  if (!query) {
    return res
      .status(200)
      .json({ artists: [], albums: [] } satisfies MusicSearchResponse);
  }
  try {
    const { artistList, albumList } = await searchArtistsAndAlbums(query);
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

/*
 * Songs, once Settings → Music lets them be asked for one at a time: each
 * with its versions (the radio edit, the club mix…), and where each stands.
 *
 * MusicBrainz scores every recording of a title the same, and a hit has
 * hundreds of covers, so its recordings are searched among the artists
 * the same search finds: those of the best albums first (a song's single
 * is an album there), then the best artists. Its own request, so artists
 * and albums are shown without waiting for it.
 */
musicRoutes.get('/search/songs', async (req, res, next) => {
  const query = String(req.query.query ?? '').trim();
  if (!query || !getSettings().music.songRequests) {
    return res
      .status(200)
      .json({ songs: [] } satisfies MusicSongSearchResponse);
  }
  try {
    const { artistList, albumList } = await searchArtistsAndAlbums(query);
    const artistOrder = [
      ...new Set([
        ...albumList
          .slice(0, SONG_ARTISTS_FROM_ALBUMS)
          .map((album) => album['artist-credit']?.[0]?.artist.id),
        ...artistList
          .slice(0, SONG_ARTISTS_FROM_ARTISTS)
          .map((artist) => artist.id),
      ]),
    ].filter((id): id is string => isMbid(id) && id !== VARIOUS_ARTISTS_MBID);
    if (!artistOrder.length) {
      return res
        .status(200)
        .json({ songs: [] } satisfies MusicSongSearchResponse);
    }
    const found = await musicBrainz().searchRecordings(query, artistOrder);
    const songs = groupSongs(found.recordings ?? [], query, artistOrder, {
      songs: SEARCH_SONGS,
    });
    const standing = await songStandings(
      songs.flatMap((song) => song.versions)
    );
    return res.status(200).json({
      songs: songs.map((song) =>
        mapSongResult(song, standing, !songFetchProblem())
      ),
    } satisfies MusicSongSearchResponse);
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
      const tracks = mapTracks(await musicBrainz().getTracks(req.params.mbid));
      // Where each stands, once songs can be asked for one at a time.
      if (getSettings().music.songRequests) {
        const standing = await songStandings(
          tracks
            .filter((track) => track.recordingId)
            .map((track) => ({
              mbId: track.recordingId as string,
              releaseGroups: [],
            }))
        );
        for (const track of tracks) {
          Object.assign(track, standing.get(track.recordingId ?? ''));
        }
      }
      return res.status(200).json({ tracks });
    } catch (e) {
      return mbFailed(next, e, 'album');
    }
  }
);

export default musicRoutes;
