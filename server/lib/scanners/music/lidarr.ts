import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { lidarrApi } from '@server/lib/music/access';
import type { AlbumEvent } from '@server/lib/music/availability';
import {
  STATUS_EVENTS,
  artistRow,
  fromLidarr,
  lidarrStatus,
  recordAlbumEvents,
} from '@server/lib/music/availability';
import type { IndexAlbum, LidarrIndex } from '@server/lib/music/matcher';
import { markUndispatchable } from '@server/lib/requestDispatch';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, IsNull, Not } from 'typeorm';

/*
 * Lidarr's part of the music scans.
 *
 * Requests under way: each artist's albums as Lidarr has them (so their
 * files are counted), and requested albums Lidarr did not have when the
 * request was sent. Those are added once Lidarr's metadata knows them, or
 * monitored and searched for once it lists them; after a week of Lidarr
 * not knowing one, the request fails with a reason and can be retried.
 * Nothing is ever unmonitored, and an artist's own settings are never
 * changed.
 *
 * With "Scan" on for a Lidarr (syncEnabled), the full scan also brings in
 * its library: every artist with an album Lidarr monitors or has files for.
 */

const LABEL = 'Music Scan';

/** How long a requested album may wait for Lidarr's metadata to know it. */
export const LOOKUP_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** Album requests still to be fetched. */
const OPEN = [MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED];

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

/** The artists whose requests Lidarr is working on. */
const artistsUnderWay = async (): Promise<Media[]> => {
  const ids = new Set<number>();
  const media = getRepository(Media);
  for (const row of await media.find({
    select: { id: true },
    where: {
      mediaType: MediaType.MUSIC,
      status: In([
        MediaStatus.PENDING,
        MediaStatus.PROCESSING,
        MediaStatus.PARTIALLY_AVAILABLE,
      ]),
    },
  })) {
    ids.add(row.id);
  }
  for (const row of await getRepository(MusicAlbum).find({
    select: { id: true, mediaId: true },
    where: { status: In([MediaStatus.PENDING, MediaStatus.PROCESSING]) },
  })) {
    ids.add(row.mediaId);
  }
  for (const row of await getRepository(MediaRequest)
    .createQueryBuilder('request')
    .innerJoin('request.media', 'media')
    .select('media.id', 'mediaId')
    .where('request.type = :type', { type: MediaType.MUSIC })
    .andWhere('request.status = :approved', {
      approved: MediaRequestStatus.APPROVED,
    })
    .getRawMany<{ mediaId: number | string }>()) {
    ids.add(Number(row.mediaId));
  }
  if (!ids.size) return [];
  return media.find({
    select: {
      id: true,
      foreignId: true,
      serviceId: true,
      externalServiceId: true,
    },
    where: {
      id: In([...ids]),
      mediaType: MediaType.MUSIC,
      externalServiceId: Not(IsNull()),
    },
  });
};

/**
 * Lidarr's progress on music requests (see above). Returns the artists
 * whose albums were looked at.
 */
