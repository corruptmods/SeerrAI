import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import type BackfillSeries from '@server/entity/BackfillSeries';
import type { BackfillKind } from '@server/entity/BackfillSeries';
import { MediaRequest } from '@server/entity/MediaRequest';

/*
 * Picks which titles a scan searches, and in what order: requested titles
 * first, oldest request first.
 */

/** A date from a raw query; SQLite returns UTC text with no zone. */
const utcDate = (value: string | Date) =>
  value instanceof Date
    ? value
    : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);

/**
 * Wait before retrying a title whose last search failed (e.g. Prowlarr
 * down), so it doesn't take a slot in every scan.
 */
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * First-requested date by album MusicBrainz id: its oldest open approved
 * request. Unrequested albums are absent.
 */
export const albumsAskedSince = async (
  mbids: string[]
): Promise<Map<string, Date>> => {
  const first = new Map<string, Date>();
  const ids = [...new Set(mbids.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 400) {
    const asked = await getRepository(AlbumRequest)
      .createQueryBuilder('album')
      .innerJoin('album.request', 'request')
      .select('album.albumMbid', 'mbid')
      .addSelect('MIN(request.createdAt)', 'first')
      .where('request.status = :status', {
        status: MediaRequestStatus.APPROVED,
      })
      // An album already available doesn't count, even if its request is open.
      .andWhere('album.status = :albumStatus', {
        albumStatus: MediaRequestStatus.APPROVED,
      })
      .andWhere('album.albumMbid IN (:...mbids)', {
        mbids: ids.slice(i, i + 400),
      })
      .groupBy('album.albumMbid')
      .getRawMany<{ mbid: string; first: string | Date }>();
    for (const a of asked) first.set(a.mbid, utcDate(a.first));
  }
  return first;
};

/**
 * First-requested date by row id: the oldest open approved request.
 * Unrequested titles are absent.
 */
export const requestedSince = async (
  rows: BackfillSeries[]
): Promise<Map<number, Date>> => {
  const since = new Map<number, Date>();
  const byKind = (kind: BackfillKind) =>
    rows
      .filter((row) => row.kind === kind && row.tmdbId)
      .map((row) => row.tmdbId!);
  const albums = rows.filter((row) => row.kind === 'album' && row.foreignId);
  const firstByMbid = await albumsAskedSince(
    albums.map((row) => row.foreignId!)
  );
  for (const row of albums) {
    const first = firstByMbid.get(row.foreignId!);
    if (first) since.set(row.id, first);
  }
  for (const kind of ['series', 'movie'] as const) {
    const tmdbIds = byKind(kind);
    if (!tmdbIds.length) continue;
    const requests = await getRepository(MediaRequest)
      .createQueryBuilder('request')
      .innerJoin('request.media', 'media')
      .select('media.tmdbId', 'tmdbId')
      .addSelect('MIN(request.createdAt)', 'first')
      .where('request.status = :status', {
        status: MediaRequestStatus.APPROVED,
      })
      .andWhere('request.is4k = :is4k', { is4k: false })
      .andWhere('media.mediaType = :type', {
        type: kind === 'movie' ? MediaType.MOVIE : MediaType.TV,
      })
      .andWhere('media.tmdbId IN (:...tmdbIds)', { tmdbIds })
      .groupBy('media.tmdbId')
      .getRawMany<{ tmdbId: number | string; first: string | Date }>();
    const firstById = new Map(
      requests.map((r) => [Number(r.tmdbId), utcDate(r.first)])
    );
    for (const row of rows) {
      const first =
        row.kind === kind && row.tmdbId ? firstById.get(row.tmdbId) : undefined;
      if (first) since.set(row.id, first);
    }
  }
  return since;
};

/**
 * The titles this scan searches, at most `searchesPerScan`. A title is due
 * if never searched, if its last search failed a day or more ago, or if
 * nothing was found and `researchAfterDays` have passed. Every search
 * restarts the wait, so each title in turn goes to the back.
 *
 * Never-searched titles come first. Within each group, requested titles go
 * first (oldest request first); then never-searched ones by most missing,
 * the rest by longest wait.
 */
export const pickSearches = (
  due: BackfillSeries[],
  requested: Map<number, Date>,
  settings: { searchesPerScan: number; researchAfterDays: number },
  now = Date.now()
): BackfillSeries[] => {
  const waitFor = (row: BackfillSeries) =>
    row.status === 'stuck'
      ? RETRY_FAILED_AFTER_MS
      : settings.researchAfterDays * 86_400_000;
  const eligible = due.filter(
    (row) =>
      !row.lastSearchedAt || now - row.lastSearchedAt.getTime() >= waitFor(row)
  );
  const asked = (row: BackfillSeries) =>
    requested.get(row.id)?.getTime() ?? Infinity;
  return eligible
    .sort(
      (a, b) =>
        Number(!!a.lastSearchedAt) - Number(!!b.lastSearchedAt) ||
        asked(a) - asked(b) ||
        (a.lastSearchedAt?.getTime() ?? 0) -
          (b.lastSearchedAt?.getTime() ?? 0) ||
        b.missing - a.missing ||
        a.id - b.id
    )
    .slice(0, settings.searchesPerScan);
};

/**
 * TMDB ids of movies and series requested since `since`, approved and still
 * open: searched right after their arr finds nothing.
 */
export const freshRequests = async (
  since: number
): Promise<{ movie: Set<number>; tv: Set<number> }> => {
  const rows = await getRepository(MediaRequest)
    .createQueryBuilder('request')
    .innerJoin('request.media', 'media')
    .select('media.tmdbId', 'tmdbId')
    .addSelect('media.mediaType', 'mediaType')
    .where('request.status = :status', {
      status: MediaRequestStatus.APPROVED,
    })
    .andWhere('request.is4k = :is4k', { is4k: false })
    .andWhere('request.createdAt >= :since', { since: new Date(since) })
    .getRawMany<{ tmdbId: number | string; mediaType: MediaType }>();
  const fresh = { movie: new Set<number>(), tv: new Set<number>() };
  for (const row of rows) {
    if (row.mediaType === MediaType.MOVIE) fresh.movie.add(Number(row.tmdbId));
    if (row.mediaType === MediaType.TV) fresh.tv.add(Number(row.tmdbId));
  }
  return fresh;
};
