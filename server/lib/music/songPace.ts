import { getRepository } from '@server/datasource';
import { MediaListSong } from '@server/entity/MediaList';
import SongFetch from '@server/entity/SongFetch';
import { SEARCHES_AT_ONCE } from '@server/lib/music/singleFallback';
import {
  MAX_CATALOGS,
  MAX_OPEN,
  MAX_SOULSEEK_SEARCHES,
  MAX_SOULSEEK_TRIES,
  SEARCH_AGAIN_MS,
  WAITING_FOR_SLOT,
} from '@server/lib/music/songFetch';
import { MATCH_PER_PASS, UNMATCHED_RETRY_MS } from '@server/lib/playlists';
import { getSettings, soulseekOf } from '@server/lib/settings';
import { In } from 'typeorm';

/*
 * Song pipeline limits and current usage, for Settings → Music.
 */

const HOUR_MS = 60 * 60_000;

export interface SongPace {
  matching: { perPass: number; waiting: number; unmatchedRetryDays: number };
  singles: { searchesPerMinute: number };
  albums: {
    searching: number;
    waitingToSearchAgain: number;
    /** When the next waiting album is searched again. */
    nextSearchAt: string | null;
    /** Hours waited after each empty search, in order. */
    searchAgainHours: number[];
    releasesOpened: number;
    packsRead: number;
  };
  downloads: {
    slots: number;
    downloading: number;
    waitingForSlot: number;
    importing: number;
  };
  soulseek: {
    on: boolean;
    songsSearched: number;
    sharersTried: number;
  };
}

export const songPace = async (now = new Date()): Promise<SongPace> => {
  const [waitingToMatch, fetches] = await Promise.all([
    getRepository(MediaListSong).count({ where: { state: 'matching' } }),
    getRepository(SongFetch).find({
      select: { id: true, status: true, stage: true, searchAgainAt: true },
      where: { status: In(['searching', 'downloading', 'importing']) },
    }),
  ]);
  const waitingForSlot = fetches.filter((f) => f.stage === WAITING_FOR_SLOT);
  const searching = fetches.filter(
    (f) => f.status === 'searching' && f.stage !== WAITING_FOR_SLOT
  );
  const later = searching
    .filter((f) => f.searchAgainAt && f.searchAgainAt > now)
    .map((f) => f.searchAgainAt!.getTime());
  return {
    matching: {
      perPass: MATCH_PER_PASS,
      waiting: waitingToMatch,
      unmatchedRetryDays: Math.round(UNMATCHED_RETRY_MS / (24 * HOUR_MS)),
    },
    singles: { searchesPerMinute: SEARCHES_AT_ONCE },
    albums: {
      searching: searching.length - later.length,
      waitingToSearchAgain: later.length,
      nextSearchAt: later.length
        ? new Date(Math.min(...later)).toISOString()
        : null,
      searchAgainHours: SEARCH_AGAIN_MS.map((ms) => ms / HOUR_MS),
      releasesOpened: MAX_OPEN,
      packsRead: MAX_CATALOGS,
    },
    downloads: {
      slots: getSettings().backfill.maxMusicJobs,
      downloading: fetches.filter((f) => f.status === 'downloading').length,
      waitingForSlot: waitingForSlot.length,
      importing: fetches.filter((f) => f.status === 'importing').length,
    },
    soulseek: {
      on: !!soulseekOf(getSettings().music),
      songsSearched: MAX_SOULSEEK_SEARCHES,
      sharersTried: MAX_SOULSEEK_TRIES,
    },
  };
};
