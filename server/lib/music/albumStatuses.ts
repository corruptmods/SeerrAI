import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { lidarrOnly } from '@server/lib/music/availability';
import { songFetchStages } from '@server/lib/music/songFetch';
import { In } from 'typeorm';

/**
 * Sets each requested album's availability for request cards, since a
 * request's status only says whether it was approved. One query for all
 * requests; non-music requests are untouched.
 */
export const attachAlbumStatuses = async (
  requests: Pick<MediaRequest, 'type' | 'media' | 'albums' | 'songs'>[]
): Promise<void> => {
  await attachSongStages(requests);
  const music = requests.filter(
    (request) =>
      request.type === MediaType.MUSIC &&
      request.media?.id &&
      request.albums?.length
  );
  if (!music.length) {
    return;
  }

  const rows = await getRepository(MusicAlbum).find({
    select: {
      id: true,
      mediaId: true,
      mbId: true,
      status: true,
      trackFileCount: true,
    },
    where: {
      mediaId: In([...new Set(music.map((request) => request.media.id))]),
    },
  });
  const byKey = new Map(rows.map((row) => [`${row.mediaId}:${row.mbId}`, row]));
  // Lidarr has the files but no media server lists them yet (see
  // albumsBeingAdded). Skipped when Lidarr alone decides availability.
  const serversDecide = !lidarrOnly();

  for (const request of music) {
    for (const album of request.albums) {
      const row = byKey.get(`${request.media.id}:${album.albumMbid}`);
      album.albumStatus = row?.status;
      if (
        serversDecide &&
        row?.status === MediaStatus.PROCESSING &&
        (row.trackFileCount ?? 0) > 0
      ) {
        album.addingToLibrary = true;
      }
    }
  }
};

/** Sets the fetch stage ("Downloading, 40%") on songs taken from albums. */
const attachSongStages = async (
  requests: Pick<MediaRequest, 'type' | 'songs'>[]
): Promise<void> => {
  const songs = requests
    .filter((request) => request.type === MediaType.MUSIC)
    .flatMap((request) => request.songs ?? [])
    .filter(
      (song) =>
        song.sourceAlbumMbid && song.status === MediaRequestStatus.APPROVED
    );
  if (!songs.length) {
    return;
  }
  const stages = await songFetchStages(songs);
  for (const song of songs) {
    song.fetchStage = stages.get(
      `${song.sourceAlbumMbid}:${song.recordingMbid}`
    );
  }
};
