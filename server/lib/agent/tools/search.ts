import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI, {
  AUDIO_CATEGORIES,
  MOVIE_CATEGORIES,
  TV_CATEGORIES,
} from '@server/api/prowlarr';
import type { AgentRun } from '@server/entity/AgentRun';
import {
  episodeByTitle,
  indexerReading,
  nameReading,
  sceneDiffers,
} from '@server/lib/agent/numbering';
import {
  MIN_VIDEO_BYTES,
  episodeLabel,
  seasonLabel,
  sizeOf,
} from '@server/lib/agent/rules';
import type {
  AgentState,
  AgentTool,
  KnownRelease,
  TitleRef,
} from '@server/lib/agent/tools/base';
import {
  ToolError,
  boundTitle,
  normalize,
  readTitleRef,
  titleRef,
} from '@server/lib/agent/tools/base';
import { backfillOf, failedReleases } from '@server/lib/agent/tools/titles';
import backfill from '@server/lib/backfill/engine';
import {
  IndexerLimitReached,
  PROWLARR,
  indexerLimits,
  limitHint,
} from '@server/lib/backfill/indexerLimit';
import type { PackFile } from '@server/lib/backfill/matcher';
import { mentionsShow } from '@server/lib/backfill/matcher';
import { baseName, isVideo } from '@server/lib/backfill/naming';
import type {
  ArrSearchRelease,
  SonarrEpisode,
} from '@server/lib/backfill/sonarr';
import { blockedGroupOf } from '@server/lib/blockedGroups';
import { isAudio } from '@server/lib/music/albumRelease';
import { getSettings } from '@server/lib/settings';
import { z } from 'zod';

/*
 * Searching the way Sonarr, Radarr and Lidarr do and the way Prowlarr
 * does, opening a release to see its files and what language it is in,
 * and telling what the searches never named.
 */

const MAX_LISTED_RELEASES = 30;

const remember = (
  state: AgentState,
  release: ProwlarrRelease,
  source: KnownRelease['source']
): KnownRelease => {
  const same = [...state.releases.values()].find(
    (known) => known.guid === release.guid
  );
  if (same) return same;
  const known: KnownRelease = {
    ...release,
    ref: `r${state.releases.size + 1}`,
    source,
  };
  state.releases.set(known.ref, known);
  return known;
};

const reasonsOf = (release: ArrSearchRelease) =>
  (release.rejections ?? [])
    .map((r) => (typeof r === 'string' ? r : (r.reason ?? '')))
    .filter(Boolean);

const asRelease = (release: ArrSearchRelease): ProwlarrRelease | null => {
  const protocol =
    release.protocol === 'torrent' || release.protocol === 'usenet'
      ? release.protocol
      : null;
  if (!protocol) return null;
  return {
    guid: release.guid,
    title: release.title,
    size: release.size ?? 0,
    indexerId: release.indexerId,
    indexer: (release.indexer ?? '').replace(/ \(Prowlarr\)$/, ''),
    protocol,
    seeders: release.seeders,
    downloadUrl: release.downloadUrl,
    magnetUrl: release.magnetUrl,
    infoHash: release.infoHash,
    publishDate: release.publishDate,
  };
};

const releaseLine = (
  known: KnownRelease,
  extra: {
    what?: string;
    quality?: string;
    approved?: boolean;
    why?: string[];
    /** It failed to download for this title before. */
    failed?: boolean;
    /** Which library episode it is, by its name. */
    reading?: string;
  }
) => {
  const blocked = blockedGroupOf(known.title);
  return [
    known.ref,
    extra.what,
    extra.reading,
    sizeOf(known.size),
    known.protocol === 'torrent' ? `${known.seeders ?? 0} seeders` : 'usenet',
    extra.quality,
    known.indexer,
    `"${known.title}"`,
    blocked
      ? `blocked group ${blocked}: never take it`
      : extra.failed
        ? 'failed to download for this title: never take it again'
        : extra.approved
          ? 'accepted'
          : extra.why?.length
            ? `turned down: ${extra.why.slice(0, 3).join('; ').slice(0, 300)}`
            : '',
  ]
    .filter(Boolean)
    .join(' | ');
};

