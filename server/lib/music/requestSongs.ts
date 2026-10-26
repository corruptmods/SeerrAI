import { musicBrainz } from '@server/api/musicbrainz';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MusicAlbum from '@server/entity/MusicAlbum';
import SongRequest from '@server/entity/SongRequest';
import type { SongRelease, SongVersion } from '@server/lib/music/songs';
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

/**
 * An album's status that means it, and every song on it, is coming. One
 * only partly here may not have the song (one taken from it has only that
 * song), unless the song came on it.
 */
const COVERING = [
  MediaStatus.PENDING,
  MediaStatus.PROCESSING,
  MediaStatus.AVAILABLE,
];
const CAME_ON = [...COVERING, MediaStatus.PARTIALLY_AVAILABLE];

/**
 * A song request's status that means the song is on its way. One done is
 * as here as the single it came on, which the albums below say.
 */
const ASKED = [MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED];

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
  | { by: 'album'; albumMbid: string; albumTitle: string; status: MediaStatus };

/**
 * For each version, whatever already brings it: a request for it that is
 * not declined, or an album or single it is on that is here or on its way
 * (a single it was fetched through, too).
 */
/** A song as covering needs it: its id and the albums it is on. */
type CoverableSong = Pick<SongVersion, 'mbId'> & {
  releaseGroups: Pick<SongRelease, 'mbId' | 'title'>[];
};

export const songsCovered = async (
  versions: CoverableSong[]
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
    // One approved outranks one only waiting for approval.
    if (!known || song.status === MediaRequestStatus.APPROVED) {
      covered.set(song.recordingMbid, { by: 'request', status: song.status });
    }
  }

  // The singles and albums songs asked for before came on, as albums each
  // is on: a track list does not say which singles hold its songs, and an
  // album a song was taken from holds it even though partly here.
  const done = await getRepository(SongRequest).find({
    select: {
      id: true,
      recordingMbid: true,
      singleMbid: true,
      singleTitle: true,
      sourceAlbumMbid: true,
      sourceAlbumTitle: true,
    },
    where: {
      recordingMbid: In(versions.map((version) => version.mbId)),
      status: MediaRequestStatus.COMPLETED,
    },
  });
  const groupsOf = (version: CoverableSong) => [
    ...version.releaseGroups.map((group) => ({
      mbId: group.mbId,
      title: group.title,
      came: false,
    })),
    ...done
      .filter(
        (song) =>
          song.recordingMbid === version.mbId &&
          (song.singleMbid || song.sourceAlbumMbid)
      )
      .map((song) => ({
        mbId: (song.singleMbid ?? song.sourceAlbumMbid) as string,
        title:
          (song.singleMbid ? song.singleTitle : song.sourceAlbumTitle) ?? '',
        came: true,
      })),
  ];

  const groupIds = [
    ...new Set(
      versions.flatMap((version) =>
        groupsOf(version).map((group) => group.mbId)
      )
    ),
  ];
  const albums = groupIds.length
    ? await getRepository(MusicAlbum).find({
        select: { id: true, mbId: true, status: true },
        where: { mbId: In(groupIds), status: In(CAME_ON) },
      })
    : [];
  const albumStatus = new Map<string, MediaStatus>();
  for (const album of albums) {
    const known = albumStatus.get(album.mbId as string);
    if (!known || CAME_ON.indexOf(album.status) > CAME_ON.indexOf(known)) {
      albumStatus.set(album.mbId as string, album.status);
    }
  }
  for (const version of versions) {
    if (covered.has(version.mbId)) {
      continue;
    }
    // The one furthest along; among those, the best known.
    const on = groupsOf(version)
      .filter((group) =>
        (group.came ? CAME_ON : COVERING).includes(
          albumStatus.get(group.mbId) as MediaStatus
        )
      )
      .sort(
        (a, b) =>
          CAME_ON.indexOf(albumStatus.get(b.mbId) as MediaStatus) -
          CAME_ON.indexOf(albumStatus.get(a.mbId) as MediaStatus)
      )[0];
    if (on) {
      const status = albumStatus.get(on.mbId) as MediaStatus;
      covered.set(version.mbId, {
        by: 'album',
        albumMbid: on.mbId,
        albumTitle: on.title,
        // Taken from an album only partly here: the song itself is here.
        status:
          on.came && status === MediaStatus.PARTIALLY_AVAILABLE
            ? MediaStatus.AVAILABLE
            : status,
      });
    }
  }
  return covered;
};

/** A request's status, as a song's status here. */
const REQUEST_STANDING: Partial<Record<MediaRequestStatus, MediaStatus>> = {
  [MediaRequestStatus.PENDING]: MediaStatus.PENDING,
  [MediaRequestStatus.APPROVED]: MediaStatus.PROCESSING,
};

/**
 * Where each version stands, as pages show it: its own request's status,
 * or the album bringing it, by recording id.
 */
export const songStandings = async (
  versions: CoverableSong[]
): Promise<Map<string, MusicSongStatus>> => {
  const covered = await songsCovered(versions);
  const standings = new Map<string, MusicSongStatus>();
  for (const version of versions) {
    const by = covered.get(version.mbId);
    if (by?.by === 'request') {
      standings.set(version.mbId, { status: REQUEST_STANDING[by.status] });
    } else if (by?.by === 'album') {
      standings.set(version.mbId, {
        status: by.status,
        onAlbum: { id: by.albumMbid, title: by.albumTitle },
      });
    }
  }
  return standings;
};
