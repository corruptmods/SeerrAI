import type { ProwlarrRelease } from '@server/api/prowlarr';
import {
  episodeNamedIn,
  episodeTitled,
  sceneDiffers,
  titleFits,
} from '@server/lib/agent/numbering';
import { episodeLabel } from '@server/lib/agent/rules';
import {
  baseName,
  canonicalName,
  isExtra,
  isVideo,
  readNumbers,
} from '@server/lib/backfill/naming';
import type { PlanEntry, PlanSummary } from '@server/lib/backfill/plan';
import { decide, dedupe, summarize } from '@server/lib/backfill/plan';
import type {
  SecondOpinion,
  UnclearFile,
} from '@server/lib/backfill/secondOpinion';
import { MAX_FILES, episodesFor } from '@server/lib/backfill/secondOpinion';
import type BackfillSonarr from '@server/lib/backfill/sonarr';
import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrQualityProfile,
  SonarrSeriesDetail,
} from '@server/lib/backfill/sonarr';

/*
 * Judging a pack against one series, file by file. Every file is checked
 * twice with Sonarr: once as named, to learn which show it says it is, and
 * once renamed for Sonarr (see naming.ts) to map it to an episode and score
 * it as the release it really is.
 */

export interface SeriesContext {
  series: SonarrSeriesDetail;
  episodes: SonarrEpisode[];
  files: SonarrEpisodeFile[];
  profile: SonarrQualityProfile;
  /** The names the show goes by: Sonarr's title, its aliases, added ones. */
  names: string[];
  sonarr: BackfillSonarr;
  /** Asked about the files nothing else could place, when set up. */
  secondOpinion?: SecondOpinion;
}

export interface PackFile {
  index: number;
  path: string;
  size: number;
}

/** Below this a video is a sample or an extra, not an episode. */
const MIN_EPISODE_BYTES = 20 * 1024 * 1024;
/** More episodes than any real pack: each is a question to Sonarr. */
const MAX_PACK_FILES = 2000;
/** Sonarr is local and quick; four at a time keeps it that way. */
const PARSE_CONCURRENCY = 4;

export const normalize = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * A normalized name without a trailing year ("ninefoldsky2021"), unless
 * the year is all there is to it ("1863", "2034").
 */
const withoutYear = (normalized: string): string => {
  const bare = normalized.replace(/(19|20)\d{2}$/, '');
  return bare.length >= 3 ? bare : normalized;
};

/** Whether a title's name, as a file or pack gives it, is this one. */
export const sameShow = (name: string, names: string[]): boolean => {
  const n = normalize(name);
  if (!n) return false;
  return names.some((candidate) => {
    const c = normalize(candidate);
    return !!c && (n === c || withoutYear(n) === withoutYear(c));
  });
};

/** A release that mentions the title at all, before anything is fetched. */
export const mentionsShow = (title: string, names: string[]): boolean => {
  const t = normalize(title);
  return names.some((name) => {
    const n = withoutYear(normalize(name));
    return n.length >= 3 && t.includes(n);
  });
};

/** How much a result looks like a pack, so packs are opened first. */
export const packScore = (release: ProwlarrRelease): number => {
  const t = release.title;
  let score = 0;
  if (/\b(batch|complete|collection|season|seasons)\b/i.test(t)) score += 4;
  if (/\bS\d{1,2}\s*-\s*S?\d{1,2}\b/i.test(t)) score += 3;
  if (/\b\d{1,4}\s*[-~]\s*\d{1,4}\b/.test(t)) score += 3;
  if (/\bS\d{1,2}\b(?!E)/i.test(t)) score += 2;
  if (release.size > 5 * 1024 ** 3) score += 2;
  return score;
};

/** `fn` over `items`, at most `limit` at a time, results in order. */
export const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }
  );
  await Promise.all(workers);
  return results;
};

