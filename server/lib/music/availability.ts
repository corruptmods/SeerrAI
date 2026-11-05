import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import MusicAlbum from '@server/entity/MusicAlbum';
import SongFetch from '@server/entity/SongFetch';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import {
  MEDIA_ID,
  MEDIA_SERVER_KINDS,
  MUSIC_ALBUM_ID,
  connectedServers,
} from '@server/lib/mediaServers';
import type {
  AlbumMatch,
  IndexAlbum,
  LidarrIndex,
} from '@server/lib/music/matcher';
import { folderName, normalizeName } from '@server/lib/music/matcher';
import type { MusicLibrary } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';

/*
 * Album and artist availability from media servers and Lidarr.
 *
 * An album is available when any connected server's music library lists
 * it. With no music library enabled, Lidarr's files decide: all tracks is
 * available, some is partly. Lidarr files a server hasn't listed yet leave
 * the status alone (processing, "adding to Plex").
 *
 * Statuses only drop on a full scan where every server and Lidarr answered
 * and nothing waits on MusicBrainz: a vanished album becomes deleted if
 * requested, else unknown. A listed item that couldn't be placed still
 * counts for the album holding its id.
 *
 * An artist is partly available with any album here, available once every
 * wanted album (requested and not declined, or monitored in Lidarr) is.
 * With none here, the request status (pending, processing) stands.
 *
 * Rows change via update() and insert(), never by saving loaded entities,
 * one transaction per artist. Changes to already-known albums go into the
 * artist's history.
 */

/** Enabled music libraries on a server. */
export const enabledMusicLibraries = (kind: MediaServerKind): MusicLibrary[] =>
  (getSettings()[kind]?.musicLibraries ?? []).filter(
    (library) => library.enabled
  );

/** True when no connected server has a music library enabled. */
export const lidarrOnly = (): boolean =>
  !connectedServers().some((kind) => enabledMusicLibraries(kind).length > 0);

/** Album status from Lidarr's file counts, when Lidarr decides. */
export const lidarrStatus = (
  trackCount: number,
  trackFileCount: number
): MediaStatus | undefined =>
  trackCount > 0 && trackFileCount >= trackCount
    ? MediaStatus.AVAILABLE
    : trackFileCount > 0
      ? MediaStatus.PARTIALLY_AVAILABLE
      : undefined;

const HERE = [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE];

/** An artist's status from their albums (see above). */
export const artistStatus = (
  current: MediaStatus,
  albums: { status: MediaStatus; wanted: boolean }[]
): MediaStatus => {
  if (current === MediaStatus.BLOCKLISTED) {
    return current;
  }
  const wanted = albums.filter((album) => album.wanted);
  if (
    wanted.length > 0 &&
    wanted.every((album) => album.status === MediaStatus.AVAILABLE)
  ) {
    return MediaStatus.AVAILABLE;
  }
  if (albums.some((album) => HERE.includes(album.status))) {
    return MediaStatus.PARTIALLY_AVAILABLE;
  }
  if (current === MediaStatus.PENDING || current === MediaStatus.PROCESSING) {
    return current;
  }
  if (wanted.some((album) => album.status === MediaStatus.PROCESSING)) {
    return MediaStatus.PROCESSING;
  }
  if (HERE.includes(current)) {
    return albums.some((album) => album.status === MediaStatus.DELETED)
      ? MediaStatus.DELETED
      : MediaStatus.UNKNOWN;
  }
  return current;
};

/**
 * Artist name sources. Lidarr's (MusicBrainz's) overwrites; a media
 * server's (from tags) only fills a missing name.
 */
export interface ArtistNames {
  lidarr?: string;
  server?: string;
}

/**
 * Finds or creates the artist's row, storing the name in foreignTitle for
 * request cards, Recently Added and notifications.
 */
