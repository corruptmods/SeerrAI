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
 * A song's file among what Soulseek's sharers answered a search with: the
 * file named as the song (never a live or remixed take, nor from a live
 * album's folder), in a folder or name with the artist's, as long as the
 * track when both lengths are known. Of the sharers with the songs, the one
 * with the most of them, then one with a free upload slot, the shortest
 * queue, lossless files, and the fastest upload.
 */

/** A file's length may be this far from the track's and still be it. */
const SAME_LENGTH_MS = 8000;
const LOSSLESS = /\.(flac|alac|wav|aiff?|ape|wv)$/i;

/** What Soulseek is searched for: the artist and the song, as words. */
export const soulseekQuery = (artist: string, title: string): string =>
  `${takeWords(artist)} ${takeWords(title)}`.replace(/\s+/g, ' ').trim();

export interface SoulseekChoice {
  username: string;
  /** Each song's file, its path as the sharer names it. */
  files: SongFetchFile[];
  /** The folder the first song is in, as the sharer names it. */
  folder: string;
}

const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '');

/** The sharer to take the songs from, and each song's file of theirs. */
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

/**
 * Answers to several searches as one list, one answer for each sharer: a
 * sharer found by two songs' searches holds both.
 */
export const mergeResponses = (lists: SlskdResponse[][]): SlskdResponse[] => {
  const bySharer = new Map<string, SlskdResponse>();
  for (const response of lists.flat()) {
    const seen = bySharer.get(response.username);
    if (!seen) {
      bySharer.set(response.username, {
        ...response,
        files: [...(response.files ?? [])],
      });
      continue;
    }
    for (const file of response.files ?? []) {
      if (!seen.files.some((f) => f.filename === file.filename)) {
        seen.files.push(file);
      }
    }
  }
  return [...bySharer.values()];
};