/** One file, judged. */
export const judgeFile = async (
  file: PackFile,
  packTitle: string,
  ctx: SeriesContext
): Promise<Judgement> => {
  const name = baseName(file.path);
  const base = {
    index: file.index,
    path: file.path,
    size: file.size,
    judgedAs: name,
    episodeIds: [] as number[],
    score: 0,
  };
  const anime = ctx.series.seriesType === 'anime';
  const numbers = readNumbers(name);
  const raw = await ctx.sonarr.parse(name);
  const info = raw.parsedEpisodeInfo;

  const shownAs = info?.seriesTitle;
  if (shownAs && !sameShow(shownAs, ctx.names)) {
    return { ...base, problem: `Named as another show: ${shownAs}` };
  }

  let absolute = numbers.absolute ?? info?.absoluteEpisodeNumbers?.[0];
  let season = numbers.season ?? info?.seasonNumber;
  const episode = numbers.episode ?? info?.episodeNumbers?.[0];
  if (season === 0 && !episode) season = undefined;

  if (anime && absolute === undefined && season !== undefined && episode) {
    // An anime file with only SxxEyy: take the absolute number of that
    // TVDB episode, so the canonical name is in absolute numbering too.
    absolute = ctx.episodes.find(
      (ep) => ep.seasonNumber === season && ep.episodeNumber === episode
    )?.absoluteEpisodeNumber;
  }
  const number =
    anime && absolute !== undefined
      ? { absolute }
      : season !== undefined && episode
        ? { season, episode }
        : absolute !== undefined
          ? { absolute }
          : undefined;
  if (!number) {
    // Named by its title alone, as specials often are.
    // Only for a missing episode: an extra that happens to carry a title
    // must not be planned over the file there.
    const named = episodeNamedIn(name, ctx.episodes, ctx.names);
    const titled = named && !named.hasFile ? named : undefined;
    const unnumbered = { ...base, problem: 'No episode number in the name' };
    return titled
      ? byItsTitle(unnumbered, base, { name, packTitle, ctx, numbers }, titled)
      : unnumbered;
  }
  // A file holding several episodes keeps all of them: S01E01E02, 01-02.
  const many =
    'absolute' in number ? info?.absoluteEpisodeNumbers : info?.episodeNumbers;
  const through =
    numbers.through ??
    (numbers.absolute === undefined && many && many.length > 1
      ? many[many.length - 1]
      : undefined);

  const judged = await judgeNumber(
    base,
    through ? { ...number, through } : number,
    { name, packTitle, ctx, numbers }
  );
  // A file of several episodes keeps what its numbers say: one title
  // can't speak for all of them.
  if (through || judged.episodeIds.length > 1) return judged;
  return byItsTitle(judged, base, { name, packTitle, ctx, numbers });
};

/**
 * A file whose name carries the very title of another episode than the one
 * its number makes it (or has no number at all, `titled` then). Some
 * groups number a special as S03E01, and a series Sonarr numbers by the
 * scene (TheXEM) reads S08E01 as the scene's S08E01, another library
 * episode. The title says which it is, so the file is judged again as that
 * episode: by the scene's numbers when they differ, else by the library's.
 * When Sonarr won't read it as that episode either way, it is turned down.
 * A name whose title fits the episode its number gives is left alone.
 */
const byItsTitle = async (
  judged: Judgement,
  base: Judgement,
  options: {
    name: string;
    packTitle: string;
    ctx: SeriesContext;
    numbers: { version?: number };
  },
  titled = episodeTitled(options.name, options.ctx.episodes)
): Promise<Judgement> => {
  const { ctx } = options;
  if (!titled || judged.episodeIds.includes(titled.id)) return judged;
  const numbered = ctx.episodes.find((ep) => ep.id === judged.episodeIds[0]);
  if (numbered && titleFits(options.name, numbered)) return judged;
  const anime = ctx.series.seriesType === 'anime';
  const tries: { absolute?: number; season?: number; episode?: number }[] = [];
  if (anime && titled.seasonNumber > 0 && titled.absoluteEpisodeNumber) {
    tries.push({ absolute: titled.absoluteEpisodeNumber });
  }
  if (sceneDiffers(titled)) {
    tries.push({
      season: titled.sceneSeasonNumber!,
      episode: titled.sceneEpisodeNumber!,
    });
  }
  tries.push({ season: titled.seasonNumber, episode: titled.episodeNumber });
  for (const number of tries) {
    const again = await judgeNumber(base, number, options);
    if (
      !again.problem &&
      again.episodeIds.length === 1 &&
      again.episodeIds[0] === titled.id
    ) {
      return {
        ...again,
        season: titled.seasonNumber,
        episode: titled.episodeNumber,
        absolute: titled.absoluteEpisodeNumber ?? again.absolute,
        matchedBy: 'title',
      };
    }
  }
  return {
    ...judged,
    episodeIds: [],
    problem: `Its title is ${episodeLabel(
      titled.seasonNumber,
      titled.episodeNumber
    )} "${titled.title}", which Sonarr won't read it as`,
  };
};

type Judgement = Omit<PlanEntry, 'action' | 'reason' | 'replaces'> & {
  problem?: string;
};

/**
 * A file judged as the episode a number points at: renamed for Sonarr, then
 * checked that Sonarr maps it to this series and that episode.
 */