export const artistRow = async (
  manager: EntityManager,
  artistMbid: string,
  names: ArtistNames = {}
): Promise<Media> => {
  const where = { mediaType: MediaType.MUSIC, foreignId: artistMbid };
  const found = await manager.findOne(Media, { where });
  if (found) {
    const name =
      names.lidarr || (!found.foreignTitle ? names.server : undefined);
    if (name && name !== found.foreignTitle) {
      await manager.update(Media, found.id, { foreignTitle: name });
      found.foreignTitle = name;
    }
    return found;
  }
  await manager.insert(Media, {
    mediaType: MediaType.MUSIC,
    tmdbId: 0,
    foreignId: artistMbid,
    foreignTitle: names.lidarr || names.server || null,
    status: MediaStatus.UNKNOWN,
  });
  return manager.findOneOrFail(Media, { where });
};

/** An album change for the artist's history. */
export interface AlbumEvent {
  mediaId: number;
  type: MediaEventType;
  title: string;
}

/** History event type for each new album status. */
export const STATUS_EVENTS: Partial<Record<MediaStatus, MediaEventType>> = {
  [MediaStatus.AVAILABLE]: MediaEventType.AVAILABLE,
  [MediaStatus.PARTIALLY_AVAILABLE]: MediaEventType.PARTIALLY_AVAILABLE,
  [MediaStatus.DELETED]: MediaEventType.REMOVED,
};

/**
 * Writes album events to their artists' histories. Callers skip newly
 * discovered albums: a first library read would add thousands of
 * meaningless entries.
 */
export const recordAlbumEvents = async (
  events: AlbumEvent[],
  manager?: EntityManager
): Promise<void> => {
  if (!events.length) {
    return;
  }
  const repository = (manager ?? getRepository(Media).manager).getRepository(
    Media
  );
  const artists = await repository.find({
    select: { id: true, foreignId: true },
    where: { id: In([...new Set(events.map((e) => e.mediaId))]) },
  });
  const foreignIds = new Map(artists.map((a) => [a.id, a.foreignId]));
  for (const event of events) {
    const foreignId = foreignIds.get(event.mediaId);
    if (!foreignId) continue;
    await recordMediaEvent(
      {
        tmdbId: 0,
        foreignId,
        mediaType: MediaType.MUSIC,
        type: event.type,
        detail: event.title,
      },
      manager
    );
  }
};

/** Album row fields from Lidarr. */
export const fromLidarr = (album: IndexAlbum): Partial<MusicAlbum> => ({
  title: album.title,
  primaryType: album.albumType ?? null,
  secondaryTypes: album.secondaryTypes,
  releaseDate: album.releaseDate ?? null,
  lidarrAlbumId: album.id,
  trackCount: album.trackCount,
  trackFileCount: album.trackFileCount,
});

const withoutServerIds = (row: MusicAlbum, except?: string): boolean =>
  MEDIA_SERVER_KINDS.every(
    (kind) => MUSIC_ALBUM_ID[kind] === except || !row[MUSIC_ALBUM_ID[kind]]
  );

/** Album and artist row ids touched by one server's scan. */
export interface Recorded {
  albumIds: Set<number>;
  artistIds: Set<number>;
  /** Artists the server lists with their own item id. */
  listedArtistIds: Set<number>;
}

/**
 * Records one server's matched albums: creates artist rows as needed and
 * marks albums available with the server's id. Never lowers a status.
 */
