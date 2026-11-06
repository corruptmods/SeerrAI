import { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import type BackfillSeries from '@server/entity/BackfillSeries';
import type { ProposedChange } from '@server/lib/agent/changes';
import { episodeByTitle } from '@server/lib/agent/numbering';
import {
  MIN_VIDEO_BYTES,
  UNKNOWN_QUALITY,
  checkMapping,
  episodeLabel,
  fileNumbers,
  languageProblem,
  namesEpisode,
  numberedAs,
  rangeLabel,
  sizeOf,
} from '@server/lib/agent/rules';
import type {
  AgentState,
  AgentTool,
  KnownRelease,
  TitleRef,
} from '@server/lib/agent/tools/base';
import {
  Refused,
  ToolError,
  adminPresent,
  mayReplace,
  originalOf,
  readTitleRef,
} from '@server/lib/agent/tools/base';
import { filesOf, releaseOf } from '@server/lib/agent/tools/search';
import { musicOn, sameRelease } from '@server/lib/agent/tools/titles';
import { judgeAlbumPack } from '@server/lib/backfill/albums';
import backfill from '@server/lib/backfill/engine';
import type { PackFile } from '@server/lib/backfill/matcher';
import { mentionsShow } from '@server/lib/backfill/matcher';
import { movieName } from '@server/lib/backfill/movies';
import { baseName, canonicalName, isVideo } from '@server/lib/backfill/naming';
import type { PlanEntry } from '@server/lib/backfill/plan';
import {
  airedAWhile,
  airedUnder,
  filmOutAWhile,
  qualityAllowed,
  summarize,
  underWait,
} from '@server/lib/backfill/plan';
import type { RadarrMovieDetail } from '@server/lib/backfill/radarr';
import { sizeNote } from '@server/lib/backfill/sizeLimits';
import type { SonarrQualityProfile } from '@server/lib/backfill/sonarr';
import { blockedGroupOf } from '@server/lib/blockedGroups';
import { getSettings } from '@server/lib/settings';
import { In } from 'typeorm';
import { z } from 'zod';

/*
 * Starting a download of the chosen files through Backfill, or proposing a
 * replacement to an admin; and stopping a download it started.
 */

/**
 * On its own (no admin in the conversation) the agent takes only what the
 * title's quality profile takes, as Backfill's own searches do. A release
 * Sonarr or Radarr would turn down for its quality is left for an admin.
 */
/** On its own, an episode Sonarr still has its first hours with. */
const tooNew = (
  state: AgentState,
  episodes: { hasFile: boolean; airDateUtc?: string }[]
): boolean =>
  !adminPresent(state.run) &&
  episodes.some((ep) => !ep.hasFile && !airedAWhile(ep));

/** On its own, a film Radarr still has its first hours out with. */
const filmTooNew = (state: AgentState, film: RadarrMovieDetail): void => {
  if (adminPresent(state.run) || film.hasFile || filmOutAWhile(film)) return;
  throw new Refused(
    `That film came out ${underWait()}: Radarr gets new films first. Leave it for now.`
  );
};

const outsideProfile = (
  state: AgentState,
  profile: SonarrQualityProfile,
  quality: PlanEntry['quality'],
  score: number
): void => {
  if (adminPresent(state.run)) return;
  const id = quality?.quality.id ?? 0;
  const why =
    !id || !qualityAllowed(profile, id)
      ? `${quality?.quality.name ?? 'Its quality'} is not in the quality profile`
      : score < profile.minFormatScore
        ? `it scores ${score}, below the profile's minimum of ${profile.minFormatScore}`
        : null;
  if (why) {
    throw new Refused(
      `Nothing was started: ${why}. Running on your own, you take only what the profile takes; leave this one for the admin and say so in your summary.`
    );
  }
};

const grabInput = z.object({
  title: z.string(),
  release: z.string(),
  files: z
    .array(
      z.object({
        index: z.coerce.number().int().min(0),
        season: z.coerce.number().int().min(0).optional(),
        episode: z.coerce.number().int().min(0).optional(),
        episodes: z
          .array(z.coerce.number().int().min(0))
          .min(1)
          .max(10)
          .optional(),
      })
    )
    .max(500)
    .default([]),
  reason: z.string().trim().min(3).max(600),
  certain: z.boolean().optional(),
  whole: z.boolean().optional(),
  replace: z.boolean().optional(),
  over_size: z.boolean().optional(),
});

export type GrabInput = z.infer<typeof grabInput>;

const ACTIVE_JOB: BackfillJob['status'][] = [
  'queued',
  'downloading',
  'importing',
  'paused',
];

/**
 * What became of this release for this title before. One an admin declined
 * or that failed is refused. One downloaded before may be reused for other
 * episodes (a full-series pack used season by season): a running download
 * of it takes the new files on, and episodes it failed to import are
 * refused.
 */
const earlierUse = async (seriesId: number, known: KnownRelease) => {
  const earlier = (
    await getRepository(BackfillCandidate).find({
      where: { seriesId, status: In(['approved', 'dead', 'skipped']) },
    })
  ).filter(
    (c) =>
      c.guid === known.guid ||
      (!!known.infoHash && c.infoHash === known.infoHash.toLowerCase()) ||
      // The same post on another indexer fails the same way.
      (c.status === 'dead' && sameRelease(c, known))
  );
  if (earlier.some((c) => c.status === 'skipped')) {
    throw new ToolError(
      'An admin turned this release down for this title. Choose another.'
    );
  }
  const dead = earlier.find((c) => c.status === 'dead');
  if (dead) {
    throw new ToolError(
      `This release failed to download for this title before${
        dead.reason ? ` (${dead.reason})` : ''
      }. Choose another.`
    );
  }
  const jobs = earlier.length
    ? await getRepository(BackfillJob).find({
        where: { candidateId: In(earlier.map((c) => c.id)) },
        order: { id: 'DESC' },
      })
    : [];
  const running = jobs.find((job) => ACTIVE_JOB.includes(job.status));
  if (
    running &&
    running.status !== 'queued' &&
    running.status !== 'downloading'
  ) {
    throw new ToolError(
      `Backfill job #${running.id} is ${running.status} from this release now; once it is done, the release can be taken again for other episodes.`
    );
  }
  const importFailed = new Map<number, number>();
  for (const job of jobs) {
    if (ACTIVE_JOB.includes(job.status)) continue;
    for (const file of job.files) {
      if (file.state !== 'failed') continue;
      for (const id of file.episodeIds) importFailed.set(id, job.id);
    }
  }
  return { running, used: jobs.length > 0, importFailed };
};

const hasFileRefusal = (state: AgentState) =>
  mayReplace(state.run)
    ? 'The movie already has a file. To replace it, call grab again with replace: true; the admin is asked to approve first, and the old file goes only once the new one has imported.'
    : 'The movie already has a file; it is never replaced.';

/**
 * A movie is wanted only while Radarr monitors it, as episodes are in
 * Sonarr. Replacing its existing file is the exception, as for episodes.
 */
const wantedMovie = (
  movie: RadarrMovieDetail,
  args: Pick<GrabInput, 'replace'>
) => movie.monitored || (!!args.replace && movie.hasFile);

const notMonitored = (movie: RadarrMovieDetail) =>
  `${movie.title} is not monitored in Radarr, so it is not wanted.`;

/** A download checked against every rule, not yet started. */
interface PreparedGrab {
  title: TitleRef;
  known: KnownRelease;
  row: BackfillSeries;
  name: string;
  plan: PlanEntry[];
  bytes: number;
  /** "S01E01 Wendle's Picnic Below The Pier", per plan entry. */
  targets: string[];
  /** What could make it wrong, for an admin to judge. */
  doubts: string[];
  /** A running download of this release, to add these files to. */
  extend?: BackfillJob;
}

/**
 * A Usenet post in archives or with scrambled names, taken whole. Its
 * contents are only known once downloaded, so its name is the proof:
 * Sonarr (or Radarr) must read it as exactly this one missing episode (or
 * this movie) in a wanted language, and its one video is imported as that.
 * On a scene-numbered series, a name in library numbering also counts if
 * it carries the episode's title.
 */
const prepareWhole = async (
  state: AgentState,
  args: GrabInput,
  ctx: {
    title: TitleRef;
    known: KnownRelease;
    row: BackfillSeries;
    backfilling: Map<number, number>;
  }
): Promise<PreparedGrab> => {
  const { title, known, row, backfilling } = ctx;
  const settings = getSettings().backfill;
  if (args.files.length !== 1) {
    throw new ToolError(
      'A release taken whole is for one episode (or the movie): give one file entry, index 0.'
    );
  }
  const wanted = args.files[0];
  const entry: PlanEntry = {
    index: 0,
    path: known.title,
    size: known.size,
    judgedAs: known.title,
    episodeIds: [],
    score: 0,
    action: 'fill',
    replaces: 0,
    matchedBy: 'ai',
    why: args.reason,
    whole: true,
  };
  let name = row.title;
  let target: string;
  if (title.kind === 'movie') {
    const movieCtx = await backfill.movieContext(row);
    const movie = movieCtx.movie;
    name = movie.title;
    if (movie.hasFile && !args.replace) {
      throw new ToolError(hasFileRefusal(state));
    }
    if (!wantedMovie(movie, args)) {
      throw new ToolError(notMonitored(movie));
    }
    if (await movieCtx.radarr.getMovieQueueCount(movie.id)) {
      throw new ToolError('The movie is already downloading in Radarr.');
    }
    const parsed = await movieCtx.radarr.parse(known.title).catch(() => null);
    if (parsed?.movie?.id !== movie.id) {
      throw new ToolError(
        `Radarr does not read "${known.title}" as ${movie.title} (${movie.year}), so it cannot be taken unopened. Choose a release that can be opened.`
      );
    }
    const problem = languageProblem(
      parsed.languages,
      movie.originalLanguage?.name
    );
    if (problem) throw new Refused(problem);
    outsideProfile(
      state,
      movieCtx.profile,
      parsed.parsedMovieInfo?.quality ?? UNKNOWN_QUALITY,
      parsed.customFormatScore ?? 0
    );
    filmTooNew(state, movieCtx.movie);
    Object.assign(entry, {
      // A movie's plan entry carries the movie's id, as Backfill's own do.
      episodeIds: [movie.id],
      quality: parsed.parsedMovieInfo?.quality ?? UNKNOWN_QUALITY,
      languages: parsed.languages ?? [],
      releaseGroup: parsed.parsedMovieInfo?.releaseGroup,
      score: parsed.customFormatScore ?? 0,
      ...(movie.hasFile ? { action: 'upgrade' as const, replaces: 1 } : {}),
    });
    target = `${movie.title} (${movie.year})`;
  } else {
    const seriesCtx = await backfill.context(row);
    const series = seriesCtx.series;
    name = series.title;
    const parsed = await seriesCtx.sonarr.parse(known.title).catch(() => null);
    const info = parsed?.parsedEpisodeInfo;
    const read = parsed?.episodes ?? [];
    if (parsed?.series?.id !== series.id) {
      throw new ToolError(
        `Sonarr does not read "${known.title}" as ${series.title}, so it cannot be taken unopened. Choose a release that can be opened.`
      );
    }
    if (info?.fullSeason || info?.isMultiSeason || read.length !== 1) {
      throw new ToolError(
        `Sonarr reads "${known.title}" as ${
          info?.fullSeason || info?.isMultiSeason
            ? 'a season pack'
            : read.length
              ? `${read.length} episodes`
              : 'no episode it knows'
        }. Only a release that is exactly one episode can be taken unopened; for more, choose a release that can be opened.`
      );
    }
    // Sonarr's reading, unless Sonarr reads it by scene numbering and the
    // name, in library numbering, carries the wanted episode's title. The
    // title must not name another episode.
    const mapped = read[0];
    const wantedEp = seriesCtx.episodes.find(
      (ep) =>
        ep.seasonNumber === wanted.season && ep.episodeNumber === wanted.episode
    );
    const byTitle = episodeByTitle(known.title, seriesCtx.episodes);
    const sameAsWanted =
      wanted.season === mapped.seasonNumber &&
      wanted.episode === mapped.episodeNumber;
    const namedAsWanted =
      !!wantedEp &&
      info?.seasonNumber === wanted.season &&
      info?.episodeNumbers?.length === 1 &&
      info.episodeNumbers[0] === wanted.episode &&
      byTitle?.id === wantedEp.id;
    if (!sameAsWanted && !namedAsWanted) {
      throw new ToolError(
        `Sonarr reads "${known.title}" as ${episodeLabel(
          mapped.seasonNumber,
          mapped.episodeNumber
        )}, not ${episodeLabel(wanted.season ?? 0, wanted.episode ?? 0)}${
          byTitle
            ? `, and its title is ${episodeLabel(byTitle.seasonNumber, byTitle.episodeNumber)} "${byTitle.title ?? ''}"`
            : ''
        }. Nothing was started.`
      );
    }
    if (sameAsWanted && byTitle && byTitle.id !== mapped.id) {
      throw new ToolError(
        `Sonarr reads "${known.title}" as ${episodeLabel(
          mapped.seasonNumber,
          mapped.episodeNumber
        )}, but its title is ${episodeLabel(byTitle.seasonNumber, byTitle.episodeNumber)} "${byTitle.title ?? ''}". Nothing was started.`
      );
    }
    const episode = sameAsWanted ? mapped : wantedEp!;
    const queued = new Set(
      await seriesCtx.sonarr
        .getSeriesQueueEpisodes(series.id)
        .catch(() => [] as number[])
    );
    // The same checks as for an opened release, with the post as its one
    // file.
    const { problems } = checkMapping(
      [
        {
          index: 0,
          season: episode.seasonNumber,
          episode: episode.episodeNumber,
        },
      ],
      [{ index: 0, path: `${known.title}.mkv`, size: known.size }],
      seriesCtx.episodes,
      {
        queued,
        backfilling,
        isVideo: () => true,
        replace: args.replace,
        canReplace: mayReplace(state.run),
      }
    );
    if (problems.length) {
      throw new ToolError(`Nothing was started. ${problems.join(' ')}`);
    }
    const problem = languageProblem(parsed.languages, originalOf(series));
    if (problem) throw new Refused(problem);
    outsideProfile(
      state,
      seriesCtx.profile,
      info?.quality ?? UNKNOWN_QUALITY,
      parsed.customFormatScore ?? 0
    );
    const full = seriesCtx.episodes.find((e) => e.id === episode.id);
    if (full && tooNew(state, [full])) {
      throw new Refused(
        `That episode ${airedUnder().toLowerCase()}: Sonarr gets new episodes first.`
      );
    }
    Object.assign(entry, {
      episodeIds: [episode.id],
      season: episode.seasonNumber,
      episode: episode.episodeNumber,
      quality: info?.quality ?? UNKNOWN_QUALITY,
      languages: parsed.languages ?? [],
      releaseGroup: info?.releaseGroup,
      score: parsed.customFormatScore ?? 0,
      ...(full?.hasFile ? { action: 'upgrade' as const, replaces: 1 } : {}),
    });
    target = `${episodeLabel(episode.seasonNumber, episode.episodeNumber)} ${
      full?.title ?? ''
    }`.trim();
  }
  if (known.size > settings.agent.maxSizeGb * 1024 ** 3) {
    throw new ToolError(
      `That is ${sizeOf(known.size)}, over the ${settings.agent.maxSizeGb} GB limit for one download. Choose a smaller release.`
    );
  }
  return {
    title,
    known,
    row,
    name,
    plan: [entry],
    bytes: known.size,
    targets: [target],
    doubts: [],
  };
};

/**
 * An album's release. Backfill matches its files to the tracks of the
 * edition Lidarr imports into, as for packs it finds itself, taking what
 * fills a missing track (and, when replacing, what Lidarr's profile
 * prefers to a track on disk). Chosen files, if given, narrow that.
 */
const prepareAlbum = async (
  state: AgentState,
  args: GrabInput,
  ctx: {
    title: TitleRef;
    known: KnownRelease;
    row: BackfillSeries;
    files: PackFile[];
    before: Awaited<ReturnType<typeof earlierUse>>;
  }
): Promise<PreparedGrab> => {
  const { title, known, row, files, before } = ctx;
  if (known.packed) {
    throw new ToolError(
      "This Usenet post can't be opened, so its files can't be matched to the album's tracks. Choose a release that can be opened."
    );
  }
  const album = await backfill.albumContext(row);
  const name = `${album.album.title} by ${album.artist.artistName}`;
  if (!album.album.monitored && !args.replace) {
    throw new ToolError(
      `${name} is not monitored in Lidarr, so it is not wanted.`
    );
  }
  if (await album.lidarr.getAlbumQueueCount(album.album.id).catch(() => 0)) {
    throw new ToolError('The album is already downloading in Lidarr.');
  }
  const { plan: judged } = await judgeAlbumPack(files, known.title, album);
  const chosen = new Set(args.files.map((f) => f.index));
  const wanted = judged.filter(
    (e) =>
      (e.action === 'fill' || (!!args.replace && e.action === 'upgrade')) &&
      (!chosen.size || chosen.has(e.index)) &&
      !e.episodeIds.some((id) => before.importFailed.has(id))
  );
  if (!wanted.length) {
    const reasons = new Map<string, number>();
    for (const e of judged) {
      if (e.action === 'fill') continue;
      const why =
        e.action === 'upgrade'
          ? 'would replace a track on disk'
          : (e.reason ?? e.action);
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
    }
    const failedBefore = judged.filter((e) =>
      e.episodeIds.some((id) => before.importFailed.has(id))
    ).length;
    throw new ToolError(
      `Nothing was started: nothing in "${known.title}" fills a missing track of ${name}${
        reasons.size
          ? ` (${[...reasons]
              .map(([why, n]) => `${n} ${n === 1 ? 'file' : 'files'}: ${why}`)
              .slice(0, 6)
              .join('; ')})`
          : ''
      }${
        failedBefore
          ? `; ${failedBefore} did not import from this release before`
          : ''
      }. Choose another release.`
    );
  }
  const trackOf = new Map([...album.tracks].map((t) => [t.id, t] as const));
  const plan = wanted.map((e) => ({ ...e, why: args.reason }));
  const targets = plan.map((e) => {
    const track = trackOf.get(e.episodeIds[0]);
    return `Track ${e.episode ?? '?'}${track ? ` "${track.title}"` : ''}`;
  });
  const bytes = plan.reduce((n, e) => n + e.size, 0);
  if (bytes > getSettings().backfill.agent.maxSizeGb * 1024 ** 3) {
    throw new ToolError(
      `That is ${sizeOf(bytes)}, over the ${getSettings().backfill.agent.maxSizeGb} GB limit for one download. Choose a smaller release.`
    );
  }
  return {
    title,
    known,
    row,
    name,
    plan,
    bytes,
    targets,
    doubts: [],
    extend: before.running,
  };
};

/**
 * Checks a download against every rule and builds what Backfill needs,
 * without starting anything. Throws if it cannot be done; lists doubts the
 * model must recheck before claiming certainty (and an admin sees in a
 * replacement).
 */
const prepareGrab = async (
  state: AgentState,
  args: GrabInput
): Promise<PreparedGrab> => {
  if (args.replace && !mayReplace(state.run)) {
    throw new ToolError(
      'Files are replaced only when an admin asks for it. Fill what is missing instead.'
    );
  }
  const title = readTitleRef(args.title);
  const known = releaseOf(state, args.release);
  if (title.kind !== 'album' && !args.files.length) {
    throw new ToolError(
      'Give the files to fetch, by their index from release_files.'
    );
  }
  if (title.kind === 'album' && !musicOn()) {
    throw new ToolError(
      'Backfill does not do music now (Music too in Settings → Backfill), so albums cannot be downloaded.'
    );
  }
  const settings = getSettings().backfill;
  const group = blockedGroupOf(known.title);
  if (group) {
    throw new ToolError(
      `${group} is a blocked release group. Choose another release.`
    );
  }
  const ready = backfill.readiness();
  if (!ready.ready) throw new ToolError(ready.problem ?? 'Backfill is off.');
  if (state.grabsToday >= settings.agent.maxGrabsPerDay) {
    throw new ToolError(
      `The limit of ${settings.agent.maxGrabsPerDay} downloads a day is reached. Say what you would grab instead.`
    );
  }
  const files = await filesOf(state, known);
  // A title an admin asked about stays tracked in Backfill.
  const row = await backfill.track(
    title.kind,
    title.serverId,
    title.arrId,
    adminPresent(state.run)
  );
  // Running downloads for the title; another can run beside them for other
  // episodes.
  const running = await getRepository(BackfillJob).find({
    where: {
      seriesId: row.id,
      status: In(['queued', 'downloading', 'importing', 'paused']),
    },
  });
  if (running.length && title.kind !== 'series') {
    throw new ToolError(
      `Backfill job #${running[0].id} is already downloading this ${title.kind}.`
    );
  }
  const backfilling = new Map<number, number>();
  for (const job of running) {
    for (const file of job.files) {
      for (const id of file.episodeIds) backfilling.set(id, job.id);
    }
  }
  const before = await earlierUse(row.id, known);
  if (title.kind !== 'series' && before.used && !before.running) {
    throw new ToolError(
      `This release was downloaded for this ${title.kind} before and did not import. Choose another.`
    );
  }
  if (title.kind === 'album') {
    return prepareAlbum(state, args, { title, known, row, files, before });
  }

  const titleLanguage = async (original?: string) =>
    languageProblem(
      (
        await (
          title.kind === 'movie'
            ? backfill.radarrFor(title.serverId).parse(known.title)
            : backfill.sonarrFor(title.serverId).parse(known.title)
        ).catch(() => null)
      )?.languages,
      original
    );

  if (args.whole || known.packed) {
    if (!known.packed) {
      throw new ToolError(
        'whole is only for a Usenet post packed in archives or with scrambled names (release_files says so). Choose its files from release_files.'
      );
    }
    if (before.running) {
      throw new ToolError(
        `Backfill job #${before.running.id} is already downloading this release.`
      );
    }
    return prepareWhole(state, args, { title, known, row, backfilling });
  }

  const plan: PlanEntry[] = [];
  const targets: string[] = [];
  const doubts: string[] = [];
  let name = row.title;
  if (title.kind === 'movie') {
    const ctx = await backfill.movieContext(row);
    name = ctx.movie.title;
    if (ctx.movie.hasFile && !args.replace) {
      throw new ToolError(hasFileRefusal(state));
    }
    if (!wantedMovie(ctx.movie, args)) {
      throw new ToolError(notMonitored(ctx.movie));
    }
    if (await ctx.radarr.getMovieQueueCount(ctx.movie.id)) {
      throw new ToolError('The movie is already downloading in Radarr.');
    }
    if (args.files.length !== 1) {
      throw new ToolError('Choose exactly one file for a movie.');
    }
    const file = files.find((f) => f.index === args.files[0].index);
    if (!file || !isVideo(file.path) || file.size < MIN_VIDEO_BYTES) {
      throw new ToolError(
        `File #${args.files[0].index} is not a video in this release.`
      );
    }
    const original = ctx.movie.originalLanguage?.name;
    const releaseProblem = await titleLanguage(original);
    if (releaseProblem) throw new Refused(releaseProblem);
    if (!mentionsShow(known.title, ctx.names)) {
      doubts.push(`The release's name does not name ${ctx.movie.title}.`);
    }
    const judgedAs = movieName({
      fileName: baseName(file.path),
      packTitle: known.title,
      title: ctx.movie.title,
      year: ctx.movie.year,
    });
    const parsed = await ctx.radarr.parse(judgedAs).catch(() => null);
    const problem = languageProblem(parsed?.languages, original);
    if (problem) throw new Refused(problem);
    outsideProfile(
      state,
      ctx.profile,
      parsed?.parsedMovieInfo?.quality ?? UNKNOWN_QUALITY,
      parsed?.customFormatScore ?? 0
    );
    filmTooNew(state, ctx.movie);
    plan.push({
      index: file.index,
      path: file.path,
      size: file.size,
      judgedAs,
      // The movie's id, as in Backfill's own plans: it is used to check
      // what is on disk before the download starts.
      episodeIds: [ctx.movie.id],
      quality: parsed?.parsedMovieInfo?.quality ?? UNKNOWN_QUALITY,
      languages: parsed?.languages ?? [],
      releaseGroup: parsed?.parsedMovieInfo?.releaseGroup,
      score: parsed?.customFormatScore ?? 0,
      action: ctx.movie.hasFile ? 'upgrade' : 'fill',
      replaces: ctx.movie.hasFile ? 1 : 0,
      matchedBy: 'ai',
      why: args.reason,
    });
    targets.push(`${ctx.movie.title} (${ctx.movie.year})`);
  } else {
    const ctx = await backfill.context(row);
    name = ctx.series.title;
    const queued = new Set(
      await ctx.sonarr
        .getSeriesQueueEpisodes(ctx.series.id)
        .catch(() => [] as number[])
    );
    const { ok, problems } = checkMapping(args.files, files, ctx.episodes, {
      queued,
      backfilling,
      importFailed: before.importFailed,
      isVideo,
      replace: args.replace,
      canReplace: mayReplace(state.run),
    });
    if (problems.length) {
      throw new ToolError(
        `Nothing was started. ${problems.slice(0, 12).join(' ')}${
          problems.length > 12 ? ` (${problems.length - 12} more)` : ''
        }`
      );
    }
    const original = originalOf(ctx.series);
    const releaseProblem = await titleLanguage(original);
    if (releaseProblem) throw new Refused(releaseProblem);
    if (!mentionsShow(known.title, ctx.names)) {
      doubts.push(`The release's name does not name ${ctx.series.title}.`);
    }
    for (const { file, episode, episodes } of ok) {
      const fileName = baseName(file.path);
      const season = episode.seasonNumber;
      const numbers = episodes.map((e) => e.episodeNumber);
      const label = rangeLabel(season, numbers);
      const full = episodes.map((e) => ctx.episodes.find((x) => x.id === e.id));
      const own = fileNumbers(fileName);
      const ownLast = own.through ?? own.episode;
      // A file named as several episodes must be given all of them, or
      // Sonarr names it as the first and the rest stay missing.
      if (
        own.season === season &&
        own.episode === numbers[0] &&
        ownLast !== undefined &&
        ownLast !== numbers[numbers.length - 1]
      ) {
        const holds = Array.from(
          { length: ownLast - numbers[0] + 1 },
          (_, i) => numbers[0] + i
        );
        throw new ToolError(
          `Nothing was started. File #${file.index} "${fileName}" is ${rangeLabel(season, holds)} by its name, but it was given ${label}. Give it every episode it holds: episodes: [${holds.join(', ')}].`
        );
      }
      // A name carrying another episode's title is that episode, whatever
      // its number: releases number their own way (a special counted as
      // episode 1, scene seasons), but the title is reliable.
      const titled = episodeByTitle(fileName, ctx.episodes);
      if (titled && !episodes.some((e) => e.id === titled.id)) {
        throw new ToolError(
          `Nothing was started. File #${file.index} "${fileName}" is ${episodeLabel(
            titled.seasonNumber,
            titled.episodeNumber
          )} "${titled.title ?? ''}" by its title${
            titled.hasFile ? ', which is on disk' : ''
          }, not ${label} ${full
            .map((e) => `"${e?.title ?? ''}"`)
            .join(' + ')}. Map each file by its title, not its number.`
        );
      }
      const named =
        full.every((e) => namesEpisode(fileName, e?.title)) ||
        (numbers.length === 1
          ? numberedAs(own, {
              seasonNumber: season,
              episodeNumber: numbers[0],
              absoluteEpisodeNumber: full[0]?.absoluteEpisodeNumber,
            })
          : own.season === season &&
            own.episode === numbers[0] &&
            ownLast === numbers[numbers.length - 1]);
      if (!named) {
        doubts.push(
          `File #${file.index} "${fileName}" names neither ${label} ${full
            .map((e) => `"${e?.title ?? ''}"`)
            .join(' + ')} nor its number.`
        );
      }
      if (numbers.length > 1) {
        doubts.push(
          `File #${file.index} holds ${numbers.length} episodes (${label}). One file per episode is preferred: take files holding several episodes only when no release has these episodes one per file.`
        );
      }
      const judgedAs = canonicalName({
        fileName,
        packTitle: known.title,
        seriesTitle: ctx.series.title,
        number: {
          season,
          episode: numbers[0],
          ...(numbers.length > 1
            ? { through: numbers[numbers.length - 1] }
            : {}),
        },
      });
      const parsed = await ctx.sonarr.parse(judgedAs).catch(() => null);
      const problem = languageProblem(parsed?.languages, original);
      if (problem) {
        // Only this file; the rest of the pack may be fine.
        throw new ToolError(`File #${file.index}: ${problem}`);
      }
      outsideProfile(
        state,
        ctx.profile,
        parsed?.parsedEpisodeInfo?.quality ?? UNKNOWN_QUALITY,
        parsed?.customFormatScore ?? 0
      );
      if (tooNew(state, episodes)) {
        throw new Refused(
          `File #${file.index} is for an episode that ${airedUnder().toLowerCase()}: Sonarr gets new episodes first. Leave it out.`
        );
      }
      plan.push({
        index: file.index,
        path: file.path,
        size: file.size,
        judgedAs,
        episodeIds: episodes.map((e) => e.id),
        season,
        episode: numbers[0],
        quality: parsed?.parsedEpisodeInfo?.quality ?? UNKNOWN_QUALITY,
        languages: parsed?.languages ?? [],
        releaseGroup: parsed?.parsedEpisodeInfo?.releaseGroup,
        score: parsed?.customFormatScore ?? 0,
        action: episodes.some((e) => e.hasFile) ? 'upgrade' : 'fill',
        replaces: episodes.filter((e) => e.hasFile).length,
        matchedBy: 'ai',
        why: args.reason,
      });
      targets.push(
        `${label} ${full.map((e) => e?.title ?? '').join(' + ')}`.trim()
      );
    }
  }

  const bytes = plan.reduce((n, e) => n + e.size, 0);
  if (bytes > settings.agent.maxSizeGb * 1024 ** 3) {
    throw new ToolError(
      `That is ${sizeOf(bytes)}, over the ${settings.agent.maxSizeGb} GB limit for one download. Choose fewer files or a smaller release.`
    );
  }
  return {
    title,
    known,
    row,
    name,
    plan,
    bytes,
    targets,
    doubts,
    extend: before.running,
  };
};

/** Starts a prepared download through Backfill and records it. */
const commitGrab = async (
  state: AgentState,
  prepared: PreparedGrab,
  by: string
): Promise<string> => {
  const { title, known, row, name, plan, bytes } = prepared;
  const labels =
    title.kind === 'movie'
      ? 'the movie'
      : title.kind === 'album'
        ? plan.length === 1
          ? '1 track'
          : `${plan.length} tracks`
        : plan
            .map((e) =>
              rangeLabel(
                e.season ?? 0,
                e.episodeIds.map((_, i) => (e.episode ?? 0) + i)
              )
            )
            .join(', ');
  const files = `${plan.length === 1 ? '1 file' : `${plan.length} files`} (${sizeOf(bytes)})`;
  const replaces = plan.some((e) => e.action === 'upgrade');
  if (prepared.extend && replaces) {
    throw new ToolError(
      `Backfill job #${prepared.extend.id} is downloading this release now; files can be replaced from it once that is done.`
    );
  }
  if (prepared.extend) {
    const job = await backfill
      .extendJob(prepared.extend.id, plan, by)
      .catch((e: unknown) => {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      });
    state.grabsToday += 1;
    state.bind(title, name);
    state.act({
      at: new Date().toISOString(),
      type: 'grab',
      title: name,
      detail: `${files} more from "${known.title}" for ${labels}, added to Backfill job #${job.id}`,
      jobId: job.id,
      extended: true,
      episodeIds: plan.flatMap((e) => e.episodeIds),
      release: known.title,
    });
    return `Added to Backfill job #${job.id}, which is already downloading this release: ${plan.length} files, ${sizeOf(bytes)}, for ${labels}. They are fetched and imported with the rest of it.`;
  }
  const candidate = await getRepository(BackfillCandidate).save(
    new BackfillCandidate({
      seriesId: row.id,
      guid: known.guid,
      title: known.title,
      indexer: known.indexer,
      indexerId: known.indexerId,
      protocol: known.protocol,
      size: known.size,
      seeders: known.seeders ?? null,
      publishDate: known.publishDate ?? null,
      downloadUrl: known.downloadUrl ?? null,
      magnetUrl: known.magnetUrl ?? null,
      infoHash: known.infoHash?.toLowerCase() ?? null,
      status: 'ready',
      reason: null,
      plan,
      summary: summarize(plan),
      // Approved at once, so no waiting notification is needed.
      notifiedAt: new Date(),
    })
  );
  const job = await backfill.approve(candidate.id, {
    // Replacing was approved by an admin before this point.
    mode: replaces ? 'all' : 'missing',
    includeAi: true,
    by,
    // If it fails, the conversation is told so it can look for another.
    agentRunId: state.run.id,
  });
  state.grabsToday += 1;
  state.bind(title, name);
  state.act({
    at: new Date().toISOString(),
    type: 'grab',
    title: name,
    detail: `${files} from "${known.title}" for ${labels}${
      replaces ? ', replacing what is there once imported' : ''
    }`,
    jobId: job.id,
    episodeIds: plan.flatMap((e) => e.episodeIds),
    release: known.title,
  });
  return `Started Backfill job #${job.id}: ${plan.length} files, ${sizeOf(bytes)}, for ${labels}. Backfill downloads only these files and has ${
    title.kind === 'movie'
      ? 'Radarr'
      : title.kind === 'album'
        ? 'Lidarr'
        : 'Sonarr'
  } import each as mapped${
    replaces
      ? '; a file already there is replaced only once its new one has imported'
      : ''
  }.${
    job.indexerWait
      ? ` For now it waits: ${job.stage}; Backfill tries again by itself, so do not grab it again.`
      : ''
  }`;
};

/** What an admin is shown of a grab: the release opened and its files. */
interface ShownGrab {
  infoHash: string | null;
  files: { path: string; size: number }[];
  doubts: string[];
}

const shownOf = (prepared: PreparedGrab): ShownGrab => ({
  infoHash: prepared.known.infoHash?.toLowerCase() ?? null,
  files: prepared.plan.map((e) => ({ path: e.path, size: e.size })),
  doubts: prepared.doubts,
});

/**
 * Why a grab prepared again on approval is not the one shown, or null.
 * Proposals saved before this was kept are not compared.
 */
const changedSince = (
  prepared: PreparedGrab,
  shown: ShownGrab | undefined
): string | null => {
  if (!shown) return null;
  const now = shownOf(prepared);
  if (shown.infoHash && now.infoHash && shown.infoHash !== now.infoHash) {
    return 'The release is not the one that was opened when this was approved';
  }
  const key = (f: { path: string; size: number }) => `${f.path}\0${f.size}`;
  const before = shown.files.map(key).sort();
  const after = now.files.map(key).sort();
  if (
    before.length !== after.length ||
    before.some((file, i) => file !== after[i])
  ) {
    return 'The files it would take are not the ones shown when this was approved';
  }
  const fresh = now.doubts.filter((doubt) => !shown.doubts.includes(doubt));
  if (fresh.length) {
    return `Something changed since this was approved: ${fresh.join(' ')}`;
  }
  return null;
};

/**
 * A replacing grab for an admin to approve: what goes and what comes. On
 * approval it is rechecked from scratch and started.
 */
const replaceProposal = (
  prepared: PreparedGrab,
  args: GrabInput,
  sizes?: string
): ProposedChange => {
  const { title, known, name, plan, targets, bytes } = prepared;
  const replaced = plan.filter((e) => e.action === 'upgrade');
  const app =
    title.kind === 'movie'
      ? 'Radarr'
      : title.kind === 'album'
        ? 'Lidarr'
        : 'Sonarr';
  return {
    kind: 'replace',
    headline:
      title.kind === 'movie'
        ? `Replace the file of ${name}`
        : title.kind === 'album'
          ? `Replace ${replaced.length === 1 ? 'a track' : `${replaced.length} tracks`} of ${name}`
          : `Replace ${replaced.length === 1 ? 'a file' : `${replaced.length} files`} of ${name}`,
    title,
    details: [
      `Downloads "${known.title}" (${sizeOf(bytes)}, ${known.indexer}) through Backfill, only the files chosen.`,
      `For: ${targets.slice(0, 12).join('; ')}${targets.length > 12 ? ` and ${targets.length - 12} more` : ''}.`,
      `${app} imports each new file over the one there; until it has, the old file stays and can still be played.`,
      ...(sizes ? [`${sizes}.`] : []),
      ...(prepared.doubts.length
        ? [`Doubts the agent waved through: ${prepared.doubts.join(' ')}`]
        : []),
      `Why: ${args.reason}`,
    ],
    params: { grab: { ...args, certain: true }, shown: shownOf(prepared) },
  };
};

/**
 * The agent's best grab outside Sonarr's or Radarr's size limits, for an
 * admin to approve or decline. On approval it is rechecked from scratch and
 * started.
 */
const oversizeProposal = (
  prepared: PreparedGrab,
  args: GrabInput,
  sizes: string
): ProposedChange => {
  const { title, known, name, targets, bytes } = prepared;
  return {
    kind: 'oversizeGrab',
    headline: `Download ${name}, outside the size limits`,
    title,
    details: [
      `Downloads "${known.title}" (${sizeOf(bytes)}, ${known.indexer}) through Backfill, only the files chosen.`,
      `For: ${targets.slice(0, 12).join('; ')}${targets.length > 12 ? ` and ${targets.length - 12} more` : ''}.`,
      `${sizes}. No release within the limits had the files.`,
      ...(prepared.doubts.length
        ? [`Doubts the agent waved through: ${prepared.doubts.join(' ')}`]
        : []),
      `Why: ${args.reason}`,
    ],
    params: { grab: { ...args, certain: true }, shown: shownOf(prepared) },
  };
};

export const grab: AgentTool = {
  name: 'grab',
  acts: true,
  description:
    "Downloads chosen files of a release through Backfill and imports each as the episode you map it to (or as the movie). It only fills episodes with no file and never replaces one. One file per episode is preferred: take a release whose files each hold several episodes only when none has them one per file, and then give each such file all its episodes. Map files by comparing file titles with episode titles: a collection may number files its own way. If a file names neither its episode title nor its number, you are asked to look again; call it again with certain: true only once you are sure. A pack used before for other episodes (one season of a full-series pack) can be taken again for the rest; while it is still downloading, the new files join that download. For an album, give no files: Backfill matches the release's files to the album's tracks itself and takes those that fill missing tracks, or says why none do.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A title reference.' },
      release: { type: 'string', description: 'Like r3.' },
      files: {
        type: 'array',
        description:
          'Each file to fetch, by index from release_files, with the season and episode it is. A file holding several episodes (S06E01-02, "Title A + Title B") gets every one of them in episodes instead, like episodes: [1, 2]; Sonarr then names it S06E01-E02. For a movie, one file and no season or episode. For an album, leave it out (or give only indexes, to take just those files).',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            season: { type: 'integer' },
            episode: { type: 'integer' },
            episodes: {
              type: 'array',
              items: { type: 'integer' },
              description:
                'Every episode a file holds, in a row, when it holds several.',
            },
          },
          required: ['index'],
        },
      },
      reason: {
        type: 'string',
        description: 'Why this release and this mapping are right.',
      },
      certain: {
        type: 'boolean',
        description:
          'Only after it said to look again, and you did, and you are sure.',
      },
      whole: {
        type: 'boolean',
        description:
          'For a Usenet post packed in archives or with scrambled names (release_files says so) whose name is exactly one missing episode or the movie: takes it whole. Give one file entry, index 0, with the season and episode.',
      },
      over_size: {
        type: 'boolean',
        description:
          "Only after grab said the release is outside Sonarr's or Radarr's size limits, and you found no release within them with the files: asks the admin to approve this one. Nothing starts until they do.",
      },
      replace: {
        type: 'boolean',
        description:
          'Only when the admin (or the report) asked for a file to be replaced: lets episodes (or a movie) that have a file be mapped. Nothing starts until the admin approves; the old file goes only once the new one has imported.',
      },
    },
    required: ['title', 'release', 'reason'],
  },
  async run(state, input) {
    const args = grabInput.parse(input);
    const prepared = await prepareGrab(state, args);
    if (prepared.doubts.length && !args.certain) {
      throw new ToolError(
        `Not started. Look again: ${prepared.doubts.slice(0, 8).join(' ')} Check the file names against the episode titles (and the release against the show). If you are sure it is right, call grab again with certain: true; if not, choose another release, or ask the admin.`
      );
    }
    // Outside Sonarr's or Radarr's size limits is the admin's call. Limits
    // that cannot be read don't block.
    const outside = await backfill
      .sizeProblemsFor(prepared.title, prepared.plan)
      .catch(() => []);
    const note = sizeNote(outside);
    if (prepared.plan.some((e) => e.action === 'upgrade')) {
      if (prepared.extend) {
        throw new ToolError(
          `Backfill job #${prepared.extend.id} is downloading this release now; files can be replaced from it once that is done.`
        );
      }
      state.propose(replaceProposal(prepared, args, note));
      return "Not started yet: replacing files needs the admin's approval, and they have been asked. Stop here; you hear what they decided next.";
    }
    if (note) {
      if (!args.over_size) {
        throw new ToolError(
          `Not started. ${note}. Look for a release within the limits first. Only when none has the files, call grab again with over_size: true to ask the admin to approve this one.`
        );
      }
      state.propose(oversizeProposal(prepared, args, note));
      return "Not started yet: it is outside the size limits, so the admin's approval is needed, and they have been asked. Stop here; you hear what they decided next.";
    }
    return commitGrab(state, prepared, 'AI agent');
  },
};

