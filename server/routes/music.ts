import {
  MusicBrainzBusyError,
  MusicBrainzUnwantedError,
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
import { pageOf } from '@server/lib/music/page';
import { songStandings } from '@server/lib/music/requestSongs';
import {
  rankAlbums,
  rankArtists,
  searchWhileTied,
} from '@server/lib/music/searchRank';
import { songFetchProblem } from '@server/lib/music/songFetchReady';
import { groupSongs, singleFor, toVersion } from '@server/lib/music/songs';
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
import type { NextFunction, Request } from 'express';
import { Router } from 'express';

/*
 * Music browsing (search, artists, albums, tracks) from MusicBrainz; pictures
 * from Lidarr's lookup, TheAudioDB and the Cover Art Archive. Only once Lidarr
 * is set up, for people with music on. MusicBrainz allows one request a second
 * server-wide; when the wait is too long the client gets 503 and can retry.
 */
const musicRoutes = Router();

musicRoutes.use(requireMusic);

const SEARCH_ARTISTS = 8;
const SEARCH_ALBUMS = 12;
const SEARCH_SONGS = 8;

/** Song search covers the artists of the top albums… */
const SONG_ARTISTS_FROM_ALBUMS = 3;
/** …and the top artists. */
const SONG_ARTISTS_FROM_ARTISTS = 2;

/*
 * Results fetched from MusicBrainz to rank from: one page each, plus further
 * pages (up to these limits) only while results tie on the top score.
 * MusicBrainz scores every exact match the same, so the intended album can be
 * far down (see lib/music/searchRank).
 */
const ARTIST_PAGE = 25;
const ARTIST_PAGES = 2;
const ALBUM_PAGE = 100;
const ALBUM_PAGES = 3;

/** MusicBrainz page size for an artist's albums. */
const ALBUMS_PER_PAGE = 100;

const statusOf = (e: unknown): number | undefined =>
  (e as { response?: { status?: number } })?.response?.status;

/** Report a MusicBrainz failure to the client and the log. */
const mbFailed = (next: NextFunction, e: unknown, what: string) => {
  if (e instanceof MusicBrainzUnwantedError) {
    // Superseded: the client already sent a newer search.
    return next({ status: 409, message: 'A newer search replaced this one.' });
  }
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

/*
 * Newest search per user and tab (X-Seerr-Tab header), else per user.
 * MusicBrainz allows one request a second server-wide, so a superseded search
 * is dropped while queued instead of delaying the current one; searches in
 * other tabs are unaffected. The song search counts as part of the same search.
 */
const newestSearch = new Map<string, string>();

/** Max tabs tracked; oldest evicted first. */
export const MOST_TABS = 1000;

const TAB = /^[\w-]{1,64}$/;

export const wantedSearch = (req: Request, query: string) => {
  const userId = req.user?.id;
  if (userId === undefined) return undefined;
  const tab = req.get('X-Seerr-Tab');
  const page = `${userId}:${tab && TAB.test(tab) ? tab : ''}`;
  const key = query.trim().toLowerCase();
  newestSearch.delete(page);
  newestSearch.set(page, key);
  if (newestSearch.size > MOST_TABS) {
    newestSearch.delete(newestSearch.keys().next().value as string);
  }
  // An evicted page wasn't superseded, so its search is still wanted.
  return () => (newestSearch.get(page) ?? key) === key;
};

/**
 * Artists and albums for a search, best first. Repeats within the hour (as the
 * song search makes) are served from cache.
 */
const searchArtistsAndAlbums = async (
  query: string,
  wanted?: () => boolean
) => {
  const mb = musicBrainz();
  const [artists, albums] = await Promise.all([
    searchWhileTied(
      async (offset) => {
        const page = await mb.searchArtists(query, {
          limit: ARTIST_PAGE,
          offset,
          wanted,
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
          wanted,
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
    const { artistList, albumList } = await searchArtistsAndAlbums(
      query,
      wantedSearch(req, query)
    );
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
 * Song search, when Settings → Music allows single-song requests: each with its
 * versions (radio edit, club mix…) and status. MusicBrainz scores every
 * recording of a title the same and hits have hundreds of covers, so recordings
 * are searched among the artists the same search finds: top albums' artists
 * first (a single is an album there), then top artists. Separate request so
 * artists and albums don't wait for it.
 */
musicRoutes.get('/search/songs', async (req, res, next) => {
  const query = String(req.query.query ?? '').trim();
  if (!query || !getSettings().music.songRequests) {
    return res
      .status(200)
      .json({ songs: [] } satisfies MusicSongSearchResponse);
  }
  try {
    const wanted = wantedSearch(req, query);
    const { artistList, albumList } = await searchArtistsAndAlbums(
      query,
      wanted
    );
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
    const found = await musicBrainz().searchRecordings(query, artistOrder, {
      wanted,
    });
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
    // Biography is optional: the page still loads without it (mirror lacks it,
    // queue busy).
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
    const page = pageOf(req.query.page);
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
      // Browser keeps this a day; the picture itself much longer.
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
 * Newest-first history of an artist and their albums for the manage panel:
 * requests, approvals, albums arriving or leaving. Keyed by MusicBrainz id, so
 * it outlives Seerr's own media rows.
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
      const mb = musicBrainz();
      const [tracks, group] = await Promise.all([
        mb.getTracks(req.params.mbid).then(mapTracks),
        mb.getReleaseGroup(req.params.mbid),
      ]);
      // Status: available with the album when all of it is, else as requested
      // (or as fetched from this album).
      const standing = await songStandings(
        tracks
          .filter((track) => track.recordingId)
          .map((track) => ({
            mbId: track.recordingId as string,
            releaseGroups: [{ mbId: group.id, title: group.title }],
          }))
      );
      for (const track of tracks) {
        Object.assign(track, standing.get(track.recordingId ?? ''));
      }
      // Without fetching songs from albums, a song on no single can't be
      // requested alone. Whether it's on one comes from the cached recording;
      // uncached ones are looked up in the background and the page polls again.
      if (songFetchProblem()) {
        await Promise.all(
          tracks.map(async (track) => {
            if (!isMbid(track.recordingId)) return;
            const recording = await mb.keptRecording(track.recordingId);
            if (recording === undefined) {
              track.checking = true;
              mb.getRecording(track.recordingId, 'background').catch(
                () => undefined
              );
              return;
            }
            const version = recording && toVersion(recording);
            if (!version || !singleFor(version)) {
              track.onlyOnAlbums = true;
            }
          })
        );
      }
      return res.status(200).json({ tracks });
    } catch (e) {
      return mbFailed(next, e, 'album');
    }
  }
);

export default musicRoutes;