const judgeNumber = async (
  base: Judgement,
  number: {
    absolute?: number;
    season?: number;
    episode?: number;
    through?: number;
  },
  options: {
    name: string;
    packTitle: string;
    ctx: SeriesContext;
    numbers: { version?: number };
  }
): Promise<Judgement> => {
  const { name, packTitle, ctx, numbers } = options;
  const anime = ctx.series.seriesType === 'anime';
  const { absolute, season, episode } = number;
  const judgedAs = canonicalName({
    fileName: name,
    packTitle,
    seriesTitle: ctx.series.title,
    number,
    version: numbers.version,
  });
  const judged = await ctx.sonarr.parse(judgedAs);
  if (judged.series?.id !== ctx.series.id) {
    return {
      ...base,
      judgedAs,
      absolute,
      season,
      episode,
      problem: 'Sonarr could not match it to this series',
    };
  }
  const episodeIds = (judged.episodes ?? []).map((ep) => ep.id);
  if (
    anime &&
    number.absolute !== undefined &&
    judged.episodes?.length &&
    !judged.episodes.some((ep) => ep.absoluteEpisodeNumber === number.absolute)
  ) {
    return {
      ...base,
      judgedAs,
      absolute,
      problem: `Sonarr mapped episode ${number.absolute} somewhere else`,
    };
  }
  return {
    ...base,
    judgedAs,
    episodeIds,
    absolute: absolute ?? judged.episodes?.[0]?.absoluteEpisodeNumber,
    season: judged.episodes?.[0]?.seasonNumber ?? season,
    episode: judged.episodes?.[0]?.episodeNumber ?? episode,
    quality: judged.parsedEpisodeInfo?.quality,
    languages: judged.languages,
    releaseGroup: judged.parsedEpisodeInfo?.releaseGroup,
    score: judged.customFormatScore ?? 0,
  };
};

/**
 * Asks the second opinion about the files nothing else placed, and judges
 * each answer with Sonarr like any other file. A match Sonarr reads as a
 * different episode is turned down. Returns the files it placed.
 */
const askAbout = async (
  judged: Judgement[],
  packTitle: string,
  ctx: SeriesContext
): Promise<{ placed: Map<number, Judgement>; note?: string }> => {
  const placed = new Map<number, Judgement>();
  const unclear: UnclearFile[] = judged
    .filter((j) => j.problem)
    .slice(0, MAX_FILES)
    .map((j) => ({
      index: j.index,
      name: baseName(j.path),
      problem: j.problem!,
    }));
  if (!ctx.secondOpinion || !unclear.length) return { placed };

  const clear = judged.filter((j) => !j.problem);
  const listed = episodesFor(ctx.episodes, {
    seasons: [...new Set(clear.map((j) => j.season ?? -1))].filter(
      (n) => n >= 0
    ),
    absolutes: clear
      .map((j) => j.absolute)
      .filter((n): n is number => n !== undefined),
  });
  let opinions;
  try {
    opinions = await ctx.secondOpinion({
      series: ctx.series,
      packTitle,
      files: unclear,
      episodes: listed,
    });
  } catch (e) {
    return {
      placed,
      note: `AI second opinion unavailable: ${
        e instanceof Error ? e.message : String(e)
      }`.slice(0, 200),
    };
  }

  const byId = new Map(ctx.episodes.map((ep) => [ep.id, ep]));
  const taken = new Set(clear.flatMap((j) => j.episodeIds));
  const anime = ctx.series.seriesType === 'anime';
  for (const opinion of opinions) {
    const before = judged.find((j) => j.index === opinion.index);
    const eps = opinion.episodeIds.map((id) => byId.get(id)!);
    if (!before || eps.some((ep) => !ep)) continue;
    const first = eps[0];
    const base: Judgement = {
      index: before.index,
      path: before.path,
      size: before.size,
      judgedAs: baseName(before.path),
      episodeIds: [],
      score: 0,
    };
    const label = `S${String(first.seasonNumber).padStart(2, '0')}E${String(
      first.episodeNumber
    ).padStart(2, '0')}`;
    if (eps.some((ep) => taken.has(ep.id))) {
      placed.set(opinion.index, {
        ...base,
        problem: `AI suggested ${label}, but another file already has it`,
      });
      continue;
    }
    const number =
      anime && first.seasonNumber > 0 && first.absoluteEpisodeNumber
        ? { absolute: first.absoluteEpisodeNumber }
        : { season: first.seasonNumber, episode: first.episodeNumber };
    // The AI read the name without its title; a title that is another
    // episode is the stronger reading.
    const titled = episodeTitled(baseName(before.path), ctx.episodes);
    if (titled && !opinion.episodeIds.includes(titled.id)) {
      placed.set(opinion.index, {
        ...base,
        problem: `AI suggested ${label}, but its title is another episode`,
      });
      continue;
    }
    const result = await judgeNumber(base, number, {
      name: baseName(before.path),
      packTitle,
      ctx,
      numbers: readNumbers(baseName(before.path)),
    });
    const agrees =
      !result.problem &&
      opinion.episodeIds.every((id) => result.episodeIds.includes(id)) &&
      result.episodeIds.every((id) => opinion.episodeIds.includes(id));
    placed.set(
      opinion.index,
      agrees
        ? { ...result, matchedBy: 'ai', why: opinion.why || undefined }
        : {
            ...base,
            problem: `AI suggested ${label}, but Sonarr read it differently`,
          }
    );
    if (agrees) eps.forEach((ep) => taken.add(ep.id));
  }
  return { placed };
};

