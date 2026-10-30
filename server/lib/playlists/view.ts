import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { MediaList, PlaylistSongState } from '@server/entity/MediaList';
import { MediaListSong } from '@server/entity/MediaList';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { featureEnabled } from '@server/lib/features';
import { musicReady } from '@server/lib/music/access';
import { In, Not } from 'typeorm';

/** Whether this person can have playlists: music is set up and on for them. */
export const musicAllowed = (user: User | undefined): boolean =>
  !!user && musicReady() && featureEnabled('music', user);

/**
 * Where a song on a playlist is, as its page shows it. A requested one
 * follows its request: waiting for approval, declined, or here once done.
 */
export type PlaylistSongShown =
  | Exclude<PlaylistSongState, 'matched' | 'waiting' | 'removed'>
  | 'queued'
  | 'limit'
  | 'declined';

export interface PlaylistSongView {
  id: number;
  title: string;
  artistName: string;
  length: number | null;
  artistMbid: string | null;
  recordingMbid: string | null;
  albumMbid: string | null;
  state: PlaylistSongShown;
  problem: string | null;
}

export interface PlaylistView {
  sourceUrl: string | null;
  sourceService: string | null;
  sourceName: string | null;
  sourceReadAt: Date | null;
  sourceProblem: string | null;
  songs: PlaylistSongView[];
}

const shownState = (
  song: MediaListSong,
  requestStatus: MediaRequestStatus | undefined
): PlaylistSongShown => {
  if (song.state === 'matched') return 'queued';
  if (song.state === 'waiting') {
    return song.problem === 'limit' ? 'limit' : 'queued';
  }
  if (song.state === 'requested' || song.state === 'approval') {
    switch (requestStatus) {
      case MediaRequestStatus.PENDING:
        return 'approval';
      case MediaRequestStatus.DECLINED:
        return 'declined';
      case MediaRequestStatus.COMPLETED:
        return 'here';
      case MediaRequestStatus.FAILED:
        return 'failed';
      default:
        return 'requested';
    }
  }
  return song.state as PlaylistSongShown;
};

/** A playlist's link and songs, in order, as its page shows them. */
export const playlistView = async (list: MediaList): Promise<PlaylistView> => {
  const songs = await getRepository(MediaListSong).find({
    where: { listId: list.id, state: Not('removed') },
    order: { position: 'ASC' },
  });
  const requestIds = [
    ...new Set(
      songs.map((s) => s.requestId).filter((id): id is number => !!id)
    ),
  ];
  const requests = requestIds.length
    ? await getRepository(MediaRequest).find({
        select: { id: true, status: true },
        where: { id: In(requestIds) },
      })
    : [];
  const statusOf = new Map(requests.map((r) => [r.id, r.status]));
  return {
    sourceUrl: list.sourceUrl ?? null,
    sourceService: list.sourceService ?? null,
    sourceName: list.sourceName ?? null,
    sourceReadAt: list.sourceReadAt ?? null,
    sourceProblem: list.sourceProblem ?? null,
    songs: songs.map((song) => ({
      id: song.id,
      title: song.title,
      artistName: song.artistName,
      length: song.length ?? null,
      artistMbid: song.artistMbid ?? null,
      recordingMbid: song.recordingMbid ?? null,
      albumMbid: song.albumMbid ?? null,
      state: shownState(
        song,
        song.requestId ? statusOf.get(song.requestId) : undefined
      ),
      problem: song.state === 'failed' ? (song.problem ?? null) : null,
    })),
  };
};