export const recordServerAlbums = async (
  kind: MediaServerKind,
  matches: AlbumMatch[],
  index?: LidarrIndex
): Promise<Recorded> => {
  const recorded: Recorded = {
    albumIds: new Set(),
    artistIds: new Set(),
    listedArtistIds: new Set(),
  };
  const idColumn = MUSIC_ALBUM_ID[kind];
  const artistColumn = MEDIA_ID[kind][0];

  // Albums songs were taken from stay partly available until every track
  // is, even if Lidarr monitors the release they went into.
  const placed = [
    ...new Set(matches.map((m) => m.albumMbid).filter((id) => !!id)),
  ] as string[];
  const takenFrom = new Set<string>();
  for (let i = 0; i < placed.length; i += 400) {
    const fetches = await getRepository(SongFetch).find({
      select: { albumMbid: true },
      where: { albumMbid: In(placed.slice(i, i + 400)), status: 'done' },
    });
    fetches.forEach((fetch) => takenFrom.add(fetch.albumMbid));
  }

  const byArtist = new Map<string, AlbumMatch[]>();
  for (const match of matches) {
    byArtist.set(match.artistMbid, [
      ...(byArtist.get(match.artistMbid) ?? []),
      match,
    ]);
  }

  for (const [artistMbid, group] of byArtist) {
    await dataSource.transaction(async (manager) => {
      const media = await artistRow(manager, artistMbid, {
        lidarr: index?.artistName(artistMbid),
        server: group.find((match) => match.serversArtist)?.album.artistName,
      });
      recorded.artistIds.add(media.id);
      const events: AlbumEvent[] = [];

      const artistItemId = group.find(
        (match) => match.serversArtist && match.album.artistItemId
      )?.album.artistItemId;
      if (artistItemId) {
        recorded.listedArtistIds.add(media.id);
        if (media[artistColumn] !== artistItemId) {
          await manager.update(Media, media.id, {
            [artistColumn]: artistItemId,
          });
        }
      }

      const rows = await manager.find(MusicAlbum, {
        where: { mediaId: media.id },
      });

      for (const match of group) {
        const { album, albumMbid, lidarr } = match;
        // Partly available when Lidarr has some files and isn't fetching the
        // rest (or songs were taken from it), unless the server lists every
        // track. With no Lidarr files, the server alone decides.
        const taken = !!albumMbid && takenFrom.has(albumMbid);
        const partly =
          !!lidarr &&
          (!lidarr.monitored || taken) &&
          lidarr.trackFileCount > 0 &&
          lidarr.trackFileCount < lidarr.trackCount &&
          !((album.trackCount ?? 0) >= lidarr.trackCount);
        const here = partly
          ? MediaStatus.PARTIALLY_AVAILABLE
          : MediaStatus.AVAILABLE;
        const byItem = rows.find((row) => row[idColumn] === album.itemId);
        let row = albumMbid
          ? rows.find((r) => r.mbId === albumMbid)
          : (byItem ??
            rows.find(
              (r) =>
                !r.mbId && normalizeName(r.title) === normalizeName(album.title)
            ));
        const changes: Partial<MusicAlbum> = {};

        // A previously unmatched row is now matched: reuse it.
        if (!row && albumMbid && byItem && !byItem.mbId) {
          row = byItem;
          Object.assign(
            changes,
            { mbId: albumMbid },
            lidarr && fromLidarr(lidarr)
          );
        }

        // The server id moved to another album: clear it from the old row,
        // deleting that row if it only existed for this server.
        if (byItem && row && byItem.id !== row.id) {
          if (!byItem.mbId && withoutServerIds(byItem, idColumn)) {
            await manager.delete(MusicAlbum, byItem.id);
            rows.splice(rows.indexOf(byItem), 1);
          } else {
            await manager.update(MusicAlbum, byItem.id, { [idColumn]: null });
            byItem[idColumn] = null;
          }
        }

        const folder = folderName(album.path);
        if (!row) {
          const inserted = new MusicAlbum({
            mediaId: media.id,
            mbId: albumMbid,
            title: album.title,
            secondaryTypes: [],
            releaseDate: album.year ? String(album.year) : null,
            ...(lidarr ? fromLidarr(lidarr) : {}),
            status: here,
            [idColumn]: album.itemId,
            folder: folder ?? null,
            mediaAddedAt: album.addedAt ?? new Date(),
          });
          const result = await manager.insert(MusicAlbum, inserted);
          inserted.id = result.identifiers[0].id;
          rows.push(inserted);
          recorded.albumIds.add(inserted.id);
          continue;
        }

        // Available before, but the server also lists only part: downgrade
        // to partly without a history entry.
        if (
          partly &&
          row.status === MediaStatus.AVAILABLE &&
          (taken ||
            (album.trackCount !== undefined &&
              album.trackCount < (lidarr?.trackCount ?? 0)))
        ) {
          changes.status = here;
        } else if (
          row.status !== MediaStatus.AVAILABLE &&
          row.status !== MediaStatus.BLOCKLISTED &&
          row.status !== here
        ) {
          changes.status = here;
          const type = STATUS_EVENTS[here];
          if (type) {
            events.push({
              mediaId: media.id,
              type,
              title: changes.title ?? row.title,
            });
          }
        }
        if (row[idColumn] !== album.itemId) {
          changes[idColumn] = album.itemId;
        }
        if (folder && row.folder !== folder) {
          changes.folder = folder;
        }
        if (!row.mediaAddedAt) {
          changes.mediaAddedAt = album.addedAt ?? new Date();
        }
        if (Object.keys(changes).length) {
          await manager.update(MusicAlbum, row.id, changes);
          Object.assign(row, changes);
        }
        recorded.albumIds.add(row.id);
      }
      await recordAlbumEvents(events, manager);
    });
  }

  return recorded;
};

