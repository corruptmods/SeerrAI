import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import SongFetch from '@server/entity/SongFetch';
import type SongRequest from '@server/entity/SongRequest';
import downloadTracker from '@server/lib/downloadtracker';
import { ACTIVE } from '@server/lib/music/songFetch';
import { In } from 'typeorm';

/*
 * Where a requested song is on its way, for a playlist's page to say of
 * each: Lidarr looking for its single, Seerr searching for a release of
 * its album, waiting to search again, downloading or importing.
 */

export type SongProgress =
  /** Lidarr is looking for the single that has it. */
  | { step: 'single'; release: string }
  /** Seerr is setting up its album in Lidarr, about to search. */
  | { step: 'preparing'; release: string }
  | { step: 'searching'; release: string }
  /** Nothing found yet; searched again then. */
  | { step: 'waiting'; release: string; searchAgainAt: Date }
  /** A release is chosen, waiting for a download slot. */
  | { step: 'slot'; release: string }
  | { step: 'downloading'; release: string; percent: number | null }
  | { step: 'importing'; release: string };

type Song = Pick<
  SongRequest,
  | 'recordingMbid'
  | 'status'
  | 'singleMbid'
  | 'singleTitle'
  | 'sourceAlbumMbid'
  | 'sourceAlbumTitle'
>;

/** How much of a download is done, in whole percent, when known. */
const percentOf = (item: { size: number; sizeLeft: number }) =>
  item.size > 0
    ? Math.max(
        0,
        Math.min(
          100,
          Math.floor(((item.size - item.sizeLeft) / item.size) * 100)
        )
      )
    : null;

/** A download in Lidarr's queue, or Backfill's, for the release. */
const downloadOf = (
  albumMbid: string,
  release: string
): SongProgress | undefined => {
  const item = downloadTracker.getAlbumDownload(albumMbid);
  if (!item) return undefined;
  return item.stage === 'importing' || item.stage === 'imported'
    ? { step: 'importing', release }
    : { step: 'downloading', release, percent: percentOf(item) };
};

/** Each approved song's progress, by its recording. */
export const songProgress = async (
  songs: Song[],
  now = new Date()
): Promise<Map<string, SongProgress>> => {
  const progress = new Map<string, SongProgress>();
  const approved = songs.filter(
    (song) => song.status === MediaRequestStatus.APPROVED
  );
  const albums = [
    ...new Set(
      approved.flatMap((song) =>
        !song.singleMbid && song.sourceAlbumMbid ? [song.sourceAlbumMbid] : []
      )
    ),
  ];
  const fetches = albums.length
    ? await getRepository(SongFetch).find({
        where: { albumMbid: In(albums), status: In(ACTIVE) },
      })
    : [];

  for (const song of approved) {
    if (song.singleMbid) {
      const release = song.singleTitle ?? '';
      progress.set(
        song.recordingMbid,
        downloadOf(song.singleMbid, release) ?? { step: 'single', release }
      );
      continue;
    }
    if (!song.sourceAlbumMbid) continue;
    const fetch = fetches.find(
      (f) =>
        f.albumMbid === song.sourceAlbumMbid &&
        f.recordings.includes(song.recordingMbid)
    );
    const release = fetch?.albumTitle ?? song.sourceAlbumTitle ?? '';
    if (!fetch || fetch.status === 'queued') {
      progress.set(song.recordingMbid, { step: 'preparing', release });
    } else if (fetch.status === 'importing') {
      progress.set(song.recordingMbid, { step: 'importing', release });
    } else if (fetch.status === 'downloading') {
      progress.set(
        song.recordingMbid,
        downloadOf(fetch.albumMbid, release) ?? {
          step: 'downloading',
          release,
          percent: null,
        }
      );
    } else if (fetch.searchAgainAt && fetch.searchAgainAt > now) {
      progress.set(song.recordingMbid, {
        step: 'waiting',
        release,
        searchAgainAt: fetch.searchAgainAt,
      });
    } else if (fetch.release && fetch.files.length) {
      progress.set(song.recordingMbid, { step: 'slot', release });
    } else {
      progress.set(song.recordingMbid, { step: 'searching', release });
    }
  }
  return progress;
};