/** How long search_releases waits on Sonarr or Radarr, and keeps results. */
export const searchTiming = {
  waitMs: 90_000,
  keepMs: 20 * 60_000,
};

interface ArrSearch {
  startedAt: number;
  doneAt?: number;
  results?: ArrSearchRelease[];
  error?: unknown;
  settled: Promise<void>;
}

/**
 * Sonarr's and Radarr's own searches, by what was searched. A search is
 * left to finish when the tool stops waiting on it (Sonarr goes on with it
 * anyway, and an anime season can take minutes, episode by episode), so
 * asking again picks up its results rather than starting another.
 */
const arrSearches = new Map<string, ArrSearch>();

export const forgetSearches = () => arrSearches.clear();

const arrSearch = async (
  key: string,
  start: () => Promise<ArrSearchRelease[]>
): Promise<
  | { results: ArrSearchRelease[]; ageMs: number }
  | { pending: true; forMs: number }
> => {
  const now = Date.now();
  for (const [k, search] of arrSearches) {
    if (search.doneAt && now - search.doneAt > searchTiming.keepMs) {
      arrSearches.delete(k);
    }
  }
  let search = arrSearches.get(key);
  if (!search) {
    const fresh: ArrSearch = {
      startedAt: now,
      settled: Promise.resolve(),
    };
    fresh.settled = start().then(
      (results) => {
        fresh.results = results;
        fresh.doneAt = Date.now();
      },
      (error) => {
        fresh.error = error;
        fresh.doneAt = Date.now();
      }
    );
    arrSearches.set(key, fresh);
    search = fresh;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    search.settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, searchTiming.waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (!search.doneAt) {
    return { pending: true, forMs: Date.now() - search.startedAt };
  }
  if (search.error !== undefined) {
    // A failed search is tried afresh next time.
    arrSearches.delete(key);
    throw search.error;
  }
  return { results: search.results ?? [], ageMs: Date.now() - search.doneAt };
};

/**
 * A series' episodes and the names releases call it by, to say which
 * library episode a release is. Empty when the series cannot be read.
 */
const libraryOf = async (
  title: TitleRef
): Promise<{ episodes: SonarrEpisode[]; names: string[] }> => {
  try {
    const sonarr = backfill.sonarrFor(title.serverId);
    const [series, episodes] = await Promise.all([
      sonarr.getSeriesDetail(title.arrId),
      sonarr.getSeriesEpisodes(title.arrId),
    ]);
    const names = [
      series.title,
      series.title.replace(/\s*\(\d{4}\)$/, ''),
      ...(series.originalTitle ? [series.originalTitle] : []),
      ...(series.alternateTitles ?? []).map((alt) => alt.title),
    ].filter(Boolean);
    return { episodes, names };
  } catch {
    return { episodes: [], names: [] };
  }
};

/** What a release is by its name, when it is one of this series' at all. */
const readingOf = (
  name: string,
  library: { episodes: SonarrEpisode[]; names: string[] }
): string | undefined =>
  library.episodes.length && mentionsShow(name, library.names)
    ? indexerReading(name, library.episodes) || undefined
    : undefined;

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export const searchReleases: AgentTool = {
  name: 'search_releases',
  readOnly: true,
  description:
    "Runs Sonarr's, Radarr's or Lidarr's own search across their indexers, like an interactive search: every result with what it maps to, its quality and size, and the reasons it was turned down. For a series, give a season (or a season and episode). Slow: a season of an anime can take several minutes, since Sonarr searches it episode by episode. If it is not done within a minute and a half you are told so; it keeps going, and calling it again with the same title and season gives its results. Search Prowlarr with search_indexers meanwhile.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A title reference.' },
      season: { type: 'integer', description: 'Series only.' },
      episode: {
        type: 'integer',
        description: 'Series only, with season: one episode.',
      },
    },
    required: ['title'],
  },
  async run(state, input) {
    const title = readTitleRef(input.title);
    const { season, episode } = z
      .object({
        season: z.coerce.number().int().min(0).optional(),
        episode: z.coerce.number().int().min(0).optional(),
      })
      .parse(input);
    let key: string;
    let start: () => Promise<ArrSearchRelease[]>;
    let what: string;
    /** Said when an episode searched by its scene number finds nothing. */
    let sceneHint = '';
    if (title.kind === 'album') {
      const lidarr = backfill.lidarrFor(title.serverId);
      key = titleRef(title);
      start = () => lidarr.getReleases(title.arrId);
      what = 'Lidarr is still searching';
    } else if (title.kind === 'movie') {
      const radarr = backfill.radarrFor(title.serverId);
      key = titleRef(title);
      start = () => radarr.getReleases(title.arrId);
      what = 'Radarr is still searching';
    } else {
      if (season === undefined) {
        throw new ToolError('Give a season to search.');
      }
      const sonarr = backfill.sonarrFor(title.serverId);
      if (episode !== undefined) {
        const target = (await sonarr.getSeriesEpisodes(title.arrId)).find(
          (ep) => ep.seasonNumber === season && ep.episodeNumber === episode
        );
        if (!target) {
          throw new ToolError(
            `${episodeLabel(season, episode)} is not an episode of this series.`
          );
        }
        key = `${titleRef(title)}:${season}:${episode}`;
        start = () => sonarr.getReleases({ episodeId: target.id });
        if (sceneDiffers(target)) {
          sceneHint = ` Sonarr searched for it by its scene number, ${episodeLabel(
            target.sceneSeasonNumber!,
            target.sceneEpisodeNumber!
          )}: use search_indexers with ${episodeLabel(season, episode)} and with its title, "${target.title ?? ''}".`;
        }
        what = `Sonarr is still searching for ${episodeLabel(season, episode)}`;
      } else {
        key = `${titleRef(title)}:${season}`;
        start = () =>
          sonarr.getReleases({ seriesId: title.arrId, seasonNumber: season });
        what = `Sonarr is still searching season ${season}`;
      }
    }
    const found = await arrSearch(key, start);
    if ('pending' in found) {
      return `${what} (${minutes(found.forMs)} min so far). It keeps going: call search_releases again with the same title${
        title.kind === 'series' ? ' and season' : ''
      } for its results, and use search_indexers meanwhile.`;
    }
    // A season's search brings back other seasons too (a long-running show
    // fills the list with its newest): only this season's, packs that cover
    // it, and releases Sonarr could not place, which may be collections.
    const placedElsewhere = (r: ArrSearchRelease) => {
      if (
        title.kind !== 'series' ||
        episode !== undefined ||
        season === undefined
      ) {
        return false;
      }
      // Sonarr v5 lists every season a pack covers; the season it maps a
      // pack to is only the first of them.
      if (r.seasonNumbers && r.seasonNumbers.length > 1) {
        return !r.seasonNumbers.includes(season);
      }
      if (r.mappedSeasonNumber !== undefined && r.mappedSeasonNumber !== null) {
        return r.mappedSeasonNumber !== season;
      }
      return r.seasonNumber !== undefined && r.seasonNumber !== season;
    };
    const results = found.results.filter((r) => !placedElsewhere(r));
    const elsewhere = found.results.length - results.length;
    const others = elsewhere
      ? ` (${elsewhere} more for other seasons left out)`
      : '';
    const earlier =
      found.ageMs > 60_000
        ? ` (from a search ${minutes(found.ageMs)} min ago)`
        : '';
    if (!results.length) {
      return `No results from any indexer${earlier}${others}.${sceneHint}`;
    }
    const failed = await failedReleases(title);
    // The library's episodes, to say which each release is by its title as
    // well as by Sonarr's mapping.
    const library =
      title.kind === 'series'
        ? await libraryOf(title)
        : { episodes: [] as SonarrEpisode[], names: [] as string[] };
    // Accepted first, then what is for a missing episode (by Sonarr's
    // mapping or the name's title), then anything Sonarr placed, then what
    // it could not: otherwise a search Sonarr accepted nothing from shows
    // its first 30 rows of other shows.
    const missingIds = new Set(
      library.episodes.filter((ep) => !ep.hasFile).map((ep) => ep.id)
    );
    const rankOf = (r: ArrSearchRelease) => {
      if (r.approved) return 3;
      const mappedIds = library.episodes
        .filter(
          (ep) =>
            ep.seasonNumber === (r.mappedSeasonNumber ?? season) &&
            (r.mappedEpisodeNumbers ?? []).includes(ep.episodeNumber)
        )
        .map((ep) => ep.id);
      const titled =
        library.episodes.length && mentionsShow(r.title, library.names)
          ? episodeByTitle(r.title, library.episodes)
          : undefined;
      if (
        mappedIds.some((id) => missingIds.has(id)) ||
        (titled && missingIds.has(titled.id)) ||
        (r.fullSeason && title.kind === 'series')
      ) {
        return 2;
      }
      return r.mappedEpisodeNumbers?.length || r.fullSeason ? 1 : 0;
    };
    const sorted = [...results]
      .map((r) => ({ r, rank: rankOf(r) }))
      .sort(
        (a, b) => b.rank - a.rank || (b.r.seeders ?? 0) - (a.r.seeders ?? 0)
      )
      .map(({ r }) => r);
    const lines: string[] = [];
    for (const result of sorted.slice(0, MAX_LISTED_RELEASES)) {
      const release = asRelease(result);
      if (!release) continue;
      const known = remember(
        state,
        release,
        title.kind === 'movie'
          ? 'radarr'
          : title.kind === 'album'
            ? 'lidarr'
            : 'sonarr'
      );
      const what =
        title.kind !== 'series'
          ? undefined
          : result.seasonNumbers && result.seasonNumbers.length > 1
            ? `${seasonLabel(Math.min(...result.seasonNumbers))}–${seasonLabel(Math.max(...result.seasonNumbers))} pack`
            : result.fullSeason
              ? `${seasonLabel(result.seasonNumber ?? result.mappedSeasonNumber ?? season ?? 0)} pack`
              : result.mappedEpisodeNumbers?.length
                ? result.mappedEpisodeNumbers
                    .map((n) =>
                      episodeLabel(result.mappedSeasonNumber ?? season ?? 0, n)
                    )
                    .join(',')
                : 'unmapped';
      const mapped =
        title.kind === 'series' &&
        result.mappedEpisodeNumbers?.length === 1 &&
        !(result.seasonNumbers && result.seasonNumbers.length > 1) &&
        !result.fullSeason
          ? library.episodes.find(
              (ep) =>
                ep.seasonNumber ===
                  (result.mappedSeasonNumber ?? season ?? 0) &&
                ep.episodeNumber === result.mappedEpisodeNumbers![0]
            )
          : undefined;
      lines.push(
        releaseLine(known, {
          what,
          reading: mapped
            ? nameReading(result.title, library.episodes, mapped)
            : readingOf(result.title, library),
          quality: result.quality?.quality.name,
          approved: result.approved,
          why: reasonsOf(result),
          failed: failed(release),
        })
      );
    }
    return `${results.length} results${earlier}${others}${
      results.length > MAX_LISTED_RELEASES
        ? `, the first ${MAX_LISTED_RELEASES} shown`
        : ''
    }:\n${lines.join('\n')}`;
  },
};

