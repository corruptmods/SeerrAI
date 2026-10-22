import type { FileNumbers } from '@server/lib/backfill/naming';
import { readNumbers } from '@server/lib/backfill/naming';
import type { SonarrQuality } from '@server/lib/backfill/sonarr';

/*
 * The limits the admin agent works within, kept apart from the model: it
 * can ask for anything, and these decide what actually happens. Each says
 * why in words the model can act on, so it can try something else.
 */

/** Below this a video is a sample or an extra, not an episode or a film. */
export const MIN_VIDEO_BYTES = 20 * 1024 * 1024;

/** A sample's name: "x-sample.mkv", "sample-x.mkv", "x.sample.mkv". */
const SAMPLE = /(^|[\s._\-[(])sample([\s._\-\])]|$)/i;

/** What a file's quality is when Sonarr or Radarr cannot read one. */
export const UNKNOWN_QUALITY: SonarrQuality = {
  quality: { id: 0, name: 'Unknown' },
  revision: { version: 1, real: 0 },
};

/**
 * Whether a release or file is in a language worth having: English, or the
 * title's own language. A name that says nothing about language passes.
 * Returns why not, or null.
 */
export const languageProblem = (
  languages: { name?: string }[] | undefined,
  original?: string
): string | null => {
  const named = [
    ...new Set(
      (languages ?? [])
        .map((language) => language.name ?? '')
        .filter((name) => name && name !== 'Unknown' && name !== 'Original')
    ),
  ];
  if (!named.length) return null;
  const wanted = [...new Set(['English', original].filter(Boolean))];
  return named.some((name) => wanted.includes(name))
    ? null
    : `It is in ${named.join(', ')}, not ${wanted.join(' or ')}.`;
};

export interface MappedFile {
  index: number;
  season?: number;
  episode?: number;
  /** Every episode a file holds, when it holds several (S01E01-E02). */
  episodes?: number[];
}

export interface FileInPack {
  index: number;
  path: string;
  size: number;
}

