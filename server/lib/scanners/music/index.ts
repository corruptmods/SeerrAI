import { MediaStatus, MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MusicAlbum from '@server/entity/MusicAlbum';
import downloadTracker from '@server/lib/downloadtracker';
import {
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

/*
 * The music jobs. Music Sync (every few minutes) follows Lidarr's work on
 * requests and reads what each connected server's music libraries have
 * newly added. The Music Full Scan (daily) reads every music library and
 * all of Lidarr, brings in the libraries of Lidarrs with Scan on, and takes
 * away what is gone. Both do nothing until music is set up.
 */

const LABEL = 'Music Scan';

/** A recent scan's window reaches this far behind the last one. */
const RECENT_OVERLAP_MS = 10 * 60 * 1000;
/** A library never scanned: what was added in the last hour. */
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

/** The albums Seerr keeps of an artist, to match folders and titles. */
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
 * Albums now here that Lidarr imported: their downloads stop being shown
 * as being added to the library. Those imported after the scan began wait
 * for the next one.
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

/** The music scan under way, if any. */
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
      // One music scan at a time: two would make the same rows. A sync
      // while another scan runs is left out, as that scan covers it; a
      // full scan waits its turn.
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
            this.progress++;
          }
          if (!this.cancelled) scanned.push([library, askedAt]);
        }
        const recorded = await recordServerAlbums(kind, matches, index);
        // The next sync reads from here, once what was read is kept.
        for (const [library, askedAt] of scanned) library.lastScan = askedAt;
        matched += matches.filter((m) => m.albumMbid).length;
        unplaced += matches.filter((m) => !m.albumMbid).length;
        seen.albums.set(kind, recorded.albumIds);
        seen.artists.set(kind, recorded.listedArtistIds);
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
      if (everyServerAnswered && index.complete && !this.cancelled) {
        for (const id of await markGone(seen, index)) artists.add(id);
      } else {
        logger.info(
          'A media server or Lidarr did not answer; nothing is marked as gone this time',
          { label: LABEL }
        );
      }
      for (const artist of await getRepository(Media).find({
        select: { id: true },
        where: { mediaType: MediaType.MUSIC },
      })) {
        artists.add(artist.id);
      }
    }

    await refreshArtists(artists, index);

    // Requests whose albums are all here now are done, and say so.
    const completed = await completeMusicRequests(artists);

    // Downloads shown as being added to the library, for albums a server
    // now lists, are no longer shown.
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
   * Places an album; one the ids could not place gets its folders looked
   * up (Plex lists none) and another try.
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
    // The first try's count is taken back: only the second counts.
    matcher.unknownArtist = unknown;
    return (await matcher.match(album)) ?? match;
  }
}

export const musicSync = new MusicScanner(false, 'Music Sync');
export const musicFullScan = new MusicScanner(true, 'Music Full Scan');
