import type { JellyfinMatchItem } from '@server/api/jellyfin';
import type { PlexLibraryItem, PlexMusicItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import type { MatchNotice } from '@server/entity/MatchWatch';
import { MatchProblem, MatchWatch } from '@server/entity/MatchWatch';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import type { ImportedDownload, MatchWait } from '@server/lib/downloadtracker';
import downloadTracker from '@server/lib/downloadtracker';
import { plexMatchText } from '@server/lib/health';
import {
  connectedServers,
  jellyfinClient,
  jellyfinFamily,
  serverName,
} from '@server/lib/mediaServers';
import { lidarrApi, musicReady } from '@server/lib/music/access';
import type { ServerAlbum } from '@server/lib/music/matcher';
import {
  folderName as musicFolderName,
  normalizeName,
  parentPath,
} from '@server/lib/music/matcher';
import notificationManager, { Notification } from '@server/lib/notifications';
import { wrongMatchEvent } from '@server/lib/notifications/eventTitles';
import { autoFix, canFix, fixingAuto } from '@server/lib/plexFixMatch';
import type {
  Expected,
  MatchItem,
  MediaServerName,
  PlexMatchProblem,
  PlexMatchReport,
} from '@server/lib/plexMatchCheck';
import plexMatchCheck, {
  compareMatch,
  folderName,
  jellyfinMatchItem,
  plexMatchItem,
  problemKey,
  radarrFileFacts,
} from '@server/lib/plexMatchCheck';
import { providerId } from '@server/lib/scanners/music/jellyfin';
import { plexMbid } from '@server/lib/scanners/music/plex';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { MatchKind } from '@server/utils/plexMatch';
import { In, IsNull, LessThanOrEqual, MoreThanOrEqual, Not } from 'typeorm';

/*
 * Catches wrong matches as they happen. After Radarr, Sonarr or Lidarr
 * imports a requested title, each media server that should hold it is
 * checked: the item in the imported folder, its ids against the *arr's (as
 * the nightly Match Check does). A request stuck at "Adding to Plex" is
 * usually the server filing it under another title.
 *
 * Servers take minutes to scan and match, so checks back off over about two
 * hours. A match to another title is reported at once; "not matched" only if
 * it persists to the last check. Admins hear of each problem once ever:
 * problems found close together share one message, capped at DAILY_MESSAGES
 * a day; the rest show only on the Health page and the next message counts
 * them. A problem put right clears silently. Requesters are never told;
 * their request shows a waiting line instead.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Check times after the import; "not matched" is reported only after about two
 * hours.
 */
export const LOOKS_AT_MS = [2, 7, 22, 52, 112].map((m) => m * MINUTE_MS);

/** Problems found within this long of the first share one message. */
export const GATHER_MS = 10 * MINUTE_MS;

/** Max messages in any 24 hours. */
export const DAILY_MESSAGES = 5;

/** How often an open problem is rechecked. */
export const RECHECK_MS = 6 * HOUR_MS;

/** Titles checked per run, so a burst of imports is spread out. */
const PER_RUN = 25;

/** Max nightly problems auto-fixed in Plex per night. */
const AUTO_PER_NIGHT = 20;

/** Newest items per library searched for the imported one. */
const NEWEST = 100;

/** Max Plex albums per run whose tracks are read to find their folder. */
const PLEX_ALBUM_LOOKUPS = 40;

/** Problems named in one message before "and N more". */
const NAMED = 8;

/** Timeout for one media server or Lidarr call. */
const TIMEOUT_MS = 20_000;

type Verdict =
  /** On the server, matched to the right title. */
  | { state: 'right' }
  /** Certainly matched to another title. */
  | { state: 'wrong'; problem: PlexMatchProblem }
  /** On the server, not matched yet. */
  | { state: 'unmatched'; problem: PlexMatchProblem }
  /** Not on the server yet, or no ids to compare. */
  | { state: 'unknown' }
  /** The *arr no longer has it. */
  | { state: 'gone' };

/** Lidarr's album, shaped like a film's Expected plus its ids. */
interface ExpectedAlbum {
  title: string;
  year?: number;
  server: string;
  mbid: string;
  releaseIds: string[];
  artist?: string;
  artistMbid?: string;
}

/** What Radarr, Sonarr or Lidarr has for one import. */
type ArrSide =
  | { kind: 'movie' | 'series'; folder: string; expected: Expected }
  | { kind: 'music'; folder: string; expected: ExpectedAlbum }
  | 'gone';

const statusOf = (e: unknown): number | undefined => {
  const err = e as {
    response?: { status?: number };
    cause?: { response?: { status?: number } };
  };
  return err?.response?.status ?? err?.cause?.response?.status;
};

const yearOf = (date?: string | null): number | undefined => {
  const year = Number((date ?? '').slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : undefined;
};

const titled = (t: { title: string; year?: number }) =>
  t.year ? `${t.title} (${t.year})` : t.title;

/** True when either title contains the other, e.g. a longer edition's. */
const titlesClose = (a?: string, b?: string): boolean => {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return !x || !y || x.includes(y) || y.includes(x);
};

/**
 * For albums without a trustworthy MusicBrainz id: different only when the
 * title differs and the artist differs or the year is more than one apart.
 */
const clearlyAnotherAlbum = (
  expected: ExpectedAlbum,
  album: ServerAlbum
): boolean => {
  if (titlesClose(expected.title, album.title)) return false;
  const artistDiffers = !titlesClose(expected.artist, album.artistName);
  const yearDiffers =
    !!expected.year && !!album.year && Math.abs(expected.year - album.year) > 1;
  return artistDiffers || yearDiffers;
};

/** Whether a server's album is Lidarr's, by ids or names. */
export const compareAlbum = (
  expected: ExpectedAlbum,
  album: ServerAlbum,
  mediaServer: MediaServerName,
  folder: string
): Verdict => {
  const problem = (): Verdict => ({
    state: 'wrong',
    problem: {
      kind: 'music',
      folder,
      expected: {
        title: expected.title,
        year: expected.year,
        server: expected.server,
        mbid: expected.mbid,
        artist: expected.artist,
        artistMbid: expected.artistMbid,
      },
      mediaServer,
      matched: {
        title: album.title,
        year: album.year,
        key: album.itemId,
        mbid: album.releaseGroupId ?? album.releaseOrGroupId ?? album.releaseId,
        artist: album.artistName,
      },
      reason: 'other',
    },
  });
  // Jellyfin and Emby give the release group.
  if (album.releaseGroupId) {
    return album.releaseGroupId === expected.mbid
      ? { state: 'right' }
      : problem();
  }
  // A release id (Plex's may be either): another release of the same album is
  // not a wrong match, and Lidarr may not list them all, so names must agree
  // too.
  const ids = [album.releaseId, album.releaseOrGroupId].filter(
    (id): id is string => !!id
  );
  if (
    ids.some((id) => id === expected.mbid || expected.releaseIds.includes(id))
  ) {
    return { state: 'right' };
  }
  return clearlyAnotherAlbum(expected, album) ? problem() : { state: 'right' };
};

/** Servers whose libraries should hold this kind of title. */
const serversFor = (kind: MatchKind): MediaServerKind[] =>
  connectedServers().filter((server) => {
    const settings =
      server === 'plex' ? getSettings().plex : jellyfinFamily(server);
    if (kind === 'music') {
      return (
        musicReady() &&
        (settings.musicLibraries ?? []).some((library) => library.enabled)
      );
    }
    const type = kind === 'movie' ? 'movie' : 'show';
    return settings.libraries.some(
      (library) => library.enabled && library.type === type
    );
  });

const kindOfServer = (name: MediaServerName): MediaServerKind =>
  name === 'Plex' ? 'plex' : name === 'Emby' ? 'emby' : 'jellyfin';

/**
 * Shares a "recently added since" read between titles; re-reads for a title
 * imported before the read's start, which it may have missed.
 */
const sinceShared = <T>(
  cache: Map<string, { since: number; read: Promise<T> }>,
  key: string,
  since: Date,
  read: () => Promise<T>
): Promise<T> => {
  const cached = cache.get(key);
  if (cached && cached.since <= since.getTime()) return cached.read;
  const fresh = { since: since.getTime(), read: read() };
  cache.set(key, fresh);
  return fresh.read;
};

/**
 * One run's cache, so titles on the same server share a read of its newest
 * items.
 */
class Reading {
  private lists = new Map<
    string,
    { since: number; read: Promise<MatchItem[]> }
  >();
  private albums = new Map<
    string,
    { since: number; read: Promise<ServerAlbum[]> }
  >();
  private plex?: Promise<PlexAPI>;
  private plexAlbumLookups = 0;

  public plexClient(): Promise<PlexAPI> {
    this.plex ??= getRepository(User)
      .findOne({ select: { id: true, plexToken: true }, where: { id: 1 } })
      .then(
        (admin) =>
          new PlexAPI({ plexToken: admin?.plexToken, timeout: TIMEOUT_MS })
      );
    return this.plex;
  }

  /** A server's newest films or series, with folders and ids. */
  public newest(
    server: MediaServerKind,
    kind: 'movie' | 'series',
    since: Date
  ): Promise<MatchItem[]> {
    return sinceShared(this.lists, `${server}:${kind}`, since, () =>
      this.readNewest(server, kind, since)
    );
  }

  private async readNewest(
    server: MediaServerKind,
    kind: 'movie' | 'series',
    since: Date
  ): Promise<MatchItem[]> {
    const type = kind === 'movie' ? 'movie' : 'show';
    if (server === 'plex') {
      const plex = await this.plexClient();
      const items: MatchItem[] = [];
      for (const library of getSettings().plex.libraries) {
        if (!library.enabled || library.type !== type) continue;
        // Start a little before the import: the server adds it after the *arr
        // does, and clocks differ.
        const added = await plex.getRecentlyAdded(
          library.id,
          { addedAt: since.getTime() - HOUR_MS },
          type
        );
        if (kind === 'movie') {
          items.push(
            ...added.slice(0, NEWEST).map((i) => plexMatchItem(kind, i))
          );
          continue;
        }
        // Series come back as new episodes; their shows carry folders and ids.
        const shows = [
          ...new Set(
            added.flatMap((episode) =>
              episode.grandparentRatingKey ? [episode.grandparentRatingKey] : []
            )
          ),
        ].slice(0, 30);
        for (const show of shows) {
          const item = await plex.getMatchItem(show);
          if (item) items.push(plexMatchItem(kind, item));
        }
      }
      return items;
    }
    const api = await jellyfinClient(server);
    const items: MatchItem[] = [];
    for (const library of jellyfinFamily(server).libraries) {
      if (!library.enabled || library.type !== type) continue;
      const newest = await api.getMatchItems(
        {
          libraryId: library.id,
          type: kind === 'movie' ? 'Movie' : 'Episode',
          newest: NEWEST,
        },
        TIMEOUT_MS
      );
      if (kind === 'movie') {
        items.push(...newest.map((i) => jellyfinMatchItem(kind, i)));
        continue;
      }
      const ids = [
        ...new Set(newest.flatMap((e) => (e.SeriesId ? [e.SeriesId] : []))),
      ];
      if (!ids.length) continue;
      const series = await api.getMatchItems({ ids }, TIMEOUT_MS);
      items.push(...series.map((i) => jellyfinMatchItem(kind, i)));
    }
    return items;
  }

  /** One film or series by server id; undefined once gone. */
  public async item(
    server: MediaServerKind,
    kind: 'movie' | 'series',
    key: string
  ): Promise<MatchItem | undefined> {
    if (server === 'plex') {
      const item = await (await this.plexClient()).getMatchItem(key);
      return item ? plexMatchItem(kind, item as PlexLibraryItem) : undefined;
    }
    const api = await jellyfinClient(server);
    const [item] = await api.getMatchItems({ ids: [key] }, TIMEOUT_MS);
    return item ? jellyfinMatchItem(kind, item) : undefined;
  }

  /** A server's newest albums, with folders and MusicBrainz ids. */
  public newestAlbums(
    server: MediaServerKind,
    since: Date
  ): Promise<ServerAlbum[]> {
    return sinceShared(this.albums, server, since, () =>
      this.readAlbums(server, since)
    );
  }

  private async readAlbums(
    server: MediaServerKind,
    since: Date
  ): Promise<ServerAlbum[]> {
    const found: ServerAlbum[] = [];
    if (server === 'plex') {
      const plex = await this.plexClient();
      for (const library of getSettings().plex.musicLibraries ?? []) {
        if (!library.enabled) continue;
        const albums = await plex.getRecentlyAddedAlbums(
          library.id,
          since.getTime() - HOUR_MS
        );
        for (const album of albums.slice(0, NEWEST)) {
          const entry = plexAlbum(album);
          // Plex lists no album folders: read one track's file instead.
          if (this.plexAlbumLookups < PLEX_ALBUM_LOOKUPS) {
            this.plexAlbumLookups++;
            const tracks = await plex.getAlbumTracks(album.ratingKey);
            const file = tracks
              .flatMap((track) => track.Media ?? [])
              .flatMap((media) => media.Part ?? [])
              .find((part) => part.file)?.file;
            entry.path = parentPath(file);
          }
          found.push(entry);
        }
      }
      return found;
    }
    const api = await jellyfinClient(server);
    for (const library of jellyfinFamily(server).musicLibraries ?? []) {
      if (!library.enabled) continue;
      const albums = await api.getMatchItems(
        { libraryId: library.id, type: 'MusicAlbum', newest: NEWEST },
        TIMEOUT_MS
      );
      found.push(...albums.map((album) => jellyfinAlbum(server, album)));
    }
    return found;
  }

  /** One album by server id; undefined once gone. */
  public async album(
    server: MediaServerKind,
    key: string
  ): Promise<ServerAlbum | undefined> {
    if (server === 'plex') {
      try {
        const album = await (await this.plexClient()).getMusicItem(key);
        return album ? plexAlbum(album) : undefined;
      } catch (e) {
        if (statusOf(e) === 404) return undefined;
        throw e;
      }
    }
    const api = await jellyfinClient(server);
    const [album] = await api.getMatchItems({ ids: [key] }, TIMEOUT_MS);
    return album ? jellyfinAlbum(server, album) : undefined;
  }
}

const plexAlbum = (album: PlexMusicItem): ServerAlbum => ({
  kind: 'plex',
  itemId: album.ratingKey,
  title: album.title,
  year: album.year,
  artistName: album.parentTitle,
  releaseOrGroupId: plexMbid(album),
});

const jellyfinAlbum = (
  server: MediaServerKind,
  album: JellyfinMatchItem
): ServerAlbum => {
  const tagged = album as unknown as Parameters<typeof providerId>[0];
  return {
    kind: server,
    itemId: album.Id,
    title: album.Name,
    year: album.ProductionYear,
    path: album.Path,
    artistName: album.AlbumArtists?.[0]?.Name ?? album.AlbumArtist,
    releaseGroupId: providerId(tagged, 'MusicBrainzReleaseGroup'),
    releaseId: providerId(tagged, 'MusicBrainzAlbum'),
  };
};

/** Verdict on a film or series item against the *arr's. */
const compareTitle = (
  kind: 'movie' | 'series',
  item: MatchItem,
  folder: string,
  expected: Expected,
  mediaServer: MediaServerName
): Verdict => {
  // Compare as if the item were in the *arr's folder: found by that folder, or
  // (on a recheck) already known to be it.
  const byFolder = new Map([[folder.toLowerCase(), [expected]]]);
  const { checked, problem } = compareMatch(
    kind,
    { ...item, folders: [folder] },
    byFolder,
    mediaServer
  );
  if (problem) {
    return problem.reason === 'unmatched'
      ? { state: 'unmatched', problem }
      : { state: 'wrong', problem };
  }
  return checked ? { state: 'right' } : { state: 'unknown' };
};

class MatchWatchJob {
  private running = false;

  /** Whether Match Check is on (Settings → Health). */
  private get enabled(): boolean {
    return getSettings().main.matchCheckOnImport !== false;
  }

  /**
   * Queues a check of each requested title the *arr just imported, on every
   * server that should hold it. A title already queued is left alone, so a
   * series' episodes arriving one by one make one check.
   */
  public async noteImports(
    imported: Pick<ImportedDownload, 'kind' | 'serverId' | 'item'>[],
    now = new Date()
  ): Promise<void> {
    if (!this.enabled) return;
    const seen = new Set<string>();
    for (const { kind, serverId, item } of imported) {
      const arrItemId = kind === 'music' ? item.album?.id : item.externalId;
      const key = `${kind}:${serverId}:${arrItemId}`;
      if (!arrItemId || seen.has(key)) continue;
      seen.add(key);
      const media = await this.requested(kind, serverId, item);
      if (!media) continue;
      for (const server of serversFor(kind)) {
        const mediaServer = serverName(server) as MediaServerName;
        const where = {
          mediaId: media.id,
          mediaServer,
          arrServerId: serverId,
          arrItemId,
        };
        if (await getRepository(MatchWatch).exists({ where })) continue;
        try {
          await getRepository(MatchWatch).insert({
            ...where,
            kind,
            arrArtistId: kind === 'music' ? item.externalId : null,
            importedAt: now,
            nextCheckAt: new Date(now.getTime() + LOOKS_AT_MS[0]),
            attempts: 0,
          });
        } catch {
          // Another import of it queued it at the same moment.
        }
      }
    }
  }

  /** The requested title an import is for, if any. */
  private async requested(
    kind: ImportedDownload['kind'],
    serverId: number,
    item: ImportedDownload['item']
  ): Promise<Media | null> {
    const query = getRepository(Media)
      .createQueryBuilder('media')
      .innerJoin('media.requests', 'request');
    if (kind === 'music') {
      if (!item.album?.foreignAlbumId) return null;
      return query
        .innerJoin('request.albums', 'album')
        .where('media.mediaType = :type', { type: MediaType.MUSIC })
        .andWhere('media.serviceId = :serverId', { serverId })
        .andWhere('media.externalServiceId = :artistId', {
          artistId: item.externalId,
        })
        .andWhere('album.albumMbid = :mbid', {
          mbid: item.album.foreignAlbumId,
        })
        .getOne();
    }
    return query
      .where('media.mediaType = :type', {
        type: kind === 'movie' ? MediaType.MOVIE : MediaType.TV,
      })
      .andWhere(
        '((media.serviceId = :serverId AND media.externalServiceId = :id) OR (media.serviceId4k = :serverId AND media.externalServiceId4k = :id))',
        { serverId, id: item.externalId }
      )
      .getOne();
  }

  /**
   * One run: due checks, rechecks of open problems, messages, waiting lines.
   */
  public async run(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.enabled) {
        const reading = new Reading();
        await this.lookAtDue(reading, now);
        await this.lookAgainAtOpen(reading, now);
      }
      await this.tell(now);
      await this.showWaiting();
    } catch (e) {
      logger.warn('Could not check new requests’ matches', {
        label: 'Match Check',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.running = false;
    }
  }

  private async lookAtDue(reading: Reading, now: Date): Promise<void> {
    const due = await getRepository(MatchWatch).find({
      where: { nextCheckAt: LessThanOrEqual(now) },
      order: { nextCheckAt: 'ASC' },
      take: PER_RUN,
    });
    const arr = new Map<string, Promise<ArrSide>>();
    for (const watch of due) {
      let verdict: Verdict;
      try {
        const key = `${watch.kind}:${watch.arrServerId}:${watch.arrItemId}`;
        if (!arr.has(key)) arr.set(key, this.arrSide(watch));
        verdict = await this.look(
          watch,
          (await arr.get(key)) as ArrSide,
          reading
        );
      } catch (e) {
        logger.debug('Could not look at a new request’s match', {
          label: 'Match Check',
          mediaId: watch.mediaId,
          mediaServer: watch.mediaServer,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        verdict = { state: 'unknown' };
      }
      await this.decide(watch, verdict, now);
    }
  }

  /** The *arr's folder and ids for the title. */
  private async arrSide(watch: MatchWatch): Promise<ArrSide> {
    const settings = getSettings();
    try {
      if (watch.kind === 'movie') {
        const server = settings.radarr.find((s) => s.id === watch.arrServerId);
        if (!server) return 'gone';
        const movie = await new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        }).getMovie({ id: watch.arrItemId });
        return {
          kind: 'movie',
          folder: folderName(movie.path),
          expected: {
            title: movie.title,
            year: movie.year,
            tmdbId: movie.tmdbId || undefined,
            imdbId: movie.imdbId || undefined,
            server: server.name,
            ...radarrFileFacts(movie),
          },
        };
      }
      if (watch.kind === 'series') {
        const server = settings.sonarr.find((s) => s.id === watch.arrServerId);
        if (!server) return 'gone';
        const series = await new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        }).getSeriesById(watch.arrItemId);
        return {
          kind: 'series',
          folder: folderName(series.path),
          expected: {
            title: series.title,
            year: series.year,
            tvdbId: series.tvdbId || undefined,
            tmdbId: series.tmdbId || undefined,
            imdbId: series.imdbId || undefined,
            server: server.name,
          },
        };
      }
      const server = settings.lidarr.find((s) => s.id === watch.arrServerId);
      if (!server) return 'gone';
      const lidarr = lidarrApi(server);
      const album = await lidarr.getAlbum(watch.arrItemId);
      const files = await lidarr.getTrackFiles(watch.arrItemId);
      const folder = musicFolderName(
        parentPath(files.find((f) => f.path)?.path)
      );
      return {
        kind: 'music',
        folder: folder ?? '',
        expected: {
          title: album.title,
          year: yearOf(album.releaseDate),
          server: server.name,
          mbid: album.foreignAlbumId,
          releaseIds: (album.releases ?? [])
            .map((r) => r.foreignReleaseId)
            .filter(Boolean),
          artist: album.artist?.artistName,
          artistMbid: album.artist?.foreignArtistId,
        },
      };
    } catch (e) {
      if (statusOf(e) === 404) return 'gone';
      throw e;
    }
  }

  /** Finds the imported title on the server by folder and compares. */
  private async look(
    watch: MatchWatch,
    arr: ArrSide,
    reading: Reading
  ): Promise<Verdict> {
    if (arr === 'gone') return { state: 'gone' };
    if (!arr.folder) return { state: 'unknown' };
    const server = kindOfServer(watch.mediaServer);
    const folder = arr.folder.toLowerCase();
    if (arr.kind === 'music') {
      const albums = await reading.newestAlbums(server, watch.importedAt);
      const album = albums.find(
        (a) => musicFolderName(a.path)?.toLowerCase() === folder
      );
      return album
        ? compareAlbum(arr.expected, album, watch.mediaServer, arr.folder)
        : { state: 'unknown' };
    }
    const items = await reading.newest(server, arr.kind, watch.importedAt);
    const item = items.find((i) =>
      i.folders.some((f) => f.toLowerCase() === folder)
    );
    return item
      ? compareTitle(
          arr.kind,
          item,
          arr.folder,
          arr.expected,
          watch.mediaServer
        )
      : { state: 'unknown' };
  }

  /** Acts on a verdict: done, reported, or checked again later. */
  private async decide(
    watch: MatchWatch,
    verdict: Verdict,
    now: Date
  ): Promise<void> {
    const repo = getRepository(MatchWatch);
    const last = watch.attempts + 1 >= LOOKS_AT_MS.length;
    const done = () => repo.delete(watch.id);
    switch (verdict.state) {
      case 'right':
        await this.resolve(
          {
            mediaId: watch.mediaId,
            mediaServer: watch.mediaServer,
            albumId: watch.kind === 'music' ? watch.arrItemId : undefined,
          },
          now
        );
        return void (await done());
      case 'gone':
        return void (await done());
      case 'wrong':
        await this.record(verdict.problem, watch, now);
        break;
      case 'unmatched':
        // Servers often list an item before matching it.
        if (last) await this.record(verdict.problem, watch, now);
        break;
    }
    if (last) {
      if (verdict.state === 'unknown') {
        logger.debug('A new request was not found to compare on the server', {
          label: 'Match Check',
          mediaId: watch.mediaId,
          mediaServer: watch.mediaServer,
        });
      }
      return void (await done());
    }
    const attempts = watch.attempts + 1;
    await repo.update(watch.id, {
      attempts,
      nextCheckAt: new Date(
        Math.max(
          now.getTime() + MINUTE_MS,
          watch.importedAt.getTime() + LOOKS_AT_MS[attempts]
        )
      ),
    });
  }

  /**
   * Stores a problem. One already known by key is never reported again, even
   * if it was fixed and came back; one the nightly check already listed is not
   * reported either, since it is on the Health page.
   */
  private async record(
    problem: PlexMatchProblem,
    from: {
      mediaId: number;
      mediaServer: MediaServerName;
      kind: MatchKind;
      arrServerId?: number | null;
      arrItemId?: number | null;
      arrArtistId?: number | null;
    },
    now: Date
  ): Promise<void> {
    const repo = getRepository(MatchProblem);
    const key = problemKey(problem);
    // The server has since matched it elsewhere: that earlier problem is over.
    await this.resolve(
      {
        mediaId: from.mediaId,
        mediaServer: from.mediaServer,
        albumId: from.kind === 'music' ? from.arrItemId : undefined,
        exceptKey: key,
      },
      now
    );
    const known = await repo.findOne({ where: { key } });
    if (known) {
      await repo.update(known.id, {
        problem: JSON.stringify(problem),
        resolvedAt: null,
        nextCheckAt: known.resolvedAt
          ? new Date(now.getTime() + RECHECK_MS)
          : known.nextCheckAt,
      });
      return;
    }
    const nightly = await plexMatchCheck.lastReport();
    const listed = nightly.problems.some((p) => problemKey(p) === key);
    const music = from.kind === 'music';
    try {
      await repo.insert({
        key,
        mediaId: from.mediaId,
        mediaServer: from.mediaServer,
        kind: from.kind,
        problem: JSON.stringify(problem),
        arrServerId: from.arrServerId ?? null,
        arrItemId: music
          ? (from.arrArtistId ?? null)
          : (from.arrItemId ?? null),
        arrAlbumId: music ? (from.arrItemId ?? null) : null,
        notice: listed ? 'none' : 'waiting',
        foundAt: now,
        nextCheckAt: new Date(now.getTime() + RECHECK_MS),
      });
      logger.info(
        `Match Check: ${problem.mediaServer} matched a new request wrongly: ${plexMatchText(problem).title}`,
        { label: 'Match Check', mediaId: from.mediaId }
      );
    } catch {
      // Another check recorded it at the same moment.
      return;
    }
    await this.fixOnItsOwn(problem, key, now);
  }

  /**
   * With "Fix automatically" on, fixes a new problem in Plex immediately and
   * tells admins it was fixed instead of asking them to.
   */
  private async fixOnItsOwn(
    problem: PlexMatchProblem,
    key: string,
    now: Date
  ): Promise<void> {
    const outcome = await autoFix(problem, key);
    if (outcome?.state === 'right') {
      await this.resolveKeys([key], now);
    } else if (outcome?.state === 'fixed') {
      const { title, year } = outcome.fix.to;
      // Stays 'waiting', unlike other resolved problems: still reported as
      // fixed.
      await getRepository(MatchProblem).update(
        { key },
        {
          problem: JSON.stringify({ ...problem, fixed: { title, year } }),
          resolvedAt: now,
          nextCheckAt: null,
        }
      );
    }
  }

  /** Resolves problems by key, silently. */
  private async resolveKeys(keys: string[], now: Date): Promise<void> {
    if (!keys.length) return;
    const repo = getRepository(MatchProblem);
    await repo.update(
      {
        key: In(keys),
        resolvedAt: IsNull(),
        notice: In<MatchNotice>(['waiting', 'held']),
      },
      { notice: 'none' }
    );
    await repo.update(
      { key: In(keys), resolvedAt: IsNull() },
      { resolvedAt: now, nextCheckAt: null }
    );
  }

  /** An open problem by key, from a new request or the nightly check. */
  public async findProblem(key: string): Promise<PlexMatchProblem | undefined> {
    const row = await getRepository(MatchProblem).findOne({
      where: { key, resolvedAt: IsNull() },
    });
    if (row) return JSON.parse(row.problem) as PlexMatchProblem;
    const report = await plexMatchCheck.lastReport();
    return report.problems.find((p) => problemKey(p) === key);
  }

  /** Marks a problem fixed by an admin: off the Health page, not reported. */
  public async markFixed(
    problem: PlexMatchProblem,
    now = new Date()
  ): Promise<void> {
    const key = problemKey(problem);
    await this.resolveKeys([key], now);
    await plexMatchCheck.forget([key]);
    await this.showWaiting();
  }

  /**
   * The title is right on a server now: its problems there resolve silently.
   * Unreported ones never will be.
   */
  private async resolve(
    which: {
      mediaServer: MediaServerName;
      mediaId?: number;
      /** Music: just this album of the artist. */
      albumId?: number | null;
      /** Every problem except this one. */
      exceptKey?: string;
    },
    now: Date
  ): Promise<void> {
    const repo = getRepository(MatchProblem);
    const where = {
      mediaServer: which.mediaServer,
      resolvedAt: IsNull(),
      ...(which.mediaId !== undefined ? { mediaId: which.mediaId } : {}),
      ...(which.albumId ? { arrAlbumId: which.albumId } : {}),
      ...(which.exceptKey ? { key: Not(which.exceptKey) } : {}),
    };
    await repo.update(
      { ...where, notice: In<MatchNotice>(['waiting', 'held']) },
      { notice: 'none' }
    );
    await repo.update(where, { resolvedAt: now, nextCheckAt: null });
  }

  /**
   * Rechecks open problems by the server's item id, which a fix keeps.
   */
  private async lookAgainAtOpen(reading: Reading, now: Date): Promise<void> {
    const repo = getRepository(MatchProblem);
    const open = await repo.find({
      where: { resolvedAt: IsNull(), nextCheckAt: LessThanOrEqual(now) },
      order: { nextCheckAt: 'ASC' },
      take: PER_RUN,
    });
    for (const row of open) {
      const problem = JSON.parse(row.problem) as PlexMatchProblem;
      const server = kindOfServer(row.mediaServer);
      let verdict: Verdict | 'gone' = { state: 'unknown' };
      try {
        if (!connectedServers().includes(server)) {
          verdict = 'gone';
        } else if (problem.kind === 'music') {
          const album = await reading.album(server, problem.matched.key);
          verdict = album
            ? compareAlbum(
                {
                  title: problem.expected.title,
                  year: problem.expected.year,
                  server: problem.expected.server,
                  mbid: problem.expected.mbid ?? '',
                  releaseIds: [],
                  artist: problem.expected.artist,
                  artistMbid: problem.expected.artistMbid,
                },
                album,
                row.mediaServer,
                problem.folder
              )
            : 'gone';
        } else {
          const item = await reading.item(
            server,
            problem.kind,
            problem.matched.key
          );
          verdict = item
            ? compareTitle(
                problem.kind,
                item,
                problem.folder,
                problem.expected as Expected,
                row.mediaServer
              )
            : 'gone';
        }
      } catch {
        // No answer: retry later.
      }
      if (verdict === 'gone' || verdict.state === 'right') {
        // Fixed, or the item is gone (rescanned, removed): resolve.
        await getRepository(MatchProblem).update(row.id, {
          resolvedAt: now,
          nextCheckAt: null,
          ...(row.notice === 'waiting' || row.notice === 'held'
            ? { notice: 'none' as MatchNotice }
            : {}),
        });
        continue;
      }
      if (
        (verdict.state === 'wrong' || verdict.state === 'unmatched') &&
        problemKey(verdict.problem) !== row.key &&
        row.mediaId
      ) {
        await this.record(
          verdict.problem,
          {
            mediaId: row.mediaId,
            mediaServer: row.mediaServer,
            kind: row.kind,
            arrServerId: row.arrServerId,
            arrItemId: row.kind === 'music' ? row.arrAlbumId : row.arrItemId,
            arrArtistId: row.kind === 'music' ? row.arrItemId : null,
          },
          now
        );
        continue;
      }
      await repo.update(row.id, {
        nextCheckAt: new Date(now.getTime() + RECHECK_MS),
      });
    }
  }

  /**
   * After the nightly check, resolves what it now finds right on servers it
   * could read. It skips music, so music problems are left alone.
   */
  public async afterNightly(
    report: PlexMatchReport,
    unread: MediaServerName[],
    now = new Date()
  ): Promise<void> {
    const found = new Set(report.problems.map(problemKey));
    const open = await getRepository(MatchProblem).find({
      where: {
        resolvedAt: IsNull(),
        kind: In<MatchKind>(['movie', 'series']),
      },
    });
    for (const row of open) {
      if (unread.includes(row.mediaServer) || found.has(row.key)) continue;
      await getRepository(MatchProblem).update(row.id, {
        resolvedAt: now,
        nextCheckAt: null,
        ...(row.notice === 'waiting' || row.notice === 'held'
          ? { notice: 'none' as MatchNotice }
          : {}),
      });
    }
    await this.fixNightlyOnItsOwn(report, unread, now);
    await this.showWaiting();
  }

  /**
   * With "Fix automatically" on, also fixes nightly findings in Plex, up to
   * AUTO_PER_NIGHT a night, and removes them from its list.
   */
  private async fixNightlyOnItsOwn(
    report: PlexMatchReport,
    unread: MediaServerName[],
    now: Date
  ): Promise<void> {
    if (!fixingAuto() || unread.includes('Plex')) return;
    const fixed: string[] = [];
    let tried = 0;
    for (const problem of report.problems) {
      if (tried >= AUTO_PER_NIGHT) break;
      if (!canFix(problem)) continue;
      const key = problemKey(problem);
      const outcome = await autoFix(problem, key);
      if (!outcome) continue;
      tried += 1;
      if (outcome.state === 'fixed' || outcome.state === 'right') {
        fixed.push(key);
      }
    }
    await this.resolveKeys(fixed, now);
    await plexMatchCheck.forget(fixed);
  }

  /**
   * Sends waiting problems once the oldest has waited GATHER_MS for others,
   * within DAILY_MESSAGES a day.
   */
  private async tell(now: Date): Promise<void> {
    const repo = getRepository(MatchProblem);
    // Resolved problems leave 'waiting', except auto-fixed ones, which are
    // reported as fixed.
    const waiting = await repo.find({
      where: { notice: 'waiting' },
      order: { foundAt: 'ASC' },
    });
    if (!waiting.length) return;
    if (now.getTime() - waiting[0].foundAt.getTime() < GATHER_MS) return;

    const sentToday = new Set(
      (
        await repo.find({
          select: { id: true, sentAt: true },
          where: { sentAt: MoreThanOrEqual(new Date(now.getTime() - DAY_MS)) },
        })
      ).map((row) => row.sentAt?.getTime())
    ).size;
    const ids = waiting.map((row) => row.id);
    if (sentToday >= DAILY_MESSAGES) {
      await repo.update({ id: In(ids) }, { notice: 'held' });
      return;
    }
    const held = await repo.find({
      select: { id: true },
      where: { notice: 'held', resolvedAt: IsNull() },
    });
    await repo.update({ id: In(ids) }, { notice: 'sent', sentAt: now });
    if (held.length) {
      await repo.update(
        { id: In(held.map((row) => row.id)) },
        { notice: 'counted' }
      );
    }
    await this.send(waiting, held.length);
  }

  private async send(rows: MatchProblem[], more: number): Promise<void> {
    const media = await getRepository(Media).find({
      where: {
        id: In(rows.flatMap((row) => (row.mediaId ? [row.mediaId] : []))),
      },
    });
    const byId = new Map(media.map((m) => [m.id, m]));
    const told = rows.map((row) => {
      const problem = JSON.parse(row.problem) as PlexMatchProblem;
      const found = row.mediaId ? byId.get(row.mediaId) : undefined;
      return { problem, path: pagePath(problem, found) };
    });
    try {
      notificationManager.sendNotification(Notification.WRONG_MATCH, {
        ...wrongMatchEvent(),
        notifyAdmin: true,
        notifySystem: true,
        ...wrongMatchMessage(told, more, getSettings().main.applicationUrl),
      });
    } catch (e) {
      logger.warn('Could not send a wrong match notification', {
        label: 'Match Check',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Marks requests waiting on a server's match (downloadTracker). */
  public async showWaiting(): Promise<void> {
    const open = await getRepository(MatchProblem).find({
      where: { resolvedAt: IsNull() },
    });
    downloadTracker.setMatchWaits(
      open.flatMap((row): MatchWait[] => {
        if (row.arrServerId == null || row.arrItemId == null) return [];
        const problem = JSON.parse(row.problem) as PlexMatchProblem;
        return [
          {
            kind: row.kind,
            serverId: row.arrServerId,
            externalId: row.arrItemId,
            albumId: row.arrAlbumId ?? undefined,
            mediaServer: row.mediaServer,
            title: problem.expected.title,
          },
        ];
      })
    );
  }

  /** A title's unresolved problems. */
  public async openProblems(mediaId: number): Promise<PlexMatchProblem[]> {
    const rows = await getRepository(MatchProblem).find({
      where: { mediaId, resolvedAt: IsNull() },
      order: { foundAt: 'DESC' },
    });
    return rows.map((row) => JSON.parse(row.problem) as PlexMatchProblem);
  }

  /** Drops pending checks and problems for a disconnected server. */
  public async dropServer(mediaServer: MediaServerName): Promise<void> {
    await getRepository(MatchWatch).delete({ mediaServer });
    await this.resolve({ mediaServer }, new Date());
    await this.showWaiting();
  }
}

/**
 * Message for problems found together: one gets a link to its title; several
 * are listed with links plus a Health link. `more` counts those held back by
 * the daily cap since the last message.
 */
export const wrongMatchMessage = (
  told: { problem: PlexMatchProblem; path?: string }[],
  more: number,
  applicationUrl?: string
): {
  subject: string;
  message: string;
  actionUrl: string;
  actionUrlTitle: string;
} => {
  const moreLine = more
    ? `Plus ${more} more found since the last message, past the ${DAILY_MESSAGES} messages a day: see the Health page.`
    : '';
  const texts = told.map(({ problem, path }) => {
    const text = plexMatchText(problem);
    return {
      problem,
      path,
      text: problem.fixed
        ? {
            title: text.title,
            detail: `Fixed in ${problem.mediaServer ?? 'Plex'} by itself: it is now ${titled(problem.fixed)}. Undo it on the Health page if that's wrong.`,
          }
        : text,
    };
  });
  const [first] = texts;
  if (texts.length === 1) {
    return {
      subject: `${titled(first.problem.expected)}: ${first.text.title}`,
      message: [first.text.detail, moreLine].filter(Boolean).join('\n\n'),
      actionUrl: first.path ?? '/settings/health',
      actionUrlTitle: first.path ? 'Open Title' : 'Open Health',
    };
  }
  return {
    subject: `${texts.length} wrong matches`,
    message: [
      ...texts
        .slice(0, NAMED)
        .map(
          ({ text, path }) =>
            `• ${text.title}: ${text.detail}${
              applicationUrl && path ? ` ${applicationUrl}${path}` : ''
            }`
        ),
      ...(texts.length > NAMED
        ? [`and ${texts.length - NAMED} more on the Health page`]
        : []),
      moreLine,
    ]
      .filter(Boolean)
      .join('\n'),
    actionUrl: '/settings/health',
    actionUrlTitle: 'Open Health',
  };
};

/** Seerr page for a film, series or album. */
const pagePath = (
  problem: PlexMatchProblem,
  media?: Media
): string | undefined => {
  if (problem.kind === 'music') {
    return problem.expected.mbid
      ? `/music/album/${problem.expected.mbid}`
      : media?.foreignId
        ? `/music/artist/${media.foreignId}`
        : undefined;
  }
  return media ? `/${media.mediaType}/${media.tmdbId}` : undefined;
};

const matchWatch = new MatchWatchJob();

// Nightly check results: what it finds right is resolved.
plexMatchCheck.whenFinished((report, unread) =>
  matchWatch.afterNightly(report, unread)
);

export default matchWatch;
