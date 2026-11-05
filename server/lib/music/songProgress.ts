import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import SongFetch from '@server/entity/SongFetch';
import type SongRequest from '@server/entity/SongRequest';
import downloadTracker from '@server/lib/downloadtracker';
import { ACTIVE } from '@server/lib/music/songFetch';
import { SEARCHING_SOON } from '@server/lib/music/songFetchWaits';
import { In } from 'typeorm';

/*
 * Per-song progress for a playlist page: single search, album search,
 * waiting to retry, downloading or importing.
 */

export type SongProgress =
  /** Lidarr is searching for the song's single. */
  | { step: 'single'; release: string }
  /** Seerr is adding the album to Lidarr before searching. */
  | { step: 'preparing'; release: string }
  | { step: 'searching'; release: string }
  /** Nothing found yet; retries at searchAgainAt. */
  | { step: 'waiting'; release: string; searchAgainAt: Date }
  /** Release chosen, waiting for a download slot. */
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

/** Download progress in whole percent, or null when size is unknown. */
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

/** Progress from Lidarr's or Backfill's download queue for the album. */
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

/** Progress of each approved song, keyed by recording id. */
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
    } else if (
      fetch.searchAgainAt &&
      fetch.searchAgainAt > now &&
      // A short wait on Prowlarr or an indexer still counts as searching.
      !fetch.stage?.startsWith(SEARCHING_SOON)
    ) {
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
