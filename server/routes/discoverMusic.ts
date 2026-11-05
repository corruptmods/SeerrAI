import { albumCoverUrl } from '@server/api/coverartarchive';
import ListenBrainzAPI from '@server/api/listenbrainz';
import { isMbid } from '@server/api/musicbrainz';
import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MusicAlbum from '@server/entity/MusicAlbum';
import type { ChartSong } from '@server/lib/music/charts';
import { chartArtists, charts, trending } from '@server/lib/music/charts';
import { albumStatuses, artistStatuses } from '@server/lib/music/library';
import { pageOf } from '@server/lib/music/page';
import {
  artistsLikeYours,
  moreFromYourArtists,
  yourMusicRequests,
} from '@server/lib/music/personalRows';
import { songStandings } from '@server/lib/music/requestSongs';
import { songFetchProblem } from '@server/lib/music/songFetchReady';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { requireMusic } from '@server/middleware/music';
import type {
  MusicAlbumResult,
  MusicArtistResult,
  MusicPage,
  MusicSongResult,
} from '@server/models/Music';
import { mapFreshRelease, mapSongResult } from '@server/models/Music';
import type { NextFunction } from 'express';
import { Router } from 'express';
import { In, IsNull, Not } from 'typeorm';

/*
 * Music Discover rows. New releases from ListenBrainz, charts (Top Songs,
 * Trending, Top Albums, Top Artists) from Apple Music; both empty when Settings
 * → Music (New and Popular Music) is off. Recently Added comes from Seerr's own
 * scans.
 */
const discoverMusicRoutes = Router();

discoverMusicRoutes.use(requireMusic);

export const MUSIC_PAGE_SIZE = 20;

/** One page of a fully computed list. */
const paged = <T>(items: T[], page: number): MusicPage<T> => ({
  page,
  totalPages: Math.max(1, Math.ceil(items.length / MUSIC_PAGE_SIZE)),
  totalResults: items.length,
  results: items.slice((page - 1) * MUSIC_PAGE_SIZE, page * MUSIC_PAGE_SIZE),
});

const empty = <T>(page: number): MusicPage<T> => ({
  page,
  totalPages: 1,
  totalResults: 0,
  results: [],
});