/**
 * An indexer (or Prowlarr) at its limit, told to the model in words with
 * when it can be asked again, so it tries another release or stops rather
 * than asking again at once.
 */
const atLimit = async <T>(ask: () => Promise<T>): Promise<T> => {
  try {
    return await ask();
  } catch (e) {
    if (e instanceof IndexerLimitReached) {
      throw new ToolError(
        `${limitHint(e)}. Use a release from another indexer, or leave it for now.`
      );
    }
    throw e;
  }
};

export const searchIndexers: AgentTool = {
  name: 'search_indexers',
  readOnly: true,
  description:
    'Searches every Prowlarr indexer for any text, without Sonarr, Radarr or Lidarr filtering anything out. Use other names, years, "complete", "collection", a season, or the original title; for music (kind music), "Artist Album" or the album\'s name, with the year or FLAC.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      kind: { type: 'string', enum: ['series', 'movie', 'music'] },
    },
    required: ['query', 'kind'],
  },
  async run(state, input) {
    const { query, kind } = z
      .object({
        query: z.string().trim().min(2).max(200),
        kind: z.enum(['series', 'movie', 'music']),
      })
      .parse(input);
    const prowlarr = new ProwlarrAPI(getSettings().backfill.prowlarr);
    const categories =
      kind === 'music'
        ? AUDIO_CATEGORIES
        : kind === 'movie'
          ? MOVIE_CATEGORIES
          : TV_CATEGORIES;
    const results = await atLimit(() =>
      indexerLimits.guard(PROWLARR, 'search', () =>
        prowlarr.search(query, { categories })
      )
    );
    if (!results.length) return `Nothing for "${query}".`;
    // Usenet has no seeders; it is as good as a well-seeded torrent.
    const rank = (r: ProwlarrRelease) =>
      r.protocol === 'usenet' ? 50 : (r.seeders ?? 0);
    // Releases that failed for the title it is working on are marked.
    const bound = boundTitle(state.run);
    const failed = await failedReleases(bound);
    // Which episode of the series it works on each one is, by its name.
    const library =
      kind === 'series' && bound?.kind === 'series'
        ? await libraryOf(bound)
        : { episodes: [] as SonarrEpisode[], names: [] as string[] };
    const lines = [...results]
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, MAX_LISTED_RELEASES)
      .map((release) =>
        releaseLine(remember(state, release, 'prowlarr'), {
          failed: failed(release),
          reading: readingOf(release.title, library),
        })
      );
    return `${results.length} results${
      results.length > MAX_LISTED_RELEASES
        ? `, the best ${MAX_LISTED_RELEASES} shown`
        : ''
    }:\n${lines.join('\n')}`;
  },
};

