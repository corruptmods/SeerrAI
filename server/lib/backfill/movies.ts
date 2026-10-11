import type { PackFile } from '@server/lib/backfill/matcher';
import { sameShow } from '@server/lib/backfill/matcher';
import {
  QUALITY_TOKEN,
  baseName,
  isExtra,
  isVideo,
  readNumbers,
  releaseGroup,
  releaseTags,
} from '@server/lib/backfill/naming';
import type { PlanEntry, PlanSummary } from '@server/lib/backfill/plan';
import { decide, dedupe, summarize } from '@server/lib/backfill/plan';
import type BackfillRadarr from '@server/lib/backfill/radarr';
import type {
  RadarrMovieDetail,
  RadarrMovieFile,
  RadarrParseResult,
} from '@server/lib/backfill/radarr';
import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrQualityProfile,
} from '@server/lib/backfill/sonarr';

/*
 * Judging a pack against one movie. A pack may be the movie alone or a
 * collection; each video in it is read by Radarr as named. A file Radarr
 * cannot place because its name has no year (as collections often have
 * it) is renamed with the movie's title and year and the pack's quality
 * tags, then read again, but only when the title it gives is exactly this
 * movie's ("Toy Story 2" is not "Toy Story"), or when it is the only video
 * in a pack that is this movie by name and year. Only files Radarr maps to
 * this movie are used; the rest of a collection is left out of the
 * download.
 */

export interface MovieContext {
  movie: RadarrMovieDetail;
  file: RadarrMovieFile | null;
  profile: SonarrQualityProfile;
  /** The names the movie goes by: Radarr's title, its aliases, added ones. */
  names: string[];
  radarr: BackfillRadarr;
}

/** Below this a video is a sample or an extra, not a movie. */
const MIN_MOVIE_BYTES = 100 * 1024 * 1024;
/** More files than any real collection: each is a question to Radarr. */
const MAX_PACK_FILES = 200;

type Judgement = Omit<PlanEntry, 'action' | 'reason' | 'replaces'> & {
  problem?: string;
};

/** A year close enough to the movie's to be the same release. */
export const sameYear = (year: number, movie: RadarrMovieDetail): boolean =>
  Math.abs(year - movie.year) <= 1 || year === movie.secondaryYear;

/**
 * The title a name gives, before its year, tags or brackets, without a
 * collection's running number: "02 - Toy.Story.2.1080p" is "Toy Story 2".
 */