export const lidarrInFlight = async (
  index: LidarrIndex
): Promise<Set<number>> => {
  const touched = new Set<number>();
  const settings = getSettings();
  const artists = await artistsUnderWay();

  for (const artist of artists) {
    const server = settings.lidarr.find((s) => s.id === artist.serviceId);
    if (!server || !artist.foreignId || artist.externalServiceId == null) {
      continue;
    }
    let albums: IndexAlbum[];
    try {
      albums = await index.loadArtist(
        server.id,
        artist.externalServiceId,
        artist.foreignId
      );
    } catch (e) {
      logger.warn('Lidarr did not list an artist’s albums', {
        label: LABEL,
        lidarr: server.name,
        artist: artist.foreignId,
        errorMessage: errorMessage(e),
      });
      continue;
    }
    touched.add(artist.id);

    const requests = await getRepository(MediaRequest).find({
      where: {
        type: MediaType.MUSIC,
        status: MediaRequestStatus.APPROVED,
        media: { id: artist.id },
      },
    });
    const api = lidarrApi(server);

    for (const request of requests) {
      // Albums added for an earlier request count for this one.
      albums = index.loadedAlbumsOf(server.id, artist.foreignId);
      const open = (request.albums ?? []).filter((album) =>
        OPEN.includes(album.status)
      );
      const unmonitored: number[] = [];
      const missing: typeof open = [];
      for (const album of open) {
        const inLidarr = albums.find((a) => a.mbid === album.albumMbid);
        if (!inLidarr) {
          missing.push(album);
        } else if (!inLidarr.monitored) {
          unmonitored.push(inLidarr.id);
        }
      }

      try {
        if (unmonitored.length) {
          await api.monitorAlbums(unmonitored, true);
          for (const album of albums) {
            if (unmonitored.includes(album.id)) album.monitored = true;
          }
          if (!server.preventSearch) {
            await api.searchAlbums(unmonitored);
          }
        }
      } catch (e) {
        logger.warn('Lidarr did not take requested albums', {
          label: LABEL,
          requestId: request.id,
          errorMessage: errorMessage(e),
        });
      }

      const unknown: string[] = [];
      for (const album of missing) {
        try {
          const found = await api.lookupAlbum(album.albumMbid);
          if (!found) {
            unknown.push(album.title);
            continue;
          }
          const added = await api.addAlbum(found, {
            artist: { id: artist.externalServiceId },
            searchForNewAlbum: !server.preventSearch,
          });
          index.addAlbum(server.id, added, artist.foreignId);
          logger.info('Added a requested album Lidarr did not have', {
            label: LABEL,
            requestId: request.id,
            album: album.albumMbid,
          });
        } catch (e) {
          unknown.push(album.title);
          logger.debug('Lidarr could not add a requested album yet', {
            label: LABEL,
            requestId: request.id,
            album: album.albumMbid,
            errorMessage: errorMessage(e),
          });
        }
      }

      const waitedSince = new Date(request.updatedAt).getTime();
      if (unknown.length && Date.now() - waitedSince > LOOKUP_WAIT_MS) {
        await markUndispatchable(
          request,
          unknown.length === 1
            ? `Lidarr couldn’t look up “${unknown[0]}” for a week. Retry later.`
            : `Lidarr couldn’t look up ${unknown.length} of the albums for a week: ${unknown.join(', ')}. Retry later.`
        );
      }
    }
  }

  return touched;
};

/**
 * Brings in the library of every Lidarr with Scan on: its artists with an
 * album it monitors or has files for, and those albums. An album Lidarr
 * monitors or has files for but no media server lists yet is processing;
 * with no music library switched on anywhere (`decide`), Lidarr's files
 * make it available. Needs a full index. Returns the artists touched.
 */
export const importLidarrLibrary = async (
  index: LidarrIndex,
  { decide }: { decide: boolean }
): Promise<Set<number>> => {
  const touched = new Set<number>();

  for (const server of getSettings().lidarr.filter((s) => s.syncEnabled)) {
    for (const artist of index.artistsOf(server.id)) {
      const albums = index
        .loadedAlbumsOf(server.id, artist.mbid)
        .filter((album) => album.monitored || album.trackFileCount > 0);
      if (!albums.length) continue;

      await dataSource.transaction(async (manager) => {
        const media = await artistRow(manager, artist.mbid, {
          lidarr: artist.name,
        });
        touched.add(media.id);
        const events: AlbumEvent[] = [];
        if (media.serviceId == null || media.externalServiceId == null) {
          await manager.update(Media, media.id, {
            serviceId: server.id,
            externalServiceId: artist.id,
            externalServiceSlug: artist.mbid,
          });
        }

        const rows = await manager.find(MusicAlbum, {
          where: { mediaId: media.id, mbId: In(albums.map((a) => a.mbid)) },
        });
        for (const album of albums) {
          const status =
            (decide
              ? lidarrStatus(album.trackCount, album.trackFileCount)
              : undefined) ??
            (album.monitored || !decide ? MediaStatus.PROCESSING : undefined);
          const row = rows.find((r) => r.mbId === album.mbid);
          if (!row) {
            await manager.insert(
              MusicAlbum,
              new MusicAlbum({
                mediaId: media.id,
                mbId: album.mbid,
                ...fromLidarr(album),
                status: status ?? MediaStatus.UNKNOWN,
                mediaAddedAt:
                  status === MediaStatus.AVAILABLE ||
                  status === MediaStatus.PARTIALLY_AVAILABLE
                    ? new Date()
                    : null,
              })
            );
          } else if (
            status &&
            (row.status === MediaStatus.UNKNOWN ||
              row.status === MediaStatus.DELETED)
          ) {
            await manager.update(MusicAlbum, row.id, { status });
            const type = STATUS_EVENTS[status];
            if (type)
              events.push({ mediaId: media.id, type, title: row.title });
          }
        }
        await recordAlbumEvents(events, manager);
      });
    }
  }

  return touched;
};
