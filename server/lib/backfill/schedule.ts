import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import type BackfillSeries from '@server/entity/BackfillSeries';
import type { BackfillKind } from '@server/entity/BackfillSeries';
import { MediaRequest } from '@server/entity/MediaRequest';

/*
 * Which titles a scan searches, and in what order: titles someone asked
 * for go first, oldest request first.
 */

/** A date from a raw query: SQLite gives UTC text with no zone on it. */
const utcDate = (value: string | Date) =>
  value instanceof Date
    ? value
    : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);

/**
 * How long a title whose last search failed (Prowlarr down, say) waits
 * before it is tried again, so it never holds a place in every scan.
 */
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * When each album was first asked for, by MusicBrainz id: its oldest
 * approved request still open. Albums nobody asked for are absent.
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
      // An album already here, in a request still open for others, is not.
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
 * When each title someone asked for was first asked for: the oldest request
 * approved and still open, by TMDB id. Titles nobody asked for are absent.
 */
export const requestedSince = async (
  rows: BackfillSeries[]
): Promise<Map<number, Date>> => {
  const since = new Map<number, Date>();
  const byKind = (kind: BackfillKind) =>
    rows
      .filter((row) => row.kind === kind && row.tmdbId)
      .map((row) => row.tmdbId!);
  // Albums asked for, by their MusicBrainz ids.
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
 * Which titles this scan searches, at most `searchesPerScan`. A title is
 * due when Backfill has never searched for it; when its last search failed
 * a day ago or more; or when nothing was found and `researchAfterDays` have
 * passed. Every search, found or not, restarts that wait, so the same few
 * titles never take every scan: each in turn goes to the back.
 *
 * Of those due, titles never searched come first, then ones searched
 * before. Within each, a title someone asked for goes ahead of one nobody
 * did (the oldest request first); then, of titles never searched, the one
 * missing most, and of the rest, the one that has waited longest.
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