export interface EpisodeOnDisk {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  hasFile: boolean;
  monitored: boolean;
  airDateUtc?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const episodeLabel = (season: number, episode: number) =>
  `S${pad(season)}E${pad(episode)}`;

/** "S06". */
export const seasonLabel = (season: number) => `S${pad(season)}`;

/** "S06E01", or "S06E01-E02" for a file holding several episodes. */
export const rangeLabel = (season: number, episodes: number[]) =>
  episodes.length > 1
    ? `${episodeLabel(season, episodes[0])}-E${pad(episodes[episodes.length - 1])}`
    : episodeLabel(season, episodes[0] ?? 0);

/** The episodes a mapped file is given, in order. */
export const mappedEpisodes = (entry: MappedFile): number[] =>
  [
    ...new Set(
      entry.episodes?.length
        ? entry.episodes
        : entry.episode !== undefined
          ? [entry.episode]
          : []
    ),
  ].sort((a, b) => a - b);

/**
 * Checks a mapping of a release's files to episodes: each file is in the
 * release and is a video, each episode is one the series has, monitored,
 * aired, with no file yet and not already downloading, and nothing is used
 * twice. A file holding several episodes is given all of them, in a row.
 * Returns the episodes each file fills (the first as `episode`), or every
 * reason it cannot.
 */
export const checkMapping = (
  mapped: MappedFile[],
  files: FileInPack[],
  episodes: EpisodeOnDisk[],
  options: {
    queued: Set<number>;
    /** Episodes a Backfill download under way is fetching, by its job. */
    backfilling?: Map<number, number>;
    /** Episodes this release was downloaded for before but not imported. */
    importFailed?: Map<number, number>;
    isVideo: (path: string) => boolean;
    now?: number;
    /**
     * Episodes with a file may be mapped too, their files to be replaced
     * once the new ones import: only with an admin's approval.
     */
    replace?: boolean;
    /** An admin is in the conversation, so replacing can be proposed. */
    canReplace?: boolean;
  }
): {
  ok: { file: FileInPack; episode: EpisodeOnDisk; episodes: EpisodeOnDisk[] }[];
  problems: string[];
} => {
  const now = options.now ?? Date.now();
  const problems: string[] = [];
  const ok: {
    file: FileInPack;
    episode: EpisodeOnDisk;
    episodes: EpisodeOnDisk[];
  }[] = [];
  const usedFiles = new Set<number>();
  const usedEpisodes = new Set<number>();
  if (!mapped.length) {
    problems.push('No files were given.');
  }
  for (const entry of mapped) {
    const file = files.find((f) => f.index === entry.index);
    if (!file) {
      problems.push(`There is no file #${entry.index} in this release.`);
      continue;
    }
    const numbers = mappedEpisodes(entry);
    if (entry.season === undefined || !numbers.length) {
      problems.push(`File #${entry.index} needs a season and an episode.`);
      continue;
    }
    const season = entry.season;
    if (!options.isVideo(file.path) || file.size < MIN_VIDEO_BYTES) {
      problems.push(`File #${entry.index} is not a video of any length.`);
      continue;
    }
    // A sample can be long enough to pass for an episode (DHD's are 40 MB).
    // Only the file's own name is read: a show called Caravan Lot Lads,
    // or an episode called The Menu, is not an extra.
    if (SAMPLE.test(file.path.split(/[\\/]/).pop() ?? '')) {
      problems.push(
        `File #${entry.index} is a sample, not the episode. If it is the only video, the episode is packed in archives: take the release whole, or another one.`
      );
      continue;
    }
    if (
      numbers.length > 1 &&
      numbers.some((n, i) => i && n !== numbers[i - 1] + 1)
    ) {
      problems.push(
        `File #${entry.index}: a file holds episodes in a row, not ${numbers.join(', ')}.`
      );
      continue;
    }
    const found: EpisodeOnDisk[] = [];
    const before = problems.length;
    for (const number of numbers) {
      const one = episodeLabel(season, number);
      const episode = episodes.find(
        (ep) => ep.seasonNumber === season && ep.episodeNumber === number
      );
      if (!episode) {
        problems.push(`${one} is not an episode of this series.`);
        continue;
      }
      if (episode.hasFile && !options.replace) {
        problems.push(
          options.canReplace
            ? `${one} already has a file. To replace it, call grab again with replace: true; the admin is asked to approve first.`
            : `${one} already has a file; existing files are never replaced.`
        );
        continue;
      }
      // A file being replaced is wanted whatever the monitoring says.
      if (!episode.monitored && !(options.replace && episode.hasFile)) {
        problems.push(`${one} is not monitored, so it is not wanted.`);
        continue;
      }
      if (episode.airDateUtc && new Date(episode.airDateUtc).getTime() > now) {
        problems.push(`${one} has not aired yet.`);
        continue;
      }
      if (options.queued.has(episode.id)) {
        problems.push(`${one} is already downloading in Sonarr.`);
        continue;
      }
      const job = options.backfilling?.get(episode.id);
      if (job !== undefined) {
        problems.push(`${one} is already downloading in Backfill job #${job}.`);
        continue;
      }
      const failedIn = options.importFailed?.get(episode.id);
      if (failedIn !== undefined) {
        problems.push(
          `${one} did not import from this release in Backfill job #${failedIn}; take it from another release.`
        );
        continue;
      }
      found.push(episode);
    }
    if (problems.length > before) continue;
    if (usedFiles.has(file.index)) {
      problems.push(`File #${file.index} is given twice.`);
      continue;
    }
    const twice = found.filter((e) => usedEpisodes.has(e.id));
    if (twice.length) {
      problems.push(
        ...twice.map(
          (e) => `${episodeLabel(season, e.episodeNumber)} is given two files.`
        )
      );
      continue;
    }
    usedFiles.add(file.index);
    for (const episode of found) usedEpisodes.add(episode.id);
    ok.push({ file, episode: found[0], episodes: found });
  }
  return { ok, problems };
};

const REPLACE_WORDS =
  /\b(replac\w*|re-?download\w*|download\w* (it |them |that |those )?again|re-?grab\w*|fix\w*|swap\w*)\b/i;
const DELETE_WORDS = /\b(delet\w*|remov\w*|get rid of|trash|wipe)\b/i;

/**
 * Whether files may be deleted outright: only when deleting is what the
 * admin asked for. Asked to replace or fix something, without a word about
 * deleting, the old files go only through a replacement (replace_season,
 * or grab with replace), never by deleting them first and leaving nothing
 * to play until something is found. Returns why not, or null.
 */
export const deleteProblem = (said: string[]): string | null =>
  said.some((text) => DELETE_WORDS.test(text)) ||
  !said.some((text) => REPLACE_WORDS.test(text))
    ? null
    : 'The admin asked for a replacement, not for files to be deleted. Use replace_season for a whole season, or grab with replace: true for some episodes: the new release is downloaded first, and the old files go only after. Propose deleteFiles only when deleting is what was asked.';

/** Megabytes or gigabytes, as people read sizes. */
export const sizeOf = (bytes: number | undefined): string => {
  if (!bytes) return '?';
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
};

/** A tool's answer, cut to what the model can usefully read. */
export const MAX_RESULT_CHARS = 8000;

export const clip = (text: string, max = MAX_RESULT_CHARS): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (cut at ${max} characters)`;

// ---- doubt -------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'to',
  'in',
  'on',
  'at',
  'for',
  'is',
  'part',
]);

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]s\b/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Edits between two words, a swap of neighbours counting as one. */
const distance = (a: string, b: string): number => {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
};

/** The same word, allowing a typo in a longer one ("Wendel"). */
const sameWord = (a: string, b: string) =>
  a === b || (Math.min(a.length, b.length) >= 5 && distance(a, b) <= 1);

/**
 * Whether a file's name carries the episode's title: most of the title's
 * words (leaving out "the", "of" and the like) are in the name.
 */
export const namesEpisode = (fileName: string, episodeTitle?: string) => {
  const title = wordsOf(episodeTitle ?? '').filter((w) => !STOP_WORDS.has(w));
  if (!title.length) return false;
  const name = wordsOf(fileName);
  const found = title.filter((w) => name.some((n) => sameWord(n, w))).length;
  return found / title.length >= 0.6;
};

/**
 * Whether a file's own numbers point at the episode it is mapped to: its
 * SxxEyy, or its absolute number.
 */
export const numberedAs = (
  numbers: { season?: number; episode?: number; absolute?: number },
  episode: {
    seasonNumber: number;
    episodeNumber: number;
    absoluteEpisodeNumber?: number;
  }
) =>
  (numbers.season !== undefined &&
    numbers.episode !== undefined &&
    numbers.season === episode.seasonNumber &&
    numbers.episode === episode.episodeNumber) ||
  (numbers.absolute !== undefined &&
    numbers.absolute === episode.absoluteEpisodeNumber);

/**
 * A file's numbers as the agent reads them: Backfill's reading, and also
 * the fansub form "Show S5 - 13", which is season 5's 13th episode and not
 * the series' 13th (as " - 13" alone would be).
 */
export const fileNumbers = (name: string): FileNumbers => {
  const numbers = readNumbers(name);
  if (numbers.season !== undefined) return numbers;
  const seasonDashed = name.match(
    /\bS(?:eason\s*)?(\d{1,2})\s+-\s+(\d{1,3})(?:v\d)?(?=$|[\s[(._])/i
  );
  return seasonDashed
    ? { season: Number(seasonDashed[1]), episode: Number(seasonDashed[2]) }
    : numbers;
};
