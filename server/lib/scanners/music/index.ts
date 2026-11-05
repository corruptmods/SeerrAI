import { MediaStatus, MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MusicAlbum from '@server/entity/MusicAlbum';
import downloadTracker from '@server/lib/downloadtracker';
import {
  MUSIC_ALBUM_ID,
  connectedServers,
  isJellyfinFamily,
  serverName,
} from '@server/lib/mediaServers';
import { musicReady } from '@server/lib/music/access';
import type { FullScanSeen } from '@server/lib/music/availability';
import {
  applyLidarr,
  enabledMusicLibraries,
  lidarrOnly,
  markGone,
  recordServerAlbums,
  refreshArtists,
} from '@server/lib/music/availability';
import { completeMusicRequests } from '@server/lib/music/completion';
import type {
  AlbumMatch,
  KnownAlbum,
  ServerAlbum,
} from '@server/lib/music/matcher';
import {
  AlbumMatcher,
  LidarrIndex,
  ReleaseResolver,
} from '@server/lib/music/matcher';
import { JellyfinMusicSource } from '@server/lib/scanners/music/jellyfin';
import {
  importLidarrLibrary,
  lidarrInFlight,
} from '@server/lib/scanners/music/lidarr';
import { PlexMusicSource } from '@server/lib/scanners/music/plex';
import type { MusicSource } from '@server/lib/scanners/music/source';
import type { MusicLibrary } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Music jobs. Music Sync (every few minutes) tracks Lidarr's progress on
 * requests and reads newly added albums from each connected server's music
 * libraries. Music Full Scan (daily) reads every music library and all of
 * Lidarr, imports the libraries of Lidarrs with Scan on, and removes what is
 * gone. Both do nothing until music is set up.
 */

const LABEL = 'Music Scan';

/** Album rows Seerr has for these item ids on one server. */
const rowsWithItemIds = async (
  kind: MediaServerKind,
  itemIds: string[]
): Promise<Pick<MusicAlbum, 'id' | 'mediaId'>[]> => {
  const rows: Pick<MusicAlbum, 'id' | 'mediaId'>[] = [];
  // Chunked to stay under the databases' query parameter limit.
  for (let i = 0; i < itemIds.length; i += 500) {
    rows.push(
      ...(await getRepository(MusicAlbum).find({
        select: { id: true, mediaId: true },
        where: { [MUSIC_ALBUM_ID[kind]]: In(itemIds.slice(i, i + 500)) },
      }))
    );
  }
  return rows;
};

/** How far a recent scan's window overlaps the previous one. */
const RECENT_OVERLAP_MS = 10 * 60 * 1000;
/** First scan of a library: items added in the last hour. */
const FIRST_WINDOW_MS = 60 * 60 * 1000;

export interface MusicScanStatus {
  running: boolean;
  progress: number;
  total: number;
}

const openSource = (kind: MediaServerKind): Promise<MusicSource> =>
  isJellyfinFamily(kind)
    ? JellyfinMusicSource.open(kind)
    : PlexMusicSource.open();

/** Seerr's albums per artist, cached, for matching folders and titles. */
const knownAlbums = () => {
  const found = new Map<string, KnownAlbum[]>();
  return async (artistMbid: string): Promise<KnownAlbum[]> => {
    if (!found.has(artistMbid)) {
      const artist = await getRepository(Media).findOne({
        select: { id: true },
        where: { mediaType: MediaType.MUSIC, foreignId: artistMbid },
      });
      const rows = artist
        ? await getRepository(MusicAlbum).find({
            select: {
              id: true,
              mbId: true,
              title: true,
              releaseDate: true,
              folder: true,
            },
            where: { mediaId: artist.id },
          })
        : [];
      found.set(
        artistMbid,
        rows
          .filter((row) => !!row.mbId)
          .map((row) => ({
            mbid: row.mbId as string,
            title: row.title,
            releaseDate: row.releaseDate,
            folder: row.folder,
          }))
      );
    }
    return found.get(artistMbid) ?? [];
  };
};

/**
 * Stops showing downloads as being added for Lidarr imports a server now
 * lists. Imports after the scan began wait for the next scan.
 */
const forgetListedImports = async (before: number): Promise<void> => {
  const held = downloadTracker.heldMusicImports();
  if (!held.length) return;
  const here = await getRepository(MusicAlbum)
    .createQueryBuilder('album')
    .innerJoin('album.media', 'media')
    .select('album.lidarrAlbumId', 'albumId')
    .addSelect('media.serviceId', 'serverId')
    .where('album.lidarrAlbumId IN (:...ids)', {
      ids: [...new Set(held.map((h) => h.albumId))],
    })
    .andWhere('album.status = :available', {
      available: MediaStatus.AVAILABLE,
    })
    .getRawMany<{ albumId: number | string; serverId: number | string }>();
  for (const row of here) {
    downloadTracker.forgetImportedAlbum(
      Number(row.serverId),
      Number(row.albumId),
      before
    );
  }
};

/** The running music scan, if any. */
let underWay: Promise<void> | undefined;

class MusicScanner {
  public running = false;
  private cancelled = false;
  private progress = 0;
  private total = 0;

  constructor(
    private full: boolean,
    public readonly name: string
  ) {}

  public status(): MusicScanStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.total,
    };
  }

  public cancel(): void {
    this.cancelled = true;
  }

  public async run(): Promise<void> {
    if (this.running || !musicReady()) {
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.progress = 0;
    this.total = 0;
    try {
      // One music scan at a time, since two would create duplicate rows. A
      // sync during another scan is skipped (that scan covers it); a full
      // scan waits.
      while (underWay) {
        if (!this.full) return;
        await underWay.catch(() => undefined);
      }
      const scan = this.scan();
      underWay = scan;
      try {
        await scan;
      } finally {
        if (underWay === scan) underWay = undefined;
      }
    } finally {
      this.running = false;
    }
  }

  private async scan(): Promise<void> {
    const startedAt = Date.now();
    const settings = getSettings();
    const decide = lidarrOnly();
    const index = new LidarrIndex(settings.lidarr, { full: this.full });
    await index.load();

    const artists = new Set<number>(await lidarrInFlight(index));
    if (this.full && index.complete) {
      for (const id of await importLidarrLibrary(index, { decide })) {
        artists.add(id);
      }
    }

    const resolver = new ReleaseResolver();
    const matcher = new AlbumMatcher(index, resolver, knownAlbums());
    const seen: FullScanSeen = { albums: new Map(), artists: new Map() };
    let everyServerAnswered = true;
    let matched = 0;
    let unplaced = 0;

    for (const kind of connectedServers()) {
      const libraries = enabledMusicLibraries(kind);
      if (!libraries.length || this.cancelled) continue;
      try {
        const source = await openSource(kind);
        const matches: AlbumMatch[] = [];
        // Items the server lists that couldn't be placed this run.
        const notPlaced: string[] = [];
        const scanned: [MusicLibrary, number][] = [];
        for (const library of libraries) {
          if (this.cancelled) break;
          const askedAt = Date.now();
          const albums = await source.albums(library, {
            since: this.full
              ? undefined
              : library.lastScan
                ? library.lastScan - RECENT_OVERLAP_MS
                : askedAt - FIRST_WINDOW_MS,
          });
          this.total += albums.length;
          await resolver.preload(
            albums.flatMap((album) =>
              [album.releaseOrGroupId, album.releaseId].filter(
                (id): id is string => !!id
              )
            )
          );
          for (const album of albums) {
            if (this.cancelled) break;
            const match = await this.place(matcher, source, album);
            if (match) matches.push(match);
            else notPlaced.push(album.itemId);
            this.progress++;
          }
          if (!this.cancelled) scanned.push([library, askedAt]);
        }
        const recorded = await recordServerAlbums(kind, matches, index);
        // Advance each library's window only after the results are saved.
        for (const [library, askedAt] of scanned) library.lastScan = askedAt;
        matched += matches.filter((m) => m.albumMbid).length;
        unplaced += matches.filter((m) => !m.albumMbid).length;
        seen.albums.set(kind, recorded.albumIds);
        seen.artists.set(kind, recorded.listedArtistIds);
        // Albums placed earlier but not this run (MusicBrainz busy, artist
        // unknown) stay listed.
        for (const row of await rowsWithItemIds(kind, notPlaced)) {
          recorded.albumIds.add(row.id);
          recorded.listedArtistIds.add(row.mediaId);
        }
        recorded.artistIds.forEach((id) => artists.add(id));
      } catch (e) {
        everyServerAnswered = false;
        logger.warn(`${serverName(kind)} did not list its music`, {
          label: LABEL,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }
    await settings.save();

    for (const id of await applyLidarr(index, { decide })) artists.add(id);

    if (this.full) {
      if (!everyServerAnswered || !index.complete || this.cancelled) {
        logger.info(
          'A media server or Lidarr did not answer; nothing is marked as gone this time',
          { label: LABEL }
        );
      } else if (matcher.later > 0) {
        // An album waiting on MusicBrainz may be one Seerr has under another
        // server id, so nothing is removed without an answer.
        logger.info(
          'Some albums wait for MusicBrainz; nothing is marked as gone this time',
          { label: LABEL, leftForNextRun: matcher.later }
        );
      } else {
        for (const id of await markGone(seen, index)) artists.add(id);
      }
      for (const artist of await getRepository(Media).find({
        select: { id: true },
        where: { mediaType: MediaType.MUSIC },
      })) {
        artists.add(artist.id);
      }
    }

    await refreshArtists(artists, index);

    // Complete requests whose albums are all present.
    const completed = await completeMusicRequests(artists);

    // Stop showing import downloads for albums a server now lists.
    await forgetListedImports(startedAt);

    logger.info(`${this.name} finished`, {
      label: LABEL,
      albums: this.total,
      matched,
      unmatched: unplaced,
      unknownArtist: matcher.unknownArtist,
      leftForNextRun: matcher.later,
      musicBrainzCalls: resolver.calls,
      lidarrOnly: decide,
      requestsCompleted: completed.length,
    });
  }

  /**
   * Places an album. If its ids can't, looks up its folders (Plex lists
   * none) and tries again.
   */
  private async place(
    matcher: AlbumMatcher,
    source: MusicSource,
    album: ServerAlbum
  ): Promise<AlbumMatch | undefined> {
    const later = matcher.later;
    const unknown = matcher.unknownArtist;
    const match = await matcher.match(album);
    if (
      (match && match.albumMbid) ||
      matcher.later > later ||
      !source.fillPaths ||
      !(await source.fillPaths(album).catch(() => false))
    ) {
      return match;
    }
    // Undo the first try's unknown-artist count; only the retry counts.
    matcher.unknownArtist = unknown;
    return (await matcher.match(album)) ?? match;
  }
}

export const musicSync = new MusicScanner(false, 'Music Sync');
export const musicFullScan = new MusicScanner(true, 'Music Full Scan');