// ---- opening a release -------------------------------------------------------

const MAX_LISTED_FILES = 250;

export const releaseOf = (state: AgentState, value: unknown): KnownRelease => {
  const known = state.releases.get(String(value ?? ''));
  if (!known) {
    throw new ToolError(
      'That is not a release reference from this run. Search first, then use its reference (like r3).'
    );
  }
  return known;
};

export const filesOf = async (state: AgentState, known: KnownRelease) => {
  let files = state.files.get(known.ref);
  if (!files) {
    // Opening a release fetches it from its indexer, which counts toward
    // the indexer's download limit like any grab.
    const opened = await atLimit(() => backfill.filesOf(known));
    files = opened.files;
    if (opened.infoHash) known.infoHash = opened.infoHash;
    if (opened.packed) known.packed = opened.packed;
    state.files.set(known.ref, files);
  }
  return files;
};

export const releaseFiles: AgentTool = {
  name: 'release_files',
  readOnly: true,
  description:
    "Opens a release and lists its files with their index, path and size, without downloading it. A magnet can take up to a minute. A Usenet post packed in archives or with scrambled file names can't be listed; one named as a single episode or the movie can be grabbed whole.",
  parameters: {
    type: 'object',
    properties: { release: { type: 'string', description: 'Like r3.' } },
    required: ['release'],
  },
  async run(state, input) {
    const known = releaseOf(state, input.release);
    const files = await filesOf(state, known);
    if (known.packed) {
      const what =
        known.packed === 'archives'
          ? 'packed in archives: its files are only known once it is downloaded and unpacked'
          : 'with scrambled file names (only its PAR2 repair files are named, which is common and fine): the Usenet client restores the real names once it is downloaded';
      return `${known.ref} "${known.title}" (${sizeOf(known.size)}) is a Usenet post ${what}. If its name is exactly one missing episode (or the movie), grab it whole: grab with whole: true and one file entry with index 0 and the season and episode its name gives. A season pack like this cannot be used.`;
    }
    const sorted = [...files].sort((a, b) => a.index - b.index);
    // For an album, what is not music is marked; for a series or a movie,
    // what is not video; before a title is chosen, what is neither.
    const kind = boundTitle(state.run)?.kind;
    const video = (f: PackFile) => isVideo(f.path) && f.size >= MIN_VIDEO_BYTES;
    const lines = sorted.slice(0, MAX_LISTED_FILES).map((f) => {
      const note =
        kind === 'album'
          ? isAudio(f.path)
            ? ''
            : ', not audio'
          : kind
            ? video(f)
              ? ''
              : ', not a video'
            : video(f) || isAudio(f.path)
              ? ''
              : ', not a video or audio';
      return `#${f.index}  ${f.path}  (${sizeOf(f.size)}${note})`;
    });
    return `${known.ref} "${known.title}": ${files.length} files\n${lines.join('\n')}${
      files.length > MAX_LISTED_FILES
        ? `\n… and ${files.length - MAX_LISTED_FILES} more`
        : ''
    }`;
  },
};