/**
 * Syncs Lidarr ids and track counts onto stored albums. With `decide` (no
 * music library enabled), files also set availability. Never lowers a
 * status. Returns artist ids whose albums changed.
 */
export const applyLidarr = async (
  index: LidarrIndex,
  { decide }: { decide: boolean }
): Promise<Set<number>> => {
  const changed = new Set<number>();
  const events: AlbumEvent[] = [];
  const albums = index.allAlbums();
  for (let i = 0; i < albums.length; i += 400) {
    const chunk = albums.slice(i, i + 400);
    const rows = await getRepository(MusicAlbum).find({
      where: { mbId: In(chunk.map((album) => album.mbid)) },
    });
    for (const row of rows) {
      const lidarr = index.album(row.mbId);
      if (!lidarr) continue;
      const changes: Partial<MusicAlbum> = {};
      if (row.lidarrAlbumId !== lidarr.id) changes.lidarrAlbumId = lidarr.id;
      if (row.trackCount !== lidarr.trackCount) {
        changes.trackCount = lidarr.trackCount;
      }
      if (row.trackFileCount !== lidarr.trackFileCount) {
        changes.trackFileCount = lidarr.trackFileCount;
        // More files arrived: bump it to the front of Recently Added.
        if (
          row.trackFileCount != null &&
          lidarr.trackFileCount > row.trackFileCount
        ) {
          changes.mediaAddedAt = new Date();
        }
      }
      const status = decide
        ? lidarrStatus(lidarr.trackCount, lidarr.trackFileCount)
        : undefined;
      if (
        status &&
        row.status !== status &&
        row.status !== MediaStatus.BLOCKLISTED &&
        !(
          status === MediaStatus.PARTIALLY_AVAILABLE &&
          row.status === MediaStatus.AVAILABLE
        )
      ) {
        changes.status = status;
        if (!row.mediaAddedAt) changes.mediaAddedAt = new Date();
        const type = STATUS_EVENTS[status];
        if (type) events.push({ mediaId: row.mediaId, type, title: row.title });
      }
      if (Object.keys(changes).length) {
        await getRepository(MusicAlbum).update(row.id, changes);
        changed.add(row.mediaId);
      }
    }
  }
  await recordAlbumEvents(events);
  return changed;
};

/** Non-declined requested album ids per artist row. */
const requestedAlbums = async (
  manager: EntityManager,
  mediaIds: number[]
): Promise<Map<number, Set<string>>> => {
  const requested = new Map<number, Set<string>>();
  for (let i = 0; i < mediaIds.length; i += 400) {
    const rows = await manager
      .getRepository(AlbumRequest)
      .createQueryBuilder('album')
      .innerJoin('album.request', 'request')
      .innerJoin('request.media', 'media')
      .select('album.albumMbid', 'albumMbid')
      .addSelect('media.id', 'mediaId')
      .where('media.id IN (:...ids)', { ids: mediaIds.slice(i, i + 400) })
      .andWhere('request.status != :declined', {
        declined: MediaRequestStatus.DECLINED,
      })
      .andWhere('album.status != :declined', {
        declined: MediaRequestStatus.DECLINED,
      })
      .getRawMany<{ albumMbid: string; mediaId: number | string }>();
    for (const row of rows) {
      const mediaId = Number(row.mediaId);
      requested.set(
        mediaId,
        (requested.get(mediaId) ?? new Set()).add(row.albumMbid)
      );
    }
  }
  return requested;
};

/** What a full scan saw, to detect removals. */
export interface FullScanSeen {
  /** Album row ids each server listed. */
  albums: Map<MediaServerKind, Set<number>>;
  /** Artist row ids each server listed an album of. */
  artists: Map<MediaServerKind, Set<number>>;
}

