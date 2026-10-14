import { albumCoverUrl } from '@server/api/coverartarchive';
import ListenBrainzAPI from '@server/api/listenbrainz';
import { isMbid } from '@server/api/musicbrainz';
import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MusicAlbum from '@server/entity/MusicAlbum';
import { albumStatuses, artistStatuses } from '@server/lib/music/library';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { requireMusic } from '@server/middleware/music';
import type {
  MusicAlbumResult,
  MusicArtistResult,
  MusicPage,
} from '@server/models/Music';
import {
  mapFreshRelease,
  mapTopArtist,
  mapTopReleaseGroup,
} from '@server/models/Music';
import type { NextFunction, Request } from 'express';
import { Router } from 'express';
import { IsNull, Not } from 'typeorm';

/*
 * Music's Discover rows. New releases and what is popular come from
 * ListenBrainz (switched off under Settings → Metadata → Music, they are
 * empty); Recently Added is what Seerr's own scans found. ListenBrainz
 * gives MusicBrainz ids and covers itself, so these cost MusicBrainz
 * nothing.
 */
const discoverMusicRoutes = Router();

discoverMusicRoutes.use(requireMusic);

export const MUSIC_PAGE_SIZE = 20;

/** How many of each list ListenBrainz is asked for. */
const LISTENBRAINZ_COUNT = 100;

const pageOf = (req: Request): number =>
  Math.max(1, Math.floor(Number(req.query.page)) || 1);

/** One page of a list worked out in full. */
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

/** Each album or artist once: ListenBrainz can list one more than once. */
const once = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
};

discoverMusicRoutes.get('/new-releases', async (req, res, next) => {
  const page = pageOf(req);
  if (!getSettings().music.listenBrainz) {
    return res.status(200).json(empty(page));
  }
  try {
    const found = await new ListenBrainzAPI().getFreshReleases({ days: 14 });
    const releases = (found.payload?.releases ?? [])
      .filter((release) => isMbid(release.release_group_mbid))
      // Newest first.
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

discoverMusicRoutes.get('/popular-albums', async (req, res, next) => {
  const page = pageOf(req);
  if (!getSettings().music.listenBrainz) {
    return res.status(200).json(empty(page));
  }
  try {
    const found = await new ListenBrainzAPI().getTopReleaseGroups({
      range: 'week',
      count: LISTENBRAINZ_COUNT,
    });
    const groups = (found.payload?.release_groups ?? []).filter(
      (group): group is typeof group & { release_group_mbid: string } =>
        isMbid(group.release_group_mbid)
    );
    const statuses = await albumStatuses(
      groups.map((g) => g.release_group_mbid)
    );
    return res
      .status(200)
      .json(
        paged(
          once(groups.map((g) => mapTopReleaseGroup(g, statuses))),
          page
        ) satisfies MusicPage<MusicAlbumResult>
      );
  } catch (e) {
    return listenBrainzFailed(next, e);
  }
});

discoverMusicRoutes.get('/popular-artists', async (req, res, next) => {
  const page = pageOf(req);
  if (!getSettings().music.listenBrainz) {
    return res.status(200).json(empty(page));
  }
  try {
    const found = await new ListenBrainzAPI().getTopArtists({
      range: 'week',
      count: LISTENBRAINZ_COUNT,
    });
    const artists = (found.payload?.artists ?? []).filter(
      (artist): artist is typeof artist & { artist_mbid: string } =>
        isMbid(artist.artist_mbid)
    );
    const statuses = await artistStatuses(artists.map((a) => a.artist_mbid));
    return res
      .status(200)
      .json(
        paged(
          once(artists.map((a) => mapTopArtist(a, statuses))),
          page
        ) satisfies MusicPage<MusicArtistResult>
      );
  } catch (e) {
    return listenBrainzFailed(next, e);
  }
});

/** Albums a media server has, newest first, from Seerr's own records. */
discoverMusicRoutes.get('/recently-added', async (req, res) => {
  const page = pageOf(req);
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
      media: { id: true, foreignId: true },
    },
    where: { status: MediaStatus.AVAILABLE, mbId: Not(IsNull()) },
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
      coverUrl: albumCoverUrl(album.mbId as string),
      status: album.status,
    })),
  } satisfies MusicPage<MusicAlbumResult>);
});

export default discoverMusicRoutes;