/**
 * Sonarr's scene numbering can read one file as two episodes (a two-part
 * finale the scene released as one, "S03E12"), while the pack has its own
 * file for the second part. Then each such file is taken as the one
 * episode its name gives; a file whose name gives none is turned down.
 */
const settleOverlaps = (
  judged: Judgement[],
  ctx: SeriesContext
): Judgement[] => {
  const claims = new Map<number, number>();
  for (const j of judged) {
    if (j.problem) continue;
    for (const id of j.episodeIds) claims.set(id, (claims.get(id) ?? 0) + 1);
  }
  const anime = ctx.series.seriesType === 'anime';
  /** The one episode a file's own name gives, before any scene mapping. */
  const namedIn = (j: Judgement) => {
    const n = readNumbers(baseName(j.path));
    if (n.through) return undefined;
    return ctx.episodes.find((ep) =>
      anime && n.absolute !== undefined
        ? ep.absoluteEpisodeNumber === n.absolute
        : ep.seasonNumber === n.season && ep.episodeNumber === n.episode
    );
  };
  return judged.map((j) => {
    if (
      j.problem ||
      j.episodeIds.length < 2 ||
      !j.episodeIds.some((id) => (claims.get(id) ?? 0) > 1)
    ) {
      return j;
    }
    const own = namedIn(j);
    if (!own || !j.episodeIds.includes(own.id)) {
      return { ...j, problem: 'Overlaps another file in the pack' };
    }
    return {
      ...j,
      episodeIds: [own.id],
      season: own.seasonNumber,
      episode: own.episodeNumber,
      absolute: own.absoluteEpisodeNumber ?? j.absolute,
    };
  });
};

/** A pack's files, judged and decided, and what they add up to. */
export const judgePack = async (
  files: PackFile[],
  packTitle: string,
  ctx: SeriesContext
): Promise<{ plan: PlanEntry[]; summary: PlanSummary }> => {
  const videos = files
    .filter(
      (file) =>
        isVideo(file.path) &&
        !isExtra(file.path) &&
        file.size >= MIN_EPISODE_BYTES
    )
    .slice(0, MAX_PACK_FILES);
  const episodes = new Map(ctx.episodes.map((ep) => [ep.id, ep]));
  const onDisk = new Map(ctx.files.map((file) => [file.id, file]));
  const first = await mapLimit(videos, PARSE_CONCURRENCY, (file) =>
    judgeFile(file, packTitle, ctx)
  );
  const { placed, note } = await askAbout(first, packTitle, ctx);
  const judged = settleOverlaps(
    first.map((j) => placed.get(j.index) ?? j),
    ctx
  );
  const plan = dedupe(
    judged.map(({ problem, ...entry }) =>
      problem
        ? { ...entry, action: 'reject' as const, reason: problem, replaces: 0 }
        : decide(entry, ctx.profile, episodes, onDisk)
    ),
    ctx.profile
  ).sort(
    (a, b) =>
      (a.absolute ?? a.season ?? 0) - (b.absolute ?? b.season ?? 0) ||
      (a.episode ?? 0) - (b.episode ?? 0) ||
      a.index - b.index
  );
  const summary = summarize(plan);
  return { plan, summary: note ? { ...summary, aiNote: note } : summary };
};

/** The most common reason a pack's files were turned down. */
export const mainReason = (plan: PlanEntry[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const entry of plan) {
    if (
      entry.reason &&
      (entry.action === 'reject' || entry.action === 'skip')
    ) {
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};