/** Words in names that say what language a release or file is in. */
const LANGUAGE_TAGS =
  /\b(multi|dual[ .-]?audio|dubbed|dub|subbed|vostfr|truefrench|french|vf[fiq]?|german|deutsch|ita|italian|spanish|castellano|latino|portuguese|pt-?br|russian|rus|polish|pl|hindi|tamil|telugu|japanese|jpn|korean|chinese|nordic|swedish|danish|norwegian|dutch|nl|turkish|arabic|eng(lish)?)\b/gi;

export const checkLanguage: AgentTool = {
  name: 'check_language',
  readOnly: true,
  description:
    "Gathers what can be told about a release's language before downloading: what Sonarr or Radarr reads from its name and from each file's name, language words in the names (MULTi, DUAL AUDIO, iTA, TRUEFRENCH…), and any subtitle files in it. The audio itself can only be read once a file is downloaded; title_status shows the audio language of files on disk.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A title reference.' },
      release: { type: 'string', description: 'Like r3.' },
    },
    required: ['title', 'release'],
  },
  async run(state, input) {
    const title = readTitleRef(input.title);
    if (title.kind === 'album') {
      throw new ToolError(
        "Music has no audio language to check: an album is the artist's own recording."
      );
    }
    const known = releaseOf(state, input.release);
    const parse = (name: string) =>
      (title.kind === 'movie'
        ? backfill.radarrFor(title.serverId).parse(name)
        : backfill.sonarrFor(title.serverId).parse(name)
      ).catch(() => null);
    const named = (await parse(known.title))?.languages ?? [];
    const files = await filesOf(state, known).catch(() => null);
    const tags = new Map<string, number>();
    const subtitles: string[] = [];
    for (const name of [known.title, ...(files ?? []).map((f) => f.path)]) {
      for (const tag of name.match(LANGUAGE_TAGS) ?? []) {
        const key = tag.toLowerCase();
        tags.set(key, (tags.get(key) ?? 0) + 1);
      }
    }
    for (const file of files ?? []) {
      if (/\.(srt|ass|ssa|sub|idx|vtt)$/i.test(file.path)) {
        subtitles.push(baseName(file.path));
      }
    }
    const videos = (files ?? []).filter(
      (f) => isVideo(f.path) && f.size >= MIN_VIDEO_BYTES
    );
    const sample = await Promise.all(
      videos.slice(0, 5).map(async (f) => {
        const langs = (await parse(baseName(f.path)))?.languages ?? [];
        return `${baseName(f.path)}: ${
          langs.map((l) => l.name).join(', ') || 'nothing said'
        }`;
      })
    );
    return [
      `Release name reads as: ${named.map((l) => l.name).join(', ') || 'nothing said'}.`,
      tags.size
        ? `Language words in the names: ${[...tags]
            .map(([tag, n]) => `${tag} ×${n}`)
            .join(', ')}.`
        : 'No language words in the release or file names.',
      files
        ? `Subtitle files: ${subtitles.length ? subtitles.slice(0, 10).join(', ') : 'none'}.`
        : 'Its files could not be listed.',
      sample.length ? `File names read as:\n${sample.join('\n')}` : '',
      'Nothing here hears the audio: a name that says nothing is most often in the original language, but only a downloaded file proves it.',
    ]
      .filter(Boolean)
      .join('\n');
  },
};