const listenBrainzFailed = (next: NextFunction, e: unknown) => {
  logger.warn('ListenBrainz did not answer', {
    label: 'Music',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return next({ status: 502, message: 'ListenBrainz did not answer.' });
};

/** Dedupe by id: ListenBrainz can list an item more than once. */
const once = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
};

discoverMusicRoutes.get('/new-releases', async (req, res, next) => {
  const page = pageOf(req.query.page);
  if (!getSettings().music.listenBrainz) {
    return res.status(200).json(empty(page));
  }
  try {
    const found = await new ListenBrainzAPI().getFreshReleases({ days: 14 });
    const releases = (found.payload?.releases ?? [])
      .filter((release) => isMbid(release.release_group_mbid))
      .sort((a, b) =>
        (b.release_date ?? '').localeCompare(a.release_date ?? '')
      );
    const statuses = await albumStatuses(
      releases.map((r) => r.release_group_mbid)
    );
    return res
      .status(200)
      .json(
        paged(
          once(releases.map((r) => mapFreshRelease(r, statuses))),
          page
        ) satisfies MusicPage<MusicAlbumResult>
      );
  } catch (e) {
    return listenBrainzFailed(next, e);
  }
});

/** Report an Apple Music charts failure. */
const chartsFailed = (next: NextFunction, e: unknown) => {
  logger.warn('Apple Music’s charts did not answer', {
    label: 'Music',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return next({ status: 502, message: 'Apple Music’s charts did not answer.' });
};

/** Chart songs as rows, with their status here. */
const songRows = async (
  songs: ChartSong[],
  page: number
): Promise<MusicPage<MusicSongResult>> => {
  const shown = paged(songs, page);
  const standing = await songStandings(
    shown.results.flatMap(({ song }) => song.versions)
  );
  const songsOn = getSettings().music.songRequests;
  return {
    ...shown,
    results: shown.results.map(({ song }) => ({
      ...mapSongResult(song, standing, !songFetchProblem()),
      ...(songsOn ? {} : { canRequest: false as const }),
    })),
  };
};

/*
 * Apple Music charts for the Discover region (lib/music/charts): most-played
 * songs and albums, the songs among them released in the last month, and their
 * artists. Each row shows what's matched to MusicBrainz so far; the rest are
 * matched in the background and show on a later visit.
 */
discoverMusicRoutes.get('/top-songs', async (req, res, next) => {
  const page = pageOf(req.query.page);
  if (!getSettings().music.listenBrainz) {
    return res.status(200).json(empty(page));
  }
  try {
    return res.status(200).json(await songRows((await charts()).songs, page));
  } catch (e) {
    return chartsFailed(next, e);
  }
});

discoverMusicRoutes.get('/trending', async (req, res, next) => {
  const page = pageOf(req.query.page);
  if (!getSettings().music.listenBrainz) {
    return res.status(200).json(empty(page));
  }
  try {
    return res
      .status(200)
      .json(await songRows(trending((await charts()).songs), page));
  } catch (e) {
    return chartsFailed(next, e);
  }
});

discoverMusicRoutes.get('/popular-albums', async (req, res, next) => {
  const page = pageOf(req.query.page);
  if (!getSettings().music.listenBrainz) {
    return res.status(200).json(empty(page));
  }
  try {
    const { albums } = await charts();
    const statuses = await albumStatuses(albums.map((album) => album.id));
    return res.status(200).json(
      paged(
        albums.map(
          (album): MusicAlbumResult => ({
            mediaType: 'album',
            ...album,
            coverUrl: albumCoverUrl(album.id),
            status: statuses.get(album.id),
          })
        ),
        page
      ) satisfies MusicPage<MusicAlbumResult>
    );
  } catch (e) {
    return chartsFailed(next, e);
  }
});

discoverMusicRoutes.get('/popular-artists', async (req, res, next) => {
  const page = pageOf(req.query.page);
  if (!getSettings().music.listenBrainz) {
    return res.status(200).json(empty(page));
  }
  try {
    const artists = chartArtists(await charts());
    const statuses = await artistStatuses(artists.map((a) => a.id));
    return res.status(200).json(
      paged(
        artists.map(
          (artist): MusicArtistResult => ({
            mediaType: 'artist',
            id: artist.id,
            name: artist.name,
            status: statuses.get(artist.id),
          })
        ),
        page
      ) satisfies MusicPage<MusicArtistResult>
    );
  } catch (e) {
    return chartsFailed(next, e);
  }
});

/*
 * Personal rows from the music this person has requested (see
 * lib/music/personalRows): only theirs, empty if they've requested none.
 */
for (const [show, row] of [
  ['your-requests', yourMusicRequests],
  ['more-from-your-artists', moreFromYourArtists],
  ['artists-like-yours', artistsLikeYours],
] as const) {
  discoverMusicRoutes.get(`/${show}`, async (req, res, next) => {
    const page = pageOf(req.query.page);
    if (!req.user) {
      return res.status(200).json(empty(page));
    }
    try {
      return res
        .status(200)
        .json(
          paged<MusicAlbumResult | MusicArtistResult>(
            await row(req.user.id),
            page
          )
        );
    } catch (e) {
      logger.warn('Could not make a person’s music row', {
        label: 'Music',
        row: show,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return next({ status: 502, message: 'Could not make this row.' });
    }
  });
}

/**
 * Albums a media server has wholly or partly (songs taken from them), newest
 * first, from Seerr's own records.
 */
discoverMusicRoutes.get('/recently-added', async (req, res) => {
  const page = pageOf(req.query.page);
  const [albums, total] = await getRepository(MusicAlbum).findAndCount({
    relations: { media: true },
    select: {
      id: true,
      mbId: true,
      title: true,
      primaryType: true,
      secondaryTypes: true,
      releaseDate: true,
      status: true,
      mediaAddedAt: true,
      media: { id: true, foreignId: true, foreignTitle: true },
    },
    where: {
      status: In([MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE]),
      mbId: Not(IsNull()),
    },
    order: {
      mediaAddedAt: { direction: 'DESC', nulls: 'LAST' },
      id: 'DESC',
    },
    skip: (page - 1) * MUSIC_PAGE_SIZE,
    take: MUSIC_PAGE_SIZE,
  });
  return res.status(200).json({
    page,
    totalPages: Math.max(1, Math.ceil(total / MUSIC_PAGE_SIZE)),
    totalResults: total,
    results: albums.map((album) => ({
      mediaType: 'album',
      id: album.mbId as string,
      title: album.title,
      primaryType: album.primaryType ?? undefined,
      secondaryTypes: album.secondaryTypes ?? [],
      releaseDate: album.releaseDate ?? undefined,
      artistId: album.media?.foreignId ?? undefined,
      // Name from music scans, so the row needs no MusicBrainz lookup.
      artistName: album.media?.foreignTitle ?? undefined,
      coverUrl: albumCoverUrl(album.mbId as string),
      status: album.status,
    })),
  } satisfies MusicPage<MusicAlbumResult>);
});

export default discoverMusicRoutes;