/**
 * After a full scan every server and Lidarr answered: clears server ids no
 * longer listed, and drops albums found nowhere (and without Lidarr files)
 * to deleted if requested, else unknown. Returns touched artist ids.
 */
export const markGone = async (
  seen: FullScanSeen,
  index: LidarrIndex
): Promise<Set<number>> => {
  const touched = new Set<number>();
  const events: AlbumEvent[] = [];
  const rows = await getRepository(MusicAlbum).find();
  const requested = await requestedAlbums(getRepository(MusicAlbum).manager, [
    ...new Set(rows.map((row) => row.mediaId)),
  ]);

  for (const row of rows) {
    const changes: Partial<MusicAlbum> = {};
    let anywhere = false;
    for (const kind of MEDIA_SERVER_KINDS) {
      const listed = seen.albums.get(kind)?.has(row.id) ?? false;
      anywhere ||= listed;
      if (!listed && row[MUSIC_ALBUM_ID[kind]]) {
        changes[MUSIC_ALBUM_ID[kind]] = null;
      }
    }
    // An unmatched row no server lists any more existed only for that
    // listing.
    if (!row.mbId && !anywhere) {
      await getRepository(MusicAlbum).delete(row.id);
      touched.add(row.mediaId);
      continue;
    }
    const withFiles = (index.album(row.mbId)?.trackFileCount ?? 0) > 0;
    if (HERE.includes(row.status) && !anywhere && !withFiles) {
      changes.status =
        row.mbId && requested.get(row.mediaId)?.has(row.mbId)
          ? MediaStatus.DELETED
          : MediaStatus.UNKNOWN;
      events.push({
        mediaId: row.mediaId,
        type: MediaEventType.REMOVED,
        title: row.title,
      });
    }
    if (Object.keys(changes).length) {
      await getRepository(MusicAlbum).update(row.id, changes);
      touched.add(row.mediaId);
    }
  }

  // Clear artist ids on servers that no longer list any of their albums.
  const artists = await getRepository(Media).find({
    select: {
      id: true,
      ratingKey: true,
      jellyfinMediaId: true,
      embyMediaId: true,
    },
    where: { mediaType: MediaType.MUSIC },
  });
  for (const artist of artists) {
    const changes: Partial<Media> = {};
    for (const kind of MEDIA_SERVER_KINDS) {
      const column = MEDIA_ID[kind][0];
      if (artist[column] && !seen.artists.get(kind)?.has(artist.id)) {
        changes[column] = null;
      }
    }
    if (Object.keys(changes).length) {
      await getRepository(Media).update(artist.id, changes);
      touched.add(artist.id);
    }
  }

  await recordAlbumEvents(events);
  return touched;
};

/** Recomputes artist statuses and sets mediaAddedAt when first available. */
export const refreshArtists = async (
  mediaIds: Iterable<number>,
  index?: LidarrIndex
): Promise<void> => {
  const ids = [...new Set(mediaIds)];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    await dataSource.transaction(async (manager) => {
      const artists = await manager.find(Media, {
        select: { id: true, status: true, mediaAddedAt: true },
        where: { id: In(chunk), mediaType: MediaType.MUSIC },
      });
      const albums = await manager.find(MusicAlbum, {
        select: { id: true, mediaId: true, mbId: true, status: true },
        where: { mediaId: In(chunk) },
      });
      const requested = await requestedAlbums(manager, chunk);

      for (const artist of artists) {
        const own = albums.filter((album) => album.mediaId === artist.id);
        const status = artistStatus(
          artist.status,
          own.map((album) => ({
            status: album.status,
            wanted:
              !!album.mbId &&
              (!!requested.get(artist.id)?.has(album.mbId) ||
                !!index?.album(album.mbId)?.monitored),
          }))
        );
        const changes: Partial<Media> = {};
        if (status !== artist.status) changes.status = status;
        if (HERE.includes(status) && !artist.mediaAddedAt) {
          changes.mediaAddedAt = new Date();
        }
        if (Object.keys(changes).length) {
          await manager.update(Media, artist.id, changes);
        }
      }
    });
  }
};