export const namedTitle = (name: string): string => {
  const words = name
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/^\d{1,3}\s*[-.]\s+/, '')
    .split(/[\s._]+/)
    .filter(Boolean);
  const end = words.findIndex(
    (word, i) =>
      i > 0 &&
      (/^[[(]/.test(word) ||
        /^(19|20)\d{2}$/.test(word) ||
        QUALITY_TOKEN.test(word))
  );
  return words.slice(0, end < 0 ? words.length : end).join(' ');
};

/** The movie's name in the form Radarr matches, with the file's tags. */
export const movieName = (options: {
  fileName: string;
  packTitle: string;
  title: string;
  year: number;
}): string => {
  const { fileName, packTitle, title, year } = options;
  const group = releaseGroup(fileName) ?? releaseGroup(packTitle);
  const ownTags = releaseTags(fileName);
  const tags = /\b(480p|576p|720p|1080p|2160p)\b/i.test(ownTags)
    ? ownTags
    : [releaseTags(packTitle), ownTags].filter(Boolean).join(' ');
  return `${title} (${year}) ${tags}${group ? `-${group}` : ''}`
    .replace(/\s+/g, ' ')
    .trim();
};

const accepted = (
  base: Judgement,
  movieId: number,
  judgedAs: string,
  result: RadarrParseResult
): Judgement => ({
  ...base,
  judgedAs,
  episodeIds: [movieId],
  quality: result.parsedMovieInfo?.quality,
  languages: result.languages,
  releaseGroup: result.parsedMovieInfo?.releaseGroup,
  score: result.customFormatScore ?? 0,
});

/**
 * One file, judged. `alone` is set when it is the only video in a pack
 * that is this movie by name and year, so a bare file name still counts.
 */
export const judgeMovieFile = async (
  file: PackFile,
  packTitle: string,
  ctx: MovieContext,
  alone: boolean
): Promise<Judgement> => {
  const name = baseName(file.path);
  const base: Judgement = {
    index: file.index,
    path: file.path,
    size: file.size,
    judgedAs: name,
    episodeIds: [],
    score: 0,
  };
  const raw = await ctx.radarr.parse(name);
  if (raw.movie) {
    return raw.movie.id === ctx.movie.id
      ? accepted(base, ctx.movie.id, name, raw)
      : { ...base, problem: `Named as another movie: ${raw.movie.title}` };
  }
  const named = raw.parsedMovieInfo?.primaryMovieTitle;
  const year = raw.parsedMovieInfo?.year;
  if (year && !sameYear(year, ctx.movie)) {
    return { ...base, problem: `From ${year}, not ${ctx.movie.year}` };
  }
  if (named && !sameShow(named, ctx.names)) {
    return { ...base, problem: `Named as another movie: ${named}` };
  }
  if (readNumbers(name).season !== undefined) {
    return { ...base, problem: 'An episode, not a movie' };
  }
  if (!named && !alone && !sameShow(namedTitle(name), ctx.names)) {
    return { ...base, problem: 'Not this movie' };
  }
  const judgedAs = movieName({
    fileName: name,
    packTitle,
    title: ctx.movie.title,
    year: ctx.movie.year,
  });
  const judged = await ctx.radarr.parse(judgedAs);
  if (judged.movie?.id !== ctx.movie.id) {
    return {
      ...base,
      judgedAs,
      problem: 'Radarr could not match it to this movie',
    };
  }
  return accepted(base, ctx.movie.id, judgedAs, judged);
};

/** The movie and its file in the shapes the plan judges episodes in. */
const asEpisodes = (ctx: MovieContext) => {
  const { movie, file } = ctx;
  const episode: SonarrEpisode = {
    id: movie.id,
    seriesId: 0,
    seasonNumber: 0,
    episodeNumber: 0,
    hasFile: movie.hasFile,
    monitored: movie.monitored,
    episodeFileId: movie.movieFileId,
  };
  const onDisk: SonarrEpisodeFile[] = file
    ? [
        {
          id: file.id,
          seasonNumber: 0,
          size: file.size,
          quality: file.quality,
          customFormatScore: file.customFormatScore,
        },
      ]
    : [];
  return {
    episodes: new Map([[movie.id, episode]]),
    files: new Map(onDisk.map((f) => [f.id, f])),
  };
};

/** A pack's files, judged against the movie, and what they add up to. */
export const judgeMoviePack = async (
  files: PackFile[],
  packTitle: string,
  ctx: MovieContext
): Promise<{ plan: PlanEntry[]; summary: PlanSummary }> => {
  const videos = files
    .filter(
      (file) =>
        isVideo(file.path) &&
        !isExtra(file.path) &&
        file.size >= MIN_MOVIE_BYTES
    )
    .slice(0, MAX_PACK_FILES);
  const pack = await ctx.radarr.parse(packTitle);
  const packYear = pack.parsedMovieInfo?.year;
  const alone =
    videos.length === 1 &&
    (pack.movie
      ? pack.movie.id === ctx.movie.id
      : sameShow(namedTitle(packTitle), ctx.names) &&
        (!packYear || sameYear(packYear, ctx.movie)));
  const judged: Judgement[] = [];
  for (const file of videos) {
    judged.push(await judgeMovieFile(file, packTitle, ctx, alone));
  }
  const { episodes, files: onDisk } = asEpisodes(ctx);
  const plan = dedupe(
    judged.map(({ problem, ...entry }) =>
      problem
        ? { ...entry, action: 'reject' as const, reason: problem, replaces: 0 }
        : decide(entry, ctx.profile, episodes, onDisk)
    ),
    ctx.profile
  ).sort(
    (a, b) =>
      Number(b.episodeIds.length > 0) - Number(a.episodeIds.length > 0) ||
      a.index - b.index
  );
  return { plan, summary: summarize(plan) };
};
