import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { MediaList, PlaylistSongState } from '@server/entity/MediaList';
import { MediaListSong } from '@server/entity/MediaList';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { featureEnabled } from '@server/lib/features';
import { musicReady } from '@server/lib/music/access';
import { addToMusicBrainzUrl } from '@server/lib/music/catalogSong';
import { albumsWaitingToSearch } from '@server/lib/music/songFetchWaits';
import type { SongProgress } from '@server/lib/music/songProgress';
import { songProgress } from '@server/lib/music/songProgress';
import { In, Not } from 'typeorm';

/** True when music is set up and enabled for this user. */
export const musicAllowed = (user: User | undefined): boolean =>
  !!user && musicReady() && featureEnabled('music', user);

/**
 * A playlist song's displayed state. Requested songs follow their request:
 * approval, declined, or here once completed.
 */
export type PlaylistSongShown =
  | Exclude<PlaylistSongState, 'matched' | 'waiting' | 'removed'>
  | 'queued'
  | 'limit'
  | 'declined'
  /** Requested, but couldn't be fetched. */
  | 'notGot';

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
  /** Progress of a requested song, when known. */
  progress: SongProgress | null;
  /**
   * Harmony link prefilling MusicBrainz's add form from Deezer, for songs
   * MusicBrainz lacks but Deezer has.
   */
  addToMusicBrainz: string | null;
}

export interface PlaylistView {
  sourceUrl: string | null;
  sourceService: string | null;
  sourceName: string | null;
  sourceReadAt: Date | null;
  sourceProblem: string | null;
  /** Albums of its songs waiting to search again; retryable now. */
  waitingToSearch: number;
  songs: PlaylistSongView[];
}

const shownState = (
  song: MediaListSong,
  requestStatus: MediaRequestStatus | undefined
): PlaylistSongShown => {
  if (song.state === 'matched') return 'queued';
  if (song.state === 'waiting') {
    // A problem other than a limit (e.g. song requests off) shows as failed.
    return song.problem === 'limit'
      ? 'limit'
      : song.problem
        ? 'failed'
        : 'queued';
  }
  if (song.state === 'requested' || song.state === 'approval') {
    switch (requestStatus) {
      // Request deleted: Try again requests it afresh.
      case undefined:
        return song.requestId ? 'notGot' : 'requested';
      case MediaRequestStatus.PENDING:
        return 'approval';
      case MediaRequestStatus.DECLINED:
        return 'declined';
      case MediaRequestStatus.COMPLETED:
        return 'here';
      case MediaRequestStatus.FAILED:
        return 'notGot';
      default:
        return 'requested';
    }
  }
  return song.state as PlaylistSongShown;
};

/** A playlist's source and songs in order, for its page. */
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
        select: {
          id: true,
          status: true,
          requestedBy: { id: true },
          songs: {
            id: true,
            recordingMbid: true,
            status: true,
            singleMbid: true,
            singleTitle: true,
            sourceAlbumMbid: true,
            sourceAlbumTitle: true,
          },
        },
        relations: { songs: true, requestedBy: true },
        where: { id: In(requestIds) },
      })
    : [];
  // Use each song's own status: one failed song fails the request but not
  // its other songs.
  const statusOf = (song: MediaListSong) => {
    const request = requests.find((r) => r.id === song.requestId);
    const status =
      request?.songs?.find((s) => s.recordingMbid === song.recordingMbid)
        ?.status ?? request?.status;
    // A declined request by someone else counts as not got, so Try again
    // requests it in the owner's name.
    return status === MediaRequestStatus.DECLINED &&
      request?.requestedBy?.id !== song.requestForId
      ? MediaRequestStatus.FAILED
      : status;
  };
  const progress = await songProgress(
    requests.flatMap((request) => request.songs ?? [])
  );
  const waitingToSearch = await albumsWaitingToSearch(
    songs
      .filter(
        (song) =>
          (song.state === 'requested' || song.state === 'approval') &&
          song.recordingMbid
      )
      .map((song) => song.recordingMbid!)
  );
  return {
    waitingToSearch,
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
      state: shownState(song, song.requestId ? statusOf(song) : undefined),
      problem:
        song.state === 'failed' ||
        (song.state === 'waiting' && song.problem && song.problem !== 'limit')
          ? (song.problem ?? null)
          : null,
      progress:
        song.requestId && song.recordingMbid
          ? (progress.get(song.recordingMbid) ?? null)
          : null,
      addToMusicBrainz:
        song.state === 'unmatched' && song.catalog?.albumId
          ? addToMusicBrainzUrl(song.catalog.albumId)
          : null,
    })),
  };
};
