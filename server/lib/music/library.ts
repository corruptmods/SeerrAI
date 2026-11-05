import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { PlayLink } from '@server/entity/Media';
import Media from '@server/entity/Media';
import MusicAlbum from '@server/entity/MusicAlbum';
import { albumPlayLinks } from '@server/lib/mediaServers';
import { lidarrOnly } from '@server/lib/music/availability';
import type { Statuses } from '@server/models/Music';
import { In, MoreThan } from 'typeorm';

/*
 * Stored statuses of artists and albums by MusicBrainz id. Nothing here
 * queries MusicBrainz.
 */

/** Ids per query; well under SQLite's 999 bound parameters. */
const CHUNK = 500;

const chunks = (ids: string[]): string[][] => {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    out.push(unique.slice(i, i + CHUNK));
  }
  return out;
};

/** Artist statuses by MusicBrainz id. */
export const artistStatuses = async (ids: string[]): Promise<Statuses> => {
  const statuses: Statuses = new Map();
  for (const chunk of chunks(ids)) {
    const rows = await getRepository(Media).find({
      select: { id: true, foreignId: true, status: true },
      where: { mediaType: MediaType.MUSIC, foreignId: In(chunk) },
    });
    for (const row of rows) {
      if (row.foreignId && row.status !== MediaStatus.UNKNOWN) {
        statuses.set(row.foreignId, row.status);
      }
    }
  }
  return statuses;
};

/**
 * Album statuses by MusicBrainz id. A collaboration can be stored under two
 * artists; the more advanced status wins.
 */
export const albumStatuses = async (ids: string[]): Promise<Statuses> => {
  const statuses: Statuses = new Map();
  for (const chunk of chunks(ids)) {
    const rows = await getRepository(MusicAlbum).find({
      select: { id: true, mbId: true, status: true },
      where: { mbId: In(chunk) },
    });
    for (const row of rows) {
      if (!row.mbId || row.status === MediaStatus.UNKNOWN) {
        continue;
      }
      const known = statuses.get(row.mbId);
      if (!known || rank(row.status) > rank(known)) {
        statuses.set(row.mbId, row.status);
      }
    }
  }
  return statuses;
};

/**
 * Albums Lidarr has files for that no media server lists yet. Empty when
 * Lidarr alone decides availability, since those albums count as available.
 */
export const albumsBeingAdded = async (ids: string[]): Promise<Set<string>> => {
  const adding = new Set<string>();
  if (lidarrOnly()) {
    return adding;
  }
  for (const chunk of chunks(ids)) {
    const rows = await getRepository(MusicAlbum).find({
      select: { id: true, mbId: true },
      where: {
        mbId: In(chunk),
        status: MediaStatus.PROCESSING,
        trackFileCount: MoreThan(0),
      },
    });
    for (const row of rows) {
      if (row.mbId) adding.add(row.mbId);
    }
  }
  return adding;
};

/** Sets addingToLibrary on albums from albumsBeingAdded. */
export const markBeingAdded = async <
  T extends { id: string; addingToLibrary?: boolean },
>(
  albums: T[]
): Promise<T[]> => {
  const adding = await albumsBeingAdded(albums.map((album) => album.id));
  for (const album of albums) {
    if (adding.has(album.id)) album.addingToLibrary = true;
  }
  return albums;
};

/** Status order, for picking the more advanced of two. */
const rank = (status: MediaStatus): number =>
  [
    MediaStatus.UNKNOWN,
    MediaStatus.DELETED,
    MediaStatus.BLOCKLISTED,
    MediaStatus.PENDING,
    MediaStatus.PROCESSING,
    MediaStatus.PARTIALLY_AVAILABLE,
    MediaStatus.AVAILABLE,
  ].indexOf(status);

/** The artist's media row with its requests. */
export const artistMedia = async (
  artistMbid: string
): Promise<Media | undefined> =>
  (await getRepository(Media).findOne({
    where: { mediaType: MediaType.MUSIC, foreignId: artistMbid },
    relations: { requests: true },
  })) ?? undefined;

/** Play links for an album from each media server's ids. */
export const albumLinks = async (albumMbid: string): Promise<PlayLink[]> =>
  albumPlayLinks(
    await getRepository(MusicAlbum).find({
      select: {
        id: true,
        ratingKey: true,
        jellyfinItemId: true,
        embyItemId: true,
      },
      where: { mbId: albumMbid },
    })
  );
