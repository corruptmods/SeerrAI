import type {
  EpisodeSubtitles,
  SubtitleTrack,
} from '@server/interfaces/api/subtitlesInterfaces';

/*
 * Formatting Bazarr subtitles for the Subtitles card and episode tags: one row
 * per kind, with episode coverage for series.
 */

/** "SRT" for a file, by its extension; "IN VIDEO" for a track in the file. */
export const formatOf = (track: SubtitleTrack): string => {
  if (track.kind === 'embedded') {
    return 'IN VIDEO';
  }
  const extension = track.fileName?.split('.').pop()?.toUpperCase();
  return extension && extension.length <= 4 ? extension : 'FILE';
};

export const formatSize = (bytes?: number): string | undefined => {
  if (!bytes) {
    return undefined;
  }
  // Non-breaking space so "64 KB" never wraps.
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}\u00a0MB`
    : `${Math.max(1, Math.round(bytes / 1024))}\u00a0KB`;
};

export interface EpisodeRef {
  seasonNumber: number;
  episodeNumber: number;
}

export interface TrackGroup {
  key: string;
  language: string;
  name: string;
  format: string;
  ai: boolean;
  hi: boolean;
  forced: boolean;
  episodes: EpisodeRef[];
}

/** A series' subtitles, one row per language and kind, most episodes first. */
export const groupTracks = (
  episodes: EpisodeSubtitles[],
  wanted: string[] = []
): TrackGroup[] => {
  const groups = new Map<string, TrackGroup>();
  for (const episode of episodes) {
    const seen = new Set<string>();
    for (const track of episode.tracks) {
      const format = formatOf(track);
      const key = [
        track.language,
        track.ai ? 'AI' : format,
        track.hi ? 'hi' : '',
        track.forced ? 'forced' : '',
      ].join('|');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const group = groups.get(key) ?? {
        key,
        language: track.language,
        name: track.name,
        format,
        ai: track.ai,
        hi: track.hi,
        forced: track.forced,
        episodes: [],
      };
      group.episodes.push({
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
      });
      groups.set(key, group);
    }
  }
  const rank = (language: string) => {
    const at = wanted.indexOf(language);
    return at === -1 ? wanted.length : at;
  };
  return [...groups.values()].sort(
    (a, b) =>
      rank(a.language) - rank(b.language) ||
      b.episodes.length - a.episodes.length
  );
};

export interface MissingGroup {
  language: string;
  name: string;
  episodes: EpisodeRef[];
}

export const groupMissing = (episodes: EpisodeSubtitles[]): MissingGroup[] => {
  const groups = new Map<string, MissingGroup>();
  for (const episode of episodes) {
    for (const missing of episode.missing) {
      const group = groups.get(missing.language) ?? {
        language: missing.language,
        name: missing.name,
        episodes: [],
      };
      if (
        !group.episodes.some(
          (e) =>
            e.seasonNumber === episode.seasonNumber &&
            e.episodeNumber === episode.episodeNumber
        )
      ) {
        group.episodes.push({
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
        });
      }
      groups.set(missing.language, group);
    }
  }
  return [...groups.values()];
};

/** "1–3" or "1, 3" or "1–3, 5". */
export const ranges = (numbers: number[]): string => {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (const n of sorted.slice(1)) {
    if (n === end + 1) {
      end = n;
      continue;
    }
    parts.push(start === end ? `${start}` : `${start}–${end}`);
    start = end = n;
  }
  if (sorted.length) {
    parts.push(start === end ? `${start}` : `${start}–${end}`);
  }
  return parts.join(', ');
};

/**
 * A set of episodes: whole seasons ("Seasons 1–3"), part of one ("S4 E1–10"),
 * or parts of several ("Seasons 3, 4").
 */
export type Where =
  | { kind: 'seasons'; seasons: number[] }
  | { kind: 'episodes'; season: number; episodes: string };

export const whereAre = (
  refs: EpisodeRef[],
  all: EpisodeSubtitles[]
): Where => {
  const seasons = [...new Set(refs.map((r) => r.seasonNumber))].sort(
    (a, b) => a - b
  );
  const sizeOf = (season: number) =>
    all.filter((e) => e.seasonNumber === season).length;
  const countIn = (season: number) =>
    refs.filter((r) => r.seasonNumber === season).length;
  if (seasons.length === 1 && countIn(seasons[0]) < sizeOf(seasons[0])) {
    return {
      kind: 'episodes',
      season: seasons[0],
      episodes: ranges(refs.map((r) => r.episodeNumber)),
    };
  }
  return { kind: 'seasons', seasons };
};

/** Whether no wanted subtitle is missing. */
export const isCovered = (episode: EpisodeSubtitles): boolean =>
  episode.tracks.length > 0 && episode.missing.length === 0;

export const isTranscribed = (episode: EpisodeSubtitles): boolean =>
  episode.tracks.some((track) => track.ai);

/** Display names for Bazarr providers. */
const PROVIDERS: Record<string, string> = {
  opensubtitlescom: 'OpenSubtitles.com',
  opensubtitles: 'OpenSubtitles.org',
  yifysubtitles: 'YIFY Subtitles',
  whisperai: 'Whisper',
  podnapisi: 'Podnapisi',
  subdl: 'Subdl',
  addic7ed: 'Addic7ed',
  gestdown: 'Gestdown',
  embeddedsubtitles: 'Embedded Subtitles',
  supersubtitles: 'SuperSubtitles',
  subf2m: 'Subf2m',
  tvsubtitles: 'TVsubtitles',
  napiprojekt: 'NapiProjekt',
  animetosho: 'AnimeTosho',
  jimaku: 'Jimaku',
  subsource: 'SubSource',
  bsplayer: 'BSPlayer',
};

export const providerName = (provider: string): string =>
  PROVIDERS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
