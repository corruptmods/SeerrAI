import type { LidarrTrack } from '@server/api/servarr/lidarr';
import type { SlskdResponse } from '@server/api/slskd';
import type { SongFetchFile } from '@server/entity/SongFetch';
import type SongRequest from '@server/entity/SongRequest';
import {
  fileInCatalog,
  isAudio,
  namesArtist,
} from '@server/lib/music/albumRelease';
import { takeWords } from '@server/lib/music/songs';

/*
 * Picks song files from Soulseek results: named as the song (no live or
 * remix take, no live album folder), with the artist in the path, and a
 * matching length when known. Sharers rank by most songs, free upload slot,
 * shortest queue, lossless, then upload speed.
 */

/** Max length difference between a file and its track. */
const SAME_LENGTH_MS = 8000;
const LOSSLESS = /\.(flac|alac|wav|aiff?|ape|wv)$/i;

/** Soulseek query: artist and song title as plain words. */
export const soulseekQuery = (artist: string, title: string): string =>
  `${takeWords(artist)} ${takeWords(title)}`.replace(/\s+/g, ' ').trim();

export interface SoulseekChoice {
  username: string;
  /** Each song's file, with the sharer's path. */
  files: SongFetchFile[];
  /** Sharer's folder of the first song. */
  folder: string;
}

const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '');

/** Best sharer for the songs, and their file for each. */
export const chooseSharer = (
  responses: SlskdResponse[],
  wanted: { song: SongRequest; track: LidarrTrack }[],
  album: string,
  artist: string,
  /** Sharers already tried for these songs. */
  passOver: Set<string>
): SoulseekChoice | undefined => {
  const choices = responses
    .filter((r) => r.username && !passOver.has(r.username))
    .map((response) => {
      const files = (response.files ?? [])
        .map((file, index) => ({
          index,
          path: file.filename,
          size: file.size,
          length: file.length ?? null,
        }))
        .filter((file) => isAudio(file.path));
      const picked: SongFetchFile[] = [];
      for (const { song, track } of wanted) {
        const rest = files.filter(
          (file) =>
            !picked.some((p) => p.index === file.index) &&
            namesArtist(file.path, artist) &&
            (!track.duration ||
              !file.length ||
              Math.abs(file.length * 1000 - track.duration) <= SAME_LENGTH_MS)
        );
        const file = fileInCatalog(rest, track.title, album, artist);
        if (file) {
          picked.push({
            index: file.index,
            path: file.path,
            size: file.size,
            recordingMbid: song.recordingMbid,
            trackId: track.id,
          });
        }
      }
      return { response, picked };
    })
    .filter((c) => c.picked.length);
  const lossless = (c: (typeof choices)[number]) =>
    c.picked.every((file) => LOSSLESS.test(file.path));
  const best = choices.sort(
    (a, b) =>
      b.picked.length - a.picked.length ||
      Number(b.response.hasFreeUploadSlot) -
        Number(a.response.hasFreeUploadSlot) ||
      a.response.queueLength - b.response.queueLength ||
      Number(lossless(b)) - Number(lossless(a)) ||
      b.response.uploadSpeed - a.response.uploadSpeed
  )[0];
  return best
    ? {
        username: best.response.username,
        files: best.picked,
        folder: folderOf(best.picked[0].path),
      }
    : undefined;
};

/** Merges several searches' results into one response per sharer. */
export const mergeResponses = (lists: SlskdResponse[][]): SlskdResponse[] => {
  const bySharer = new Map<
    string,
    { response: SlskdResponse; names: Set<string> }
  >();
  for (const response of lists.flat()) {
    const seen = bySharer.get(response.username);
    if (!seen) {
      const files = [...(response.files ?? [])];
      bySharer.set(response.username, {
        response: { ...response, files },
        names: new Set(files.map((f) => f.filename)),
      });
      continue;
    }
    for (const file of response.files ?? []) {
      if (!seen.names.has(file.filename)) {
        seen.names.add(file.filename);
        seen.response.files.push(file);
      }
    }
  }
  return [...bySharer.values()].map((sharer) => sharer.response);
};
