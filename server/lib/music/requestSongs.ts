import { musicBrainz } from '@server/api/musicbrainz';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MusicAlbum from '@server/entity/MusicAlbum';
import SongRequest from '@server/entity/SongRequest';
import type { SongVersion } from '@server/lib/music/songs';
import { toVersion } from '@server/lib/music/songs';
import type { MusicSongStatus } from '@server/models/Music';
import { In, Not } from 'typeorm';

/*
 * What a music request needs to know about the songs asked for: each
 * version's title, what names it, and the albums and singles it is on,
 * kept on the request so cards and notifications never ask MusicBrainz.
 * And whether each is already here or on its way: asked for already, or
 * on an album that is.
 */

/** A song asked for that MusicBrainz does not credit to the artist. */
export class NotTheArtistsSongError extends Error {}

/** A song only on unofficial copies, or only a part of a DJ mix. */
export class UnrequestableSongError extends Error {}

/** An album's status that means it, and every song on it, is coming. */
const COVERING = [
  MediaStatus.PENDING,
  MediaStatus.PROCESSING,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.AVAILABLE,
];

/** A song request's status that means the song is asked for or here. */
const ASKED = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.COMPLETED,
];

/**
 * The versions asked for, in the order asked. Each must credit the
 * artist, and be on at least one release that can be fetched.
 */
export const resolveRequestSongs = async (
  artistMbid: string,
  recordingMbids: string[]
): Promise<SongVersion[]> => {
  const mb = musicBrainz();
  const songs: SongVersion[] = [];
  for (const id of recordingMbids) {
    const recording = await mb.getRecording(id);
    if (!recording) {
      throw new UnrequestableSongError('MusicBrainz has no such song.');
    }
    if (
      !(recording['artist-credit'] ?? []).some(
        (credit) => credit.artist.id === artistMbid
      )
    ) {
      throw new NotTheArtistsSongError(
        `${recording.title} is not a song of this artist.`
      );
    }
    const version = toVersion(recording);
    if (!version) {
      throw new UnrequestableSongError(
        `${recording.title} is not on any release that can be fetched.`
      );
    }
    songs.push(version);
  }
  return songs;
};

/** Why a song cannot be asked for: already asked for, or its album is. */
export type SongCovered =
  | { by: 'request'; status: MediaRequestStatus }
  | { by: 'album'; albumMbid: string; status: MediaStatus };

/**
 * For each version, whatever already brings it: a request for it that is
 * not declined, or an album or single it is on that is here or on its way.
 */
export const songsCovered = async (
  versions: Pick<SongVersion, 'mbId' | 'releaseGroups'>[]
): Promise<Map<string, SongCovered>> => {
  const covered = new Map<string, SongCovered>();
  if (!versions.length) {
    return covered;
  }

  const asked = await getRepository(SongRequest).find({
    select: { id: true, recordingMbid: true, status: true },
    where: {
      recordingMbid: In(versions.map((version) => version.mbId)),
      status: In(ASKED),
      request: {
        type: MediaType.MUSIC,
        status: Not(MediaRequestStatus.DECLINED),
      },
    },
    relations: { request: true },
  });
  for (const song of asked) {
    const known = covered.get(song.recordingMbid);
    // A song here outranks one only asked for.
    if (
      !known ||
      (known.by === 'request' && song.status === MediaRequestStatus.COMPLETED)
    ) {
      covered.set(song.recordingMbid, { by: 'request', status: song.status });
    }
  }

  const groupIds = [
    ...new Set(
      versions.flatMap((version) =>
        version.releaseGroups.map((group) => group.mbId)
      )
    ),
  ];
  const albums = groupIds.length
    ? await getRepository(MusicAlbum).find({
        select: { id: true, mbId: true, status: true },
        where: { mbId: In(groupIds), status: In(COVERING) },
      })
    : [];
  const albumStatus = new Map<string, MediaStatus>();
  for (const album of albums) {
    const known = albumStatus.get(album.mbId as string);
    if (!known || COVERING.indexOf(album.status) > COVERING.indexOf(known)) {
      albumStatus.set(album.mbId as string, album.status);
    }
  }
  for (const version of versions) {
    if (covered.has(version.mbId)) {
      continue;
    }
    // The one furthest along; among those, the best known.
    const on = version.releaseGroups
      .filter((group) => albumStatus.has(group.mbId))
      .sort(
        (a, b) =>
          COVERING.indexOf(albumStatus.get(b.mbId) as MediaStatus) -
          COVERING.indexOf(albumStatus.get(a.mbId) as MediaStatus)
      )[0];
    if (on) {
      covered.set(version.mbId, {
        by: 'album',
        albumMbid: on.mbId,
        status: albumStatus.get(on.mbId) as MediaStatus,
      });
    }
  }
  return covered;
};

/** A request's status, as a song's status here. */
const REQUEST_STANDING: Partial<Record<MediaRequestStatus, MediaStatus>> = {
  [MediaRequestStatus.PENDING]: MediaStatus.PENDING,
  [MediaRequestStatus.APPROVED]: MediaStatus.PROCESSING,
  [MediaRequestStatus.COMPLETED]: MediaStatus.AVAILABLE,
};

/**
 * Where each version stands, as pages show it: its own request's status,
 * or the album bringing it, by recording id.
 */
export const songStandings = async (
  versions: Pick<SongVersion, 'mbId' | 'releaseGroups'>[]
): Promise<Map<string, MusicSongStatus>> => {
  const covered = await songsCovered(versions);
  const standings = new Map<string, MusicSongStatus>();
  for (const version of versions) {
    const by = covered.get(version.mbId);
    if (by?.by === 'request') {
      standings.set(version.mbId, { status: REQUEST_STANDING[by.status] });
    } else if (by?.by === 'album') {
      const album = version.releaseGroups.find(
        (group) => group.mbId === by.albumMbid
      );
      standings.set(version.mbId, {
        status: by.status,
        onAlbum: { id: by.albumMbid, title: album?.title ?? '' },
      });
    }
  }
  return standings;
};