// ---- what its searches never named ---------------------------------------------

/** A tool call as the run made it, to tell what it has looked for. */
export interface MadeCall {
  name: string;
  input: Record<string, unknown>;
}

/** What one search's words name: episodes, whole seasons, numbers, text. */
interface SearchWords {
  episodes: Set<string>;
  seasons: Set<number>;
  /** Numbers standing alone ("Show 152", "[152]"), for anime. */
  numbers: Set<number>;
  text: string;
}

const readSearch = (query: string): SearchWords => {
  const episodes = new Set<string>();
  const seasons = new Set<number>();
  const numbers = new Set<number>();
  for (const m of query.matchAll(
    /(?:^|[^a-z0-9])s(\d{1,3})(?:[ ._-]?e(\d{1,4}))?(?=[^0-9]|$)|(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?=[^0-9]|$)|\bseason (\d{1,3})\b/gi
  )) {
    if (m[1] !== undefined && m[2] !== undefined) {
      episodes.add(`${Number(m[1])}:${Number(m[2])}`);
    } else if (m[1] !== undefined) {
      seasons.add(Number(m[1]));
    } else if (m[3] !== undefined) {
      episodes.add(`${Number(m[3])}:${Number(m[4])}`);
    } else if (m[5] !== undefined) {
      seasons.add(Number(m[5]));
    }
  }
  // Standing alone: the 04 of S03E04 is not episode 4 overall.
  for (const m of query.matchAll(/(?:^|[\s#[(-])(\d{1,4})(?=[\s\])-]|$)/g)) {
    numbers.add(Number(m[1]));
  }
  return { episodes, seasons, numbers, text: normalize(query) };
};

/** Whether a search's words name this episode: its number, or its title. */
const searchNames = (
  words: SearchWords,
  ep: SonarrEpisode,
  anime: boolean
): boolean => {
  const title = normalize(ep.title ?? '');
  return (
    words.episodes.has(`${ep.seasonNumber}:${ep.episodeNumber}`) ||
    (ep.sceneSeasonNumber != null &&
      ep.sceneEpisodeNumber != null &&
      words.episodes.has(`${ep.sceneSeasonNumber}:${ep.sceneEpisodeNumber}`)) ||
    words.seasons.has(ep.seasonNumber) ||
    (anime &&
      ep.absoluteEpisodeNumber != null &&
      words.numbers.has(ep.absoluteEpisodeNumber)) ||
    (title.length >= 4 && ` ${words.text} `.includes(` ${title} `))
  );
};

/**
 * The missing episodes of the title a run works on that it has not looked
 * for at all: no search named them (by number or title, one by one or by
 * their season), nothing was started for them, and nothing is downloading
 * them. Empty for a movie, or when it cannot be told.
 */
export const notLookedFor = async (
  run: AgentRun,
  calls: MadeCall[]
): Promise<SonarrEpisode[]> => {
  const title = boundTitle(run);
  if (!title || title.kind !== 'series') return [];
  const sonarr = backfill.sonarrFor(title.serverId);
  const [series, episodes, queued, { jobs }] = await Promise.all([
    sonarr.getSeriesDetail(title.arrId),
    sonarr.getSeriesEpisodes(title.arrId),
    sonarr.getSeriesQueueEpisodes(title.arrId).catch(() => [] as number[]),
    backfillOf(title),
  ]);
  const busy = new Set<number>([
    ...queued,
    ...jobs.flatMap((job) => job.files.flatMap((f) => f.episodeIds)),
    ...run.actions.flatMap((a) => a.episodeIds ?? []),
  ]);
  // Each search read once, however many episodes there are.
  const anime = series.seriesType === 'anime';
  const seasonsSearched = new Set<number>();
  const episodesSearched = new Set<string>();
  const words: SearchWords[] = [];
  for (const call of calls) {
    if (call.name === 'search_releases') {
      const season = Number(call.input.season);
      if (call.input.episode === undefined) seasonsSearched.add(season);
      else episodesSearched.add(`${season}:${Number(call.input.episode)}`);
    } else if (call.name === 'search_indexers') {
      words.push(readSearch(String(call.input.query ?? '')));
    }
  }
  const looked = (ep: SonarrEpisode) =>
    seasonsSearched.has(ep.seasonNumber) ||
    episodesSearched.has(`${ep.seasonNumber}:${ep.episodeNumber}`) ||
    words.some((w) => searchNames(w, ep, anime));
  const now = Date.now();
  return episodes
    .filter(
      (ep) =>
        !ep.hasFile &&
        ep.monitored &&
        (!ep.airDateUtc || new Date(ep.airDateUtc).getTime() <= now) &&
        !busy.has(ep.id)
    )
    .filter((ep) => !looked(ep))
    .sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
    );
};
