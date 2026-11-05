import { musicBrainz } from '@server/api/musicbrainz';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import SongRequest from '@server/entity/SongRequest';
import type { SongRelease, SongVersion } from '@server/lib/music/songs';
import { toVersion } from '@server/lib/music/songs';
import type { MusicSongStatus } from '@server/models/Music';
import { In, Not } from 'typeorm';

/*
 * Song details (title, credits, albums and singles) are stored on the
 * request so cards and notifications don't query MusicBrainz. Also works out
 * whether a song is already requested or on a requested album.
 */

/** Requested song that MusicBrainz doesn't credit to the artist. */
export class NotTheArtistsSongError extends Error {}

/** Song only on unofficial releases or only part of a DJ mix. */
export class UnrequestableSongError extends Error {}

/**
 * Album statuses that cover every song on it. Partly available albums may
 * lack the song (a song taken from it brings only that one), so they count
 * only for a song that came on that album.
 */
const COVERING = [
  MediaStatus.PENDING,
  MediaStatus.PROCESSING,
  MediaStatus.AVAILABLE,
];
const CAME_ON = [...COVERING, MediaStatus.PARTIALLY_AVAILABLE];

/**
 * Song request statuses that cover the song. Completed ones are judged by
 * the album or single they came on.
 */
const ASKED = [MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED];

/**
 * The requested versions, in order. Each must credit the artist and be on
 * a fetchable release.
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

/** Why a song can't be requested: it or its album already is. */
export type SongCovered =
  | { by: 'request'; status: MediaRequestStatus }
  | { by: 'album'; albumMbid: string; albumTitle: string; status: MediaStatus };

type CoverableSong = Pick<SongVersion, 'mbId'> & {
  releaseGroups: Pick<SongRelease, 'mbId' | 'title'>[];
};

/**
 * What already covers each version: a non-declined request for it, or an
 * album or single it's on (including one it was fetched through) that is
 * available or on its way.
 */
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
    // Approved outranks pending.
    if (!known || song.status === MediaRequestStatus.APPROVED) {
      covered.set(song.recordingMbid, { by: 'request', status: song.status });
    }
  }

  // Treat the single or album a completed song came on as one of its
  // albums: track lists don't say which singles hold a song, and an album a
  // song was taken from has it even when only partly available.
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
    // Most advanced status; ties keep MusicBrainz's order.
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
        // Taken from a partly available album: the song itself is here.
        status:
          on.came && status === MediaStatus.PARTIALLY_AVAILABLE
            ? MediaStatus.AVAILABLE
            : status,
      });
    }
  }

  // A requested album covers all its songs, even if its row says partly
  // available from an earlier song fetch.
  const open = versions.filter((version) => !covered.has(version.mbId));
  const openGroups = [
    ...new Set(
      open.flatMap((version) =>
        version.releaseGroups.map((group) => group.mbId)
      )
    ),
  ];
  if (openGroups.length) {
    const wanted = await getRepository(AlbumRequest).find({
      select: { id: true, albumMbid: true, status: true, title: true },
      where: {
        albumMbid: In(openGroups),
        status: In(ASKED),
        request: {
          type: MediaType.MUSIC,
          status: In(ASKED),
        },
      },
      relations: { request: true },
    });
    for (const version of open) {
      const album = wanted
        .filter((a) =>
          version.releaseGroups.some((group) => group.mbId === a.albumMbid)
        )
        .sort((a, b) => b.status - a.status)[0];
      if (album) {
        covered.set(version.mbId, {
          by: 'album',
          albumMbid: album.albumMbid,
          albumTitle: album.title,
          status:
            album.status === MediaRequestStatus.APPROVED
              ? MediaStatus.PROCESSING
              : MediaStatus.PENDING,
        });
      }
    }
  }
  return covered;
};

/** Song status shown for each covering request status. */
const REQUEST_STANDING: Partial<Record<MediaRequestStatus, MediaStatus>> = {
  [MediaRequestStatus.PENDING]: MediaStatus.PENDING,
  [MediaRequestStatus.APPROVED]: MediaStatus.PROCESSING,
};

/**
 * Display status per recording id: from its own request, or the album that
 * covers it.
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