/**
 * Starts a grab an admin approved, rechecking everything against the
 * current state; files are taken only if it all still holds and they are
 * the ones shown. Only an approved replacement may replace a file.
 */
export const startApprovedGrab = async (
  state: AgentState,
  change: Pick<ProposedChange, 'kind' | 'params'>,
  by: string
): Promise<string> => {
  const args = grabInput.parse(change.params.grab);
  const prepared = await prepareGrab(state, {
    ...args,
    replace: change.kind === 'replace',
  });
  const changed = changedSince(
    prepared,
    change.params.shown as ShownGrab | undefined
  );
  if (changed) {
    throw new ToolError(`${changed}; nothing was started.`);
  }
  return commitGrab(state, prepared, by);
};

export const stopDownload: AgentTool = {
  name: 'stop_download',
  description:
    'Stops a Backfill download this conversation started, when the admin says it is wrong or you find it is: the download and its partial files are removed. Files already imported stay; say so if any were.',
  parameters: {
    type: 'object',
    properties: {
      job: { type: 'integer', description: 'The Backfill job number.' },
      reason: { type: 'string' },
    },
    required: ['job', 'reason'],
  },
  async run(state, input) {
    const { job: id, reason } = z
      .object({
        job: z.coerce.number().int().min(1),
        reason: z.string().trim().min(3).max(600),
      })
      .parse(input);
    // Only a download it started: one it only added files to is someone
    // else's, and stopping it would remove their files too.
    const grabs = state.run.actions.filter(
      (a) => a.type === 'grab' && a.jobId === id
    );
    if (!grabs.some((a) => !a.extended)) {
      throw new ToolError(
        `Job #${id} was not started in this conversation${
          grabs.length ? ' (it only added files to it)' : ''
        }, so it is not yours to stop. The admin can end it on its Backfill page.`
      );
    }
    const job = await getRepository(BackfillJob).findOne({ where: { id } });
    if (!job) throw new ToolError(`There is no job #${id}.`);
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      return `Job #${id} is already ${job.status}; ${job.imported} files were imported.`;
    }
    // Nor one another conversation has since added its own files to.
    // Grabs recorded without their episodes can't be told apart.
    if (grabs.every((a) => a.episodeIds)) {
      const own = new Set(grabs.flatMap((a) => a.episodeIds ?? []));
      if (job.files.some((f) => f.episodeIds.some((e) => !own.has(e)))) {
        throw new ToolError(
          `Job #${id} now also downloads files another conversation added, so it is not yours alone to stop. The admin can end it on its Backfill page.`
        );
      }
    }
    if (job.status === 'importing') {
      throw new ToolError(
        `Job #${id} is importing right now; wait a minute and look at it again.`
      );
    }
    await backfill.end(id, state.user);
    state.act({
      at: new Date().toISOString(),
      type: 'stop',
      title: job.title,
      detail: `Stopped download #${id}: ${reason}`,
      jobId: id,
    });
    return `Stopped job #${id}; ${job.imported} of its files had been imported.`;
  },
};
