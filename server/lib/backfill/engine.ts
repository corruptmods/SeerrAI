import type { TorrentClient, TorrentState } from '@server/api/downloadclients';
import {
  CLIENT_PRODUCTS,
  TORRENT_CLIENT_TYPES,
  downloadClientFor,
  isTorrentClient,
  torrentClientFor,
  usenetClientFor,
} from '@server/api/downloadclients';
import type { FetchedRelease, ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI, {
  MOVIE_CATEGORIES,
  TV_CATEGORIES,
} from '@server/api/prowlarr';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import type {
  BackfillJobFile,
  BackfillLogLine,
} from '@server/entity/BackfillJob';
import BackfillJob from '@server/entity/BackfillJob';
import type { BackfillKind } from '@server/entity/BackfillSeries';
import BackfillSeries from '@server/entity/BackfillSeries';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { magnetHash, parseTorrent } from '@server/lib/backfill/bencode';
import type { PackFile, SeriesContext } from '@server/lib/backfill/matcher';
import {
  judgePack,
  mainReason,
  mapLimit,
  mentionsShow,
  packScore,
} from '@server/lib/backfill/matcher';
import type { MovieContext } from '@server/lib/backfill/movies';
import { judgeMoviePack } from '@server/lib/backfill/movies';
import { baseName, isExtra, isVideo } from '@server/lib/backfill/naming';
import backfillNotices from '@server/lib/backfill/notices';
import { packingOf, readNzb } from '@server/lib/backfill/nzb';
import type { PlanEntry, PlanSummary } from '@server/lib/backfill/plan';
import {
  multiMustWait,
  rankCandidates,
  selectEntries,
} from '@server/lib/backfill/plan';
import type { RadarrMovieDetail } from '@server/lib/backfill/radarr';
import BackfillRadarr from '@server/lib/backfill/radarr';
import type { OpinionRequest } from '@server/lib/backfill/secondOpinion';
import { aiSecondOpinion } from '@server/lib/backfill/secondOpinion';
import type { SonarrCommand, SonarrEpisode } from '@server/lib/backfill/sonarr';
import BackfillSonarr, { commandFinished } from '@server/lib/backfill/sonarr';
import { blockedGroupOf, blockedGroups } from '@server/lib/blockedGroups';
import type {
  BackfillDownload,
  DownloadStage,
} from '@server/lib/downloadtracker';
import downloadTracker from '@server/lib/downloadtracker';
import { owner } from '@server/lib/owner';
import type {
  DownloadClientSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAxiosError } from 'axios';
import { In, IsNull, MoreThan, Not } from 'typeorm';

/*
 * Backfill's engine.
 *
 * Scan: find series with monitored, aired episodes Sonarr has searched for
 * and not found, and movies Radarr has searched for and not found, with
 * nothing on its way in the queue.
 * Search: search Prowlarr directly under every name the title goes by, open
 * the most pack-like results, and judge every file inside with Sonarr or
 * Radarr.
 * Approve (an admin, or the auto-approve rule): add the pack to the download
 * client with only the needed files picked.
 * Monitor (every minute): follow the download; once it is in, hand the files
 * to Sonarr's or Radarr's manual import, check what landed, then remove the
 * download.
 */

const LABEL = 'Backfill';

const STAGE: Record<string, DownloadStage> = {
  queued: 'queued',
  downloading: 'downloading',
  paused: 'paused',
  importing: 'importing',
};

const clock = (seconds: number) =>
  [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(Math.floor(n)).padStart(2, '0'))
    .join(':');

/**
 * A job as the download tracker shows downloads: what it has still to
 * bring, or (imported) what it has brought.
 */
const downloadsOf = (
  job: BackfillJob,
  imported: boolean,
  now: number
): BackfillDownload[] => {
  const row = job.series;
  if (!row) return [];
  const stage = STAGE[job.status] ?? 'queued';
  const base = {
    status: job.status,
    stage,
    timeLeft: job.secondsLeft ? clock(job.secondsLeft) : '',
    ...(job.secondsLeft && stage === 'downloading'
      ? { estimatedCompletionTime: new Date(now + job.secondsLeft * 1000) }
      : {}),
    title: `Backfill: ${job.title}`,
    downloadId: job.downloadId ?? `backfill-${job.id}`,
  };
  if (row.kind === 'movie') {
    if (imported && !(job.status === 'done' && job.imported > 0)) return [];
    return [
      {
        kind: 'movie',
        serverId: row.serverId,
        jobId: job.id,
        item: {
          ...base,
          mediaType: MediaType.MOVIE,
          externalId: row.arrId,
          size: job.size,
          sizeLeft: job.sizeLeft,
        },
      },
    ];
  }
  // Each episode its own item, its share of what is left.
  const left = job.size ? job.sizeLeft / job.size : 1;
  return job.files
    .filter(
      (file) =>
        (file.state === 'imported') === imported &&
        file.episodeIds.length &&
        file.season !== undefined &&
        file.episode !== undefined
    )
    .map((file) => ({
      kind: 'series' as const,
      serverId: row.serverId,
      jobId: job.id,
      item: {
        ...base,
        mediaType: MediaType.TV,
        externalId: row.arrId,
        size: file.size,
        sizeLeft: Math.round(file.size * left),
        episode: {
          seasonNumber: file.season!,
          episodeNumber: file.episode!,
          absoluteEpisodeNumber: file.absolute ?? 0,
          id: file.episodeIds[0],
        },
      },
    }));
};

/** A running job as the download tracker shows downloads. */
export const backfillDownloadsOf = (
  job: BackfillJob,
  now = Date.now()
): BackfillDownload[] => downloadsOf(job, false, now);

/** What a job has imported: each episode, or the movie once it is done. */
export const backfillImportsOf = (
  job: BackfillJob,
  now = Date.now()
): BackfillDownload[] => downloadsOf(job, true, now);

/** How long after a job finishes its imports are still told of. */
const RECENTLY_DONE_MS = 10 * 60_000;

const MAX_TERMS = 5;
/** Seasons with missing episodes searched for by number, most missing first. */
const MAX_SEASON_TERMS = 3;
/** Packs opened per search: opening one fetches it and parses every file. */
const MAX_INSPECT = 10;
/** Packs per search the AI second opinion is asked about. */
const MAX_AI_PACKS = 3;
/** Packs opened at the same time during a search. */
const OPEN_AT_ONCE = 3;
/** How long a magnet link gets to produce its file list. */
const METADATA_WAIT_MS = 60_000;
/**
 * What a Usenet download is doing, in words: the client's own status names
 * ("Running", "Extracting") mean little on their own, and after the
 * download its post-processing can take a while.
 */
export const usenetStage = (
  job: { place: string; status: string },
  product: string
): string => {
  const status = job.status.toLowerCase();
  const words: Record<string, string> =
    job.place === 'queue'
      ? {
          downloading: 'Downloading',
          queued: `Waiting its turn in ${product}`,
          paused: `Paused in ${product}`,
          grabbing: `${product} is fetching the NZB`,
          fetching: `${product} is fetching the NZB`,
          propagating: 'Waiting for the post to reach your Usenet server',
          checking: `${product} is checking the post`,
        }
      : {
          queued: `Downloaded; waiting for ${product} to unpack it`,
          verifying: `${product} is checking the download`,
          quickcheck: `${product} is checking the download`,
          repairing: `${product} is repairing the download`,
          fetching: `${product} is fetching repair blocks`,
          renaming: `${product} is renaming its files`,
          extracting: `${product} is unpacking it`,
          moving: `${product} is moving it to its folder`,
          running: `${product} is running its post-processing script`,
          completed: 'Downloaded',
          failed: `${product} could not finish it`,
        };
  return words[status] ?? job.status;
};

/**
 * What a torrent is doing, in words, and whether the client is holding it
 * back (paused, queued behind its own download limit, or checking): time
 * held back is not time without progress.
 */
export const torrentStage = (
  torrent: { state: TorrentState; speed: number },
  product: string
): { stage: string; held: boolean } => {
  switch (torrent.state) {
    case 'paused':
      return { stage: `Paused in ${product}`, held: true };
    case 'queued':
      return { stage: `Queued in ${product}`, held: true };
    case 'checking':
      return { stage: `${product} is checking it`, held: true };
    case 'moving':
      return { stage: `${product} is moving it`, held: true };
    default:
      return {
        stage: torrent.speed > 0 ? 'Downloading' : 'Waiting for peers',
        held: false,
      };
  }
};

/** The torrent stages above, which a live reading may update. */
const TORRENT_STAGES = new Set([
  'Downloading',
  'Waiting for peers',
  ...TORRENT_CLIENT_TYPES.flatMap((type) => {
    const product = CLIENT_PRODUCTS[type];
    return [
      `Paused in ${product}`,
      `Queued in ${product}`,
      `${product} is checking it`,
      `${product} is moving it`,
    ];
  }),
]);

/** The least time between two readings a Usenet job's speed is taken from. */
const PACE_MIN_MS = 5_000;
/** How often the torrent client is checked for magnet probes left behind. */
const PROBE_SWEEP_EVERY_MS = 10 * 60_000;
/** A probe this old is no one's: they are read within a minute. */
const PROBE_LEFT_AFTER_MS = 10 * 60_000;
const METADATA_GIVE_UP_MS = 30 * 60_000;
const IMPORT_GIVE_UP_MS = 3 * 60 * 60_000;
const MAX_LOG_LINES = 300;
const IMPORT_BATCH = 50;
const ACTIVE: BackfillJob['status'][] = ['queued', 'downloading', 'importing'];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const titleWithoutYear = (title: string) =>
  title.replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim();

export const posterOf = (
  images?: { coverType: string; remoteUrl?: string }[]
): string | null =>
  images?.find((i) => i.coverType === 'poster')?.remoteUrl ?? null;

const aired = (ep: { airDateUtc?: string }) =>
  !!ep.airDateUtc && new Date(ep.airDateUtc).getTime() < Date.now();

export const isMissing = (ep: SonarrEpisode, includeSpecials: boolean) =>
  ep.monitored &&
  !ep.hasFile &&
  aired(ep) &&
  (includeSpecials || ep.seasonNumber > 0);

export interface BackfillReadiness {
  ready: boolean;
  enabled: boolean;
  prowlarr: boolean;
  torrentClient?: string;
  usenetClient?: string;
  problem?: string;
}

/** What Sonarr and Radarr both answer, for downloads and imports. */
type Arr = BackfillSonarr | BackfillRadarr;

/** One title, ready to search for: its names and how to judge a pack. */
interface Target {
  title: string;
  poster: string | null;
  names: string[];
  missing: number;
  categories: number[];
  /**
   * Searches beyond the names: a season's own ("Expedition Unknown S17"),
   * since a name alone brings back the most popular releases, which are
   * often old season packs.
   */
  extraTerms: string[];
  /** How many of the missing items a release's title names. */
  wants(title: string): number;
  /** Whether the app reads a release's title as another title, or this one. */
  readTitle(title: string): Promise<{ other: boolean; sees: boolean }>;
  judge(
    files: PackFile[],
    packTitle: string,
    secondOpinion?: SeriesContext['secondOpinion']
  ): Promise<{ plan: PlanEntry[]; summary: PlanSummary }>;
}

const appOf = (kind: BackfillKind) => (kind === 'movie' ? 'Radarr' : 'Sonarr');

/** What a download was for, as a notice names it: "S17E02, S17E03". */
const jobWhat = (row: BackfillSeries, job: BackfillJob): string => {
  if (row.kind === 'movie') return 'the movie';
  const labels = [
    ...new Set(
      job.files
        .filter((f) => f.season !== undefined && f.episode !== undefined)
        .map(
          (f) =>
            `S${String(f.season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`
        )
    ),
  ];
  if (!labels.length) return job.title;
  return labels.length > 4
    ? `${labels.slice(0, 4).join(', ')} and ${labels.length - 4} more`
    : labels.join(', ');
};

/** Below this, a video in a release grabbed whole is a sample. */
const WHOLE_MIN_BYTES = 20 * 1024 * 1024;

/**
 * A Usenet post in archives, or with scrambled file names: its files
 * cannot be listed before it is downloaded.
 */
export class PackedRelease extends Error {
  constructor(public readonly packing: 'archives' | 'scrambled') {
    super(
      packing === 'archives'
        ? 'Packed in archives, so its files cannot be checked'
        : 'Its file names are scrambled (only its repair files are named), so its files cannot be checked'
    );
  }
}

export interface SearchOptions {
  /** False keeps auto-approve out of it, for searches people asked for. */
  autoApprove?: boolean;
  /**
   * Lets the AI place files named only by their title. Only for a search
   * an admin starts for one title: searches Backfill runs by itself never
   * spend tokens.
   */
  ai?: boolean;
  /**
   * The episodes (or movie) of a download that failed: a good pack for any
   * of them is taken on its own, auto-approve on or not.
   */
  replacing?: number[];
  /** The download being replaced, to say what became of it. */
  failedJob?: { id: number; what: string; reason: string };
}

/**
 * Failed downloads of one title in a day after which Backfill stops
 * replacing them on its own: past this, something other than the releases
 * is likely wrong, and an admin should look.
 */
export const MAX_FAILED_PER_DAY = 6;

/** Where a download stands, as its page shows it. */
export interface Progress {
  progress: number;
  size: number;
  sizeLeft: number;
  speed: number;
  secondsLeft: number | null;
  /** What it is doing, read live: downloading, or waiting for peers. */
  stage?: string;
}

/** A torrent's progress over the chosen files only, not the whole pack. */
const measureTorrent = (
  job: BackfillJob,
  torrent: { speed: number; secondsLeft?: number },
  files: { index: number; size: number; progress: number }[]
): Progress & { have: number; complete: boolean } => {
  const wanted = new Set(job.files.map((f) => f.index));
  const chosen = files.filter((f) => wanted.has(f.index));
  const size = chosen.reduce((n, f) => n + f.size, 0);
  const have = chosen.reduce((n, f) => n + f.size * f.progress, 0);
  const sizeLeft = Math.max(0, Math.round(size - have));
  const speed = torrent.speed ?? 0;
  return {
    have,
    complete: chosen.length > 0 && chosen.every((f) => f.progress >= 1),
    size,
    sizeLeft,
    progress: size ? Math.floor((have / size) * 100) : 0,
    speed,
    // The client's own estimate, else what is left at today's speed.
    secondsLeft:
      torrent.secondsLeft ??
      (speed > 0 && sizeLeft > 0 ? Math.round(sizeLeft / speed) : null),
  };
};

const measureNzb = (nzbJob: {
  size: number;
  sizeLeft: number;
  percentage: number;
  secondsLeft?: number;
  speed?: number;
}): Progress => ({
  size: nzbJob.size,
  sizeLeft: nzbJob.sizeLeft,
  progress: Math.floor(nzbJob.percentage),
  speed: nzbJob.speed ?? 0,
  secondsLeft: nzbJob.secondsLeft ?? null,
});

/** A date from a raw query: SQLite gives UTC text with no zone on it. */
const utcDate = (value: string | Date) =>
  value instanceof Date
    ? value
    : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);

/** Whether a date Sonarr or Radarr gave is set and earlier than `when`. */
const before = (date: string | undefined, when: number) =>
  !!date && new Date(date).getTime() < when;

/**
 * How long a title whose last search failed (Prowlarr down, say) waits
 * before it is tried again, so it never holds a place in every scan.
 */
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * When each title someone asked for was first asked for: the oldest request
 * approved and still open, by TMDB id. Titles nobody asked for are absent.
 */
export const requestedSince = async (
  rows: BackfillSeries[]
): Promise<Map<number, Date>> => {
  const since = new Map<number, Date>();
  const byKind = (kind: BackfillKind) =>
    rows
      .filter((row) => row.kind === kind && row.tmdbId)
      .map((row) => row.tmdbId!);
  for (const kind of ['series', 'movie'] as const) {
    const tmdbIds = byKind(kind);
    if (!tmdbIds.length) continue;
    const requests = await getRepository(MediaRequest)
      .createQueryBuilder('request')
      .innerJoin('request.media', 'media')
      .select('media.tmdbId', 'tmdbId')
      .addSelect('MIN(request.createdAt)', 'first')
      .where('request.status = :status', {
        status: MediaRequestStatus.APPROVED,
      })
      .andWhere('request.is4k = :is4k', { is4k: false })
      .andWhere('media.mediaType = :type', {
        type: kind === 'movie' ? MediaType.MOVIE : MediaType.TV,
      })
      .andWhere('media.tmdbId IN (:...tmdbIds)', { tmdbIds })
      .groupBy('media.tmdbId')
      .getRawMany<{ tmdbId: number | string; first: string | Date }>();
    const firstById = new Map(
      requests.map((r) => [Number(r.tmdbId), utcDate(r.first)])
    );
    for (const row of rows) {
      const first =
        row.kind === kind && row.tmdbId ? firstById.get(row.tmdbId) : undefined;
      if (first) since.set(row.id, first);
    }
  }
  return since;
};

/**
 * Which titles this scan searches, at most `searchesPerScan`. A title is
 * due when Backfill has never searched for it; when its last search failed
 * a day ago or more; or when nothing was found and `researchAfterDays` have
 * passed. Every search, found or not, restarts that wait, so the same few
 * titles never take every scan: each in turn goes to the back.
 *
 * Of those due, titles never searched come first, then ones searched
 * before. Within each, a title someone asked for goes ahead of one nobody
 * did (the oldest request first); then, of titles never searched, the one
 * missing most, and of the rest, the one that has waited longest.
 */
export const pickSearches = (
  due: BackfillSeries[],
  requested: Map<number, Date>,
  settings: { searchesPerScan: number; researchAfterDays: number },
  now = Date.now()
): BackfillSeries[] => {
  const waitFor = (row: BackfillSeries) =>
    row.status === 'stuck'
      ? RETRY_FAILED_AFTER_MS
      : settings.researchAfterDays * 86_400_000;
  const eligible = due.filter(
    (row) =>
      !row.lastSearchedAt || now - row.lastSearchedAt.getTime() >= waitFor(row)
  );
  const asked = (row: BackfillSeries) =>
    requested.get(row.id)?.getTime() ?? Infinity;
  return eligible
    .sort(
      (a, b) =>
        Number(!!a.lastSearchedAt) - Number(!!b.lastSearchedAt) ||
        asked(a) - asked(b) ||
        (a.lastSearchedAt?.getTime() ?? 0) -
          (b.lastSearchedAt?.getTime() ?? 0) ||
        b.missing - a.missing ||
        a.id - b.id
    )
    .slice(0, settings.searchesPerScan);
};

/** Between one title and the next when searching everything stuck. */
const SEARCH_ALL_PAUSE_MS = 30_000;
/** Searches failing for want of Prowlarr in a row before giving up. */
const SEARCH_ALL_FAILURES_TO_STOP = 3;

interface SearchAllProgress {
  total: number;
  done: number;
  /** Titles a pack was found for. */
  found: number;
  /** The title being searched, or what is being done before the first. */
  current?: string;
  startedAt: Date;
}

interface SearchAllRun extends SearchAllProgress {
  stopping: boolean;
}

interface SearchAllEnd {
  total: number;
  done: number;
  found: number;
  startedAt: Date;
  finishedAt: Date;
  stoppedBecause?: string;
}

/** The least time between ticks run early for a finished download. */
const KICK_EVERY_MS = 30_000;

class Backfill {
  private scanning = false;
  private cancelled = false;
  private ticking = false;
  private searching = new Set<number>();
  private failures = new Map<number, number>();
  private starting = new Set<number>();
  /** Magnet links being read for their file lists, by hash. */
  private probing = new Set<string>();
  // The first look waits a while after start, like the ones after it.
  private sweptAt = Date.now();
  /** Settles when the tick under way, if any, is over. */
  private ticked: Promise<void> = Promise.resolve();
  /**
   * The bytes each torrent had when it last gained any, and when. Kept in
   * memory: a restart gives a stalled torrent a fresh allowance.
   */
  private lastGain = new Map<number, { have: number; at: number }>();
  /** When a page last had a tick run early. */
  private kickedAt = 0;
  /**
   * What each Usenet download had left, and when, to work out its own
   * speed when the client's (one figure for its whole queue) is not its own.
   */
  private nzbPace = new Map<
    number,
    { left: number; at: number; speed: number }
  >();
  /** Live readings under way, so pages asking at once share one. */
  private readings = new Map<number, Promise<Progress | null>>();

  /**
   * A downloading job's progress as the client has it right now, rather
   * than as of the last minute's tick. Null when it cannot be read; the
   * page then shows what was saved.
   */
  public liveProgress(job: BackfillJob): Promise<Progress | null> {
    if (job.status !== 'downloading' || !job.downloadId) {
      return Promise.resolve(null);
    }
    const asking = this.readings.get(job.id);
    if (asking) return asking;
    const reading = this.readProgress(job)
      .catch(() => null)
      .finally(() => this.readings.delete(job.id));
    this.readings.set(job.id, reading);
    return reading;
  }

  /** Jobs as the page shows them, with live readings over the saved ones. */
  public async withLiveProgress<T extends BackfillJob>(
    jobs: T[]
  ): Promise<T[]> {
    const readings = await Promise.all(jobs.map((j) => this.liveProgress(j)));
    return jobs.map((job, i) =>
      readings[i] ? Object.assign(job, readings[i]) : job
    );
  }

  private async readProgress(job: BackfillJob): Promise<Progress | null> {
    const client = this.clientById(job.clientId);
    if (job.protocol === 'torrent') {
      const torrents = torrentClientFor(client);
      const [torrent, files] = await Promise.all([
        torrents.findTorrent(job.downloadId!),
        torrents.getFiles(job.downloadId!),
      ]);
      if (!torrent || !files.length) return null;
      const measured = measureTorrent(job, torrent, files);
      // Finished: imported now rather than at the next minute's tick.
      if (measured.complete) this.tickSoon();
      const moving = TORRENT_STAGES.has(job.stage ?? '');
      return {
        progress: measured.progress,
        size: measured.size || job.size,
        sizeLeft: measured.sizeLeft,
        speed: measured.speed,
        secondsLeft: measured.secondsLeft,
        stage:
          moving && !measured.complete
            ? torrentStage(torrent, torrents.product).stage
            : (job.stage ?? undefined),
      };
    }
    const usenet = usenetClientFor(client);
    const nzbJob = await usenet.getJob(job.downloadId!);
    if (nzbJob?.place === 'history') this.tickSoon();
    if (nzbJob?.place === 'queue') {
      return {
        ...this.paced(job.id, measureNzb(nzbJob), nzbJob.speed),
        size: nzbJob.size || job.size,
        stage: usenetStage(nzbJob, usenet.product),
      };
    }
    // Downloaded, and the client still unpacking or running its script.
    if (nzbJob && !/^(completed|failed)$/i.test(nzbJob.status)) {
      return {
        ...measureNzb(nzbJob),
        size: nzbJob.size || job.size,
        stage: usenetStage(nzbJob, usenet.product),
      };
    }
    return null;
  }

  /**
   * A Usenet download's speed: the client's own when it is this job's, and
   * otherwise what it gained since the last reading, at least a few
   * seconds back. Until there is one to compare with, the last known.
   */
  private paced(
    jobId: number,
    reading: Progress,
    reported: number | undefined,
    now = Date.now()
  ): Progress {
    const before = this.nzbPace.get(jobId);
    let speed = reported;
    if (speed === undefined) {
      if (before && now - before.at >= PACE_MIN_MS) {
        speed =
          Math.max(0, before.left - reading.sizeLeft) /
          ((now - before.at) / 1000);
      } else {
        speed = before?.speed ?? 0;
      }
    }
    if (!before || now - before.at >= PACE_MIN_MS || reported !== undefined) {
      this.nzbPace.set(jobId, { left: reading.sizeLeft, at: now, speed });
    }
    return {
      ...reading,
      speed: Math.round(speed),
      secondsLeft:
        reported === undefined
          ? speed > 0
            ? Math.round(reading.sizeLeft / speed)
            : null
          : reading.secondsLeft,
    };
  }

  /**
   * A tick now, for a download a page saw finish, unless one is under way
   * or one was asked for lately: a failing import must not be retried at
   * the pace pages poll, each try counting towards giving up.
   */
  private tickSoon(): void {
    if (this.ticking || Date.now() - this.kickedAt < KICK_EVERY_MS) return;
    this.kickedAt = Date.now();
    this.tick().catch(() => undefined);
  }

  /** Settles once the tick under way, if any, is over. */
  public tickDone(): Promise<void> {
    return this.ticked;
  }

  public status() {
    return { running: this.scanning };
  }

  /* ------------------------ searching everything ------------------------ */

  /** The search of everything stuck under way, if one is. */
  private searchAllRun: SearchAllRun | null = null;
  /** How the last one ended, until another starts. */
  private searchAllLast: SearchAllEnd | null = null;

  public searchAllStatus(): {
    running: SearchAllProgress | null;
    last: SearchAllEnd | null;
  } {
    const run = this.searchAllRun;
    return {
      running: run
        ? {
            total: run.total,
            done: run.done,
            found: run.found,
            current: run.current,
            startedAt: run.startedAt,
          }
        : null,
      last: this.searchAllLast,
    };
  }

  /**
   * Searches every stuck title, one at a time with a pause between, rather
   * than a few each scan: titles someone asked for first, then the rest.
   * What Sonarr or Radarr searched for lately counts too. A title Backfill
   * searched within the last day is left out. Auto-approve applies as it
   * does to the scan. Kept in memory: a restart ends it.
   */
  public startSearchAll(
    user?: User,
    { pauseMs = SEARCH_ALL_PAUSE_MS }: { pauseMs?: number } = {}
  ): Promise<void> {
    const readiness = this.readiness();
    if (!readiness.ready) {
      throw new Error(readiness.problem);
    }
    if (this.searchAllRun) {
      throw new Error('Everything stuck is already being searched.');
    }
    if (this.scanning) {
      throw new Error('A scan is running; try again once it has finished.');
    }
    const run: SearchAllRun = {
      total: 0,
      done: 0,
      found: 0,
      current: 'Reading what Sonarr and Radarr are missing',
      startedAt: new Date(),
      stopping: false,
    };
    this.searchAllRun = run;
    this.searchAllLast = null;
    return this.runSearchAll(run, user, pauseMs);
  }

  /** Stops after the title being searched now. */
  public stopSearchAll(): boolean {
    if (!this.searchAllRun) return false;
    this.searchAllRun.stopping = true;
    return true;
  }

  private async runSearchAll(
    run: SearchAllRun,
    user: User | undefined,
    pauseMs: number
  ): Promise<void> {
    let stoppedBecause: string | undefined;
    try {
      await this.scan({ everything: true, searches: false });
      const settings = getSettings().backfill;
      const repo = getRepository(BackfillSeries);
      const kinds: BackfillKind[] = settings.includeMovies
        ? ['series', 'movie']
        : ['series'];
      const due = await repo.find({
        where: [
          { status: 'stuck', kind: In(kinds) },
          { status: 'none', kind: In(kinds) },
        ],
      });
      const queue = pickSearches(due, await requestedSince(due), {
        searchesPerScan: Number.POSITIVE_INFINITY,
        researchAfterDays: 1,
      });
      run.total = queue.length;
      let failedInARow = 0;
      for (const [i, row] of queue.entries()) {
        if (run.stopping) {
          stoppedBecause = 'Stopped.';
          break;
        }
        run.current = row.title;
        await this.search(row.id, user);
        run.done += 1;
        const after = await repo.findOne({ where: { id: row.id } });
        if (after && ['found', 'downloading'].includes(after.status)) {
          run.found += 1;
        }
        // Prowlarr not answering fails every search alike: stop rather
        // than run through the rest for nothing.
        failedInARow = after?.searchError?.startsWith('Prowlarr')
          ? failedInARow + 1
          : 0;
        if (failedInARow >= SEARCH_ALL_FAILURES_TO_STOP) {
          stoppedBecause = `Stopped: ${after?.searchError}`;
          break;
        }
        if (i < queue.length - 1) {
          await this.waitFor(pauseMs, () => run.stopping);
        }
      }
    } catch (e) {
      stoppedBecause = `Stopped: ${message(e)}`;
      logger.error('Searching everything stuck failed', {
        label: LABEL,
        errorMessage: message(e),
      });
    } finally {
      this.searchAllRun = null;
      this.searchAllLast = {
        total: run.total,
        done: run.done,
        found: run.found,
        startedAt: run.startedAt,
        finishedAt: new Date(),
        ...(stoppedBecause ? { stoppedBecause } : {}),
      };
    }
  }

  /** Waits, ending early once `stop` says so. */
  private async waitFor(ms: number, stop: () => boolean): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until && !stop()) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000, until - Date.now()))
      );
    }
  }

  public monitorStatus() {
    return { running: this.ticking };
  }

  public cancel() {
    this.cancelled = true;
  }

  /**
   * Told of each title a search found nothing usable for, so something else
   * (the admin agent) can look further. Set once at startup.
   */
  public onNothingFound: ((row: BackfillSeries) => void) | null = null;

  private nothingFound(row: BackfillSeries) {
    try {
      this.onNothingFound?.(row);
    } catch (e) {
      logger.warn('Could not hand a title on after an empty search', {
        label: LABEL,
        seriesId: row.id,
        errorMessage: message(e),
      });
    }
  }

  public isSearching(id: number) {
    return this.searching.has(id);
  }

  /* ----------------------------- settings ----------------------------- */

  public readiness(): BackfillReadiness {
    const settings = getSettings();
    const backfill = settings.backfill;
    const clients = settings.downloadClients;
    const torrent = clients.find(
      (c) => c.id === backfill.torrentClientId && isTorrentClient(c.type)
    );
    const usenet = clients.find(
      (c) => c.id === backfill.usenetClientId && !isTorrentClient(c.type)
    );
    const prowlarr = !!(backfill.prowlarr.hostname && backfill.prowlarr.apiKey);
    const problem = !backfill.enabled
      ? 'Backfill is turned off in Settings → Backfill.'
      : !prowlarr
        ? 'Prowlarr is not set up in Settings → Backfill.'
        : !torrent && !usenet
          ? 'No download client is chosen in Settings → Backfill.'
          : !settings.sonarr.length &&
              !(backfill.includeMovies && settings.radarr.length)
            ? 'No Sonarr or Radarr server is set up.'
            : undefined;
    return {
      ready: !problem,
      enabled: backfill.enabled,
      prowlarr,
      torrentClient: torrent?.name,
      usenetClient: usenet?.name,
      problem,
    };
  }

  private prowlarr() {
    return new ProwlarrAPI(getSettings().backfill.prowlarr);
  }

  private clientFor(
    protocol: 'torrent' | 'usenet'
  ): DownloadClientSettings | undefined {
    const settings = getSettings();
    const id =
      protocol === 'torrent'
        ? settings.backfill.torrentClientId
        : settings.backfill.usenetClientId;
    return settings.downloadClients.find(
      (c) => c.id === id && isTorrentClient(c.type) === (protocol === 'torrent')
    );
  }

  private clientById(id: number): DownloadClientSettings {
    const client = getSettings().downloadClients.find((c) => c.id === id);
    if (!client) {
      throw new Error('The download client was removed from Seerr.');
    }
    return client;
  }

  private sonarrServer(serverId: number): SonarrSettings {
    const server = getSettings().sonarr.find((s) => s.id === serverId);
    if (!server) throw new Error('That Sonarr server is no longer set up.');
    return server;
  }

  public sonarrFor(serverId: number): BackfillSonarr {
    return BackfillSonarr.forServer(this.sonarrServer(serverId));
  }

  public radarrFor(serverId: number): BackfillRadarr {
    const server = getSettings().radarr.find((s) => s.id === serverId);
    if (!server) throw new Error('That Radarr server is no longer set up.');
    return BackfillRadarr.forServer(server);
  }

  public arrFor(row: BackfillSeries): Arr {
    return row.kind === 'movie'
      ? this.radarrFor(row.serverId)
      : this.sonarrFor(row.serverId);
  }

  /** One per instance: two entries for one host (a 4K one) are one app. */
  private distinct<T extends SonarrSettings | RadarrSettings>(
    servers: T[]
  ): T[] {
    const seen = new Set<string>();
    return servers.filter((s) => {
      const key = `${s.hostname}:${s.port}${s.baseUrl ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /* ------------------------------- scan ------------------------------- */

  /**
   * Reads what Sonarr and Radarr are missing, follows what is stuck, and
   * searches the titles due. `everything` follows whatever is missing now,
   * however lately Sonarr or Radarr searched; `searches` false only reads.
   */
  public async scan({
    everything = false,
    searches = true,
  }: { everything?: boolean; searches?: boolean } = {}): Promise<void> {
    if (this.scanning || !this.readiness().ready) {
      return;
    }
    this.scanning = true;
    this.cancelled = false;
    try {
      const settings = getSettings().backfill;
      const repo = getRepository(BackfillSeries);
      const stuckBefore = everything
        ? Date.now()
        : Date.now() - settings.stuckAfterHours * 3_600_000;
      for (const server of this.distinct(getSettings().sonarr)) {
        if (this.cancelled) return;
        const sonarr = BackfillSonarr.forServer(server);
        const wanted = await sonarr.getWanted('missing');
        const cutoff = settings.includeCutoffUnmet
          ? await sonarr.getWanted('cutoff')
          : [];
        const bySeries = new Map<
          number,
          {
            missing: number;
            stuck: number;
            lastSearch?: string;
            belowCutoff: number;
            series: NonNullable<(typeof wanted)[number]['series']>;
          }
        >();
        const note = (
          record: (typeof wanted)[number],
          kind: 'missing' | 'cutoff'
        ) => {
          if (!record.series || record.series.monitored === false) return;
          if (!settings.includeSpecials && record.seasonNumber === 0) return;
          if (kind === 'missing' && !aired(record)) return;
          const entry = bySeries.get(record.seriesId) ?? {
            missing: 0,
            stuck: 0,
            belowCutoff: 0,
            series: record.series,
          };
          if (kind === 'missing') {
            entry.missing++;
            const searched = record.lastSearchTime
              ? new Date(record.lastSearchTime).getTime()
              : 0;
            // Searched a while ago and still missing; or never searched at
            // all (added without a search), aired and in Sonarr a while.
            if (
              searched
                ? searched < stuckBefore
                : before(record.airDateUtc, stuckBefore) &&
                  before(record.series.added, stuckBefore)
            ) {
              entry.stuck++;
            }
            if (
              record.lastSearchTime &&
              (!entry.lastSearch || record.lastSearchTime > entry.lastSearch)
            ) {
              entry.lastSearch = record.lastSearchTime;
            }
          } else {
            entry.belowCutoff++;
          }
          bySeries.set(record.seriesId, entry);
        };
        wanted.forEach((r) => note(r, 'missing'));
        cutoff.forEach((r) => note(r, 'cutoff'));

        const known = await repo.find({
          where: { kind: 'series', serverId: server.id },
        });
        const byId = new Map(known.map((row) => [row.arrId, row]));
        for (const [seriesId, entry] of bySeries) {
          if (this.cancelled) return;
          const row = byId.get(seriesId);
          const gap = entry.stuck > 0 || entry.belowCutoff > 0;
          if (!row && !gap) continue;
          // Something already on its way in means Sonarr is still working.
          if (!row && (await sonarr.getSeriesQueueCount(seriesId)) > 0) {
            continue;
          }
          const next =
            row ??
            new BackfillSeries({
              kind: 'series',
              serverId: server.id,
              arrId: seriesId,
              status: 'stuck',
              searchTerms: [],
            });
          next.title = entry.series.title;
          next.year = entry.series.year ?? null;
          next.tvdbId = entry.series.tvdbId ?? null;
          next.tmdbId = entry.series.tmdbId ?? null;
          next.seriesType = entry.series.seriesType ?? 'standard';
          next.poster = posterOf(entry.series.images) ?? next.poster ?? null;
          next.missing = entry.missing;
          next.belowCutoff = entry.belowCutoff;
          next.lastArrSearchAt = entry.lastSearch
            ? new Date(entry.lastSearch)
            : null;
          if (next.status === 'done') next.status = 'stuck';
          await repo.save(next);
        }
        // Anything no longer missing is done.
        for (const row of known) {
          if (
            !bySeries.has(row.arrId) &&
            ['stuck', 'none', 'found'].includes(row.status)
          ) {
            await repo.update(row.id, {
              status: 'done',
              missing: 0,
              belowCutoff: 0,
            });
          }
        }
      }
      if (settings.includeMovies) {
        for (const server of this.distinct(getSettings().radarr)) {
          if (this.cancelled) return;
          // One Radarr down must not stop the series being searched.
          await this.scanMovies(server, stuckBefore).catch((e) =>
            logger.error('Backfill could not read Radarr', {
              label: LABEL,
              server: server.name,
              errorMessage: message(e),
            })
          );
        }
      }
      await this.dropStaleOffers();
      // A search of everything stuck does the searching while it runs.
      if (!searches || this.searchAllRun) return;

      const kinds: BackfillKind[] = settings.includeMovies
        ? ['series', 'movie']
        : ['series'];
      const due = await repo.find({
        where: [
          { status: 'stuck', kind: In(kinds) },
          { status: 'none', kind: In(kinds) },
        ],
      });
      const toSearch = pickSearches(due, await requestedSince(due), settings);
      for (const row of toSearch) {
        if (this.cancelled) return;
        await this.search(row.id);
      }
    } catch (e) {
      logger.error('Backfill scan failed', {
        label: LABEL,
        errorMessage: message(e),
      });
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Packs found for titles no longer missing anything: judged against the
   * files as they were, and offering nothing now.
   */
  private async dropStaleOffers(): Promise<void> {
    const done = await getRepository(BackfillSeries).find({
      where: { status: 'done' },
      select: { id: true },
    });
    if (!done.length) return;
    await getRepository(BackfillCandidate).delete({
      seriesId: In(done.map((row) => row.id)),
      status: 'ready',
    });
  }

  /**
   * Movies Radarr has searched for and not found since `stuckBefore`, or
   * whose file is below the cutoff, with nothing in Radarr's queue.
   */
  private async scanMovies(server: RadarrSettings, stuckBefore: number) {
    const settings = getSettings().backfill;
    const repo = getRepository(BackfillSeries);
    const radarr = BackfillRadarr.forServer(server);
    const missing = (await radarr.getWanted('missing')).filter(
      (movie) => movie.isAvailable
    );
    const cutoff = settings.includeCutoffUnmet
      ? await radarr.getWanted('cutoff')
      : [];
    const wanted = new Map<
      number,
      { movie: RadarrMovieDetail; missing: boolean }
    >();
    for (const movie of cutoff) wanted.set(movie.id, { movie, missing: false });
    for (const movie of missing) wanted.set(movie.id, { movie, missing: true });

    const known = await repo.find({
      where: { kind: 'movie', serverId: server.id },
    });
    const byId = new Map(known.map((row) => [row.arrId, row]));
    for (const [movieId, entry] of wanted) {
      if (this.cancelled) return;
      const row = byId.get(movieId);
      const searched = entry.movie.lastSearchTime
        ? new Date(entry.movie.lastSearchTime).getTime()
        : 0;
      // Searched a while ago and still missing, or never searched at all
      // and in Radarr a while.
      const stuck =
        entry.missing &&
        (searched > 0
          ? searched < stuckBefore
          : before(entry.movie.added, stuckBefore));
      if (!row && !stuck && entry.missing) continue;
      if (!row && (await radarr.getMovieQueueCount(movieId)) > 0) continue;
      const next = row ?? this.movieRow(server.id, entry.movie);
      next.title = entry.movie.title;
      next.year = entry.movie.year ?? null;
      next.tmdbId = entry.movie.tmdbId ?? null;
      next.poster = posterOf(entry.movie.images) ?? next.poster ?? null;
      next.missing = entry.missing ? 1 : 0;
      next.belowCutoff = entry.missing ? 0 : 1;
      next.lastArrSearchAt = searched ? new Date(searched) : null;
      if (next.status === 'done') next.status = 'stuck';
      await repo.save(next);
    }
    for (const row of known) {
      if (
        !wanted.has(row.arrId) &&
        ['stuck', 'none', 'found'].includes(row.status)
      ) {
        await repo.update(row.id, {
          status: 'done',
          missing: 0,
          belowCutoff: 0,
        });
      }
    }
  }

  private movieRow(serverId: number, movie: RadarrMovieDetail) {
    return new BackfillSeries({
      kind: 'movie',
      serverId,
      arrId: movie.id,
      title: movie.title,
      year: movie.year ?? null,
      tvdbId: null,
      tmdbId: movie.tmdbId ?? null,
      seriesType: 'standard',
      poster: posterOf(movie.images),
      status: 'stuck',
      missing: movie.hasFile ? 0 : 1,
      searchTerms: [],
    });
  }

  /** Follows a series or movie by its app's id, as from a title page. */
  public async track(
    kind: BackfillKind,
    serverId: number,
    arrId: number
  ): Promise<BackfillSeries> {
    const repo = getRepository(BackfillSeries);
    const existing = await repo.findOne({ where: { kind, serverId, arrId } });
    if (existing) return existing;
    if (kind === 'movie') {
      const movie = await this.radarrFor(serverId).getMovieDetail(arrId);
      return repo.save(this.movieRow(serverId, movie));
    }
    const sonarr = this.sonarrFor(serverId);
    const series = await sonarr.getSeriesDetail(arrId);
    const episodes = await sonarr.getSeriesEpisodes(arrId);
    const settings = getSettings().backfill;
    return repo.save(
      new BackfillSeries({
        kind,
        serverId,
        arrId,
        title: series.title,
        year: series.year ?? null,
        tvdbId: series.tvdbId ?? null,
        tmdbId: series.tmdbId ?? null,
        seriesType: series.seriesType,
        poster: posterOf(series.images),
        status: 'stuck',
        missing: episodes.filter((ep) =>
          isMissing(ep, settings.includeSpecials)
        ).length,
        searchTerms: [],
      })
    );
  }

  /* ------------------------------ search ------------------------------ */

  public async context(row: BackfillSeries): Promise<SeriesContext> {
    const sonarr = this.sonarrFor(row.serverId);
    const series = await sonarr.getSeriesDetail(row.arrId);
    const [episodes, files, profile] = await Promise.all([
      sonarr.getSeriesEpisodes(series.id),
      sonarr.getEpisodeFiles(series.id),
      sonarr.getQualityProfile(series.qualityProfileId),
    ]);
    const names = [
      ...new Set(
        [
          titleWithoutYear(series.title),
          series.title,
          ...(series.alternateTitles ?? []).map((alt) => alt.title),
          ...(row.searchTerms ?? []),
        ]
          .map((n) => n.trim())
          .filter(Boolean)
      ),
    ];
    return { series, episodes, files, profile, names, sonarr };
  }

  public async movieContext(row: BackfillSeries): Promise<MovieContext> {
    const radarr = this.radarrFor(row.serverId);
    const movie = await radarr.getMovieDetail(row.arrId);
    const [file, profile] = await Promise.all([
      movie.hasFile ? radarr.getMovieFile(movie.id) : null,
      radarr.getQualityProfile(movie.qualityProfileId),
    ]);
    const names = [
      ...new Set(
        [
          movie.title,
          movie.originalTitle ?? '',
          ...(movie.alternateTitles ?? []).map((alt) => alt.title),
          ...(row.searchTerms ?? []),
        ]
          .map((n) => n.trim())
          .filter(Boolean)
      ),
    ];
    return { movie, file, profile, names, radarr };
  }

  /** What a search needs to know about a series or a movie. */
  private async target(row: BackfillSeries): Promise<Target> {
    if (row.kind === 'movie') {
      const ctx = await this.movieContext(row);
      return {
        title: ctx.movie.title,
        poster: posterOf(ctx.movie.images),
        names: ctx.names,
        missing: !ctx.movie.hasFile && ctx.movie.isAvailable ? 1 : 0,
        categories: MOVIE_CATEGORIES,
        extraTerms: [],
        wants: () => 0,
        readTitle: async (title) => {
          const parsed = await ctx.radarr.parse(title).catch(() => null);
          return {
            other: !!parsed?.movie && parsed.movie.id !== ctx.movie.id,
            sees: parsed?.movie?.id === ctx.movie.id,
          };
        },
        judge: (files, packTitle) => judgeMoviePack(files, packTitle, ctx),
      };
    }
    const ctx = await this.context(row);
    const includeSpecials = getSettings().backfill.includeSpecials;
    const missing = ctx.episodes.filter((ep) => isMissing(ep, includeSpecials));
    const pad = (n: number) => String(n).padStart(2, '0');
    const bySeason = new Map<number, number>();
    for (const ep of missing) {
      if (ep.seasonNumber > 0) {
        bySeason.set(ep.seasonNumber, (bySeason.get(ep.seasonNumber) ?? 0) + 1);
      }
    }
    // Anime packs go by absolute numbers, so a season search finds little.
    const seasons =
      ctx.series.seriesType === 'anime'
        ? []
        : [...bySeason.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_SEASON_TERMS)
            .map(([season]) => season);
    const wanted = missing.map(
      (ep) =>
        new RegExp(
          `\\bS${pad(ep.seasonNumber)}E${pad(ep.episodeNumber)}\\b`,
          'i'
        )
    );
    const wantedSeasons = [...bySeason.keys()].map(
      (season) => new RegExp(`\\bS${pad(season)}\\b(?!E)`, 'i')
    );
    return {
      title: ctx.series.title,
      poster: posterOf(ctx.series.images),
      names: ctx.names,
      missing: missing.length,
      categories: TV_CATEGORIES,
      extraTerms: seasons.map(
        (season) => `${titleWithoutYear(ctx.series.title)} S${pad(season)}`
      ),
      wants: (title) =>
        wanted.filter((rx) => rx.test(title)).length +
        wantedSeasons.filter((rx) => rx.test(title)).length,
      // A title Sonarr matches to another show it has (Shippuden, for
      // Naruto) is that show's.
      readTitle: async (title) => {
        const parsed = await ctx.sonarr.parse(title).catch(() => null);
        return {
          other: !!parsed?.series && parsed.series.id !== ctx.series.id,
          sees: parsed?.series?.id === ctx.series.id,
        };
      },
      judge: (files, packTitle, secondOpinion) =>
        judgePack(files, packTitle, { ...ctx, secondOpinion }),
    };
  }

  /** Starts a search and returns at once; the page follows its status. */
  public startSearch(id: number, user?: User, options?: SearchOptions): void {
    if (this.searching.has(id)) return;
    this.search(id, user, options).catch((e) =>
      logger.error('Backfill search failed', {
        label: LABEL,
        seriesId: id,
        errorMessage: message(e),
      })
    );
  }

  /**
   * Searches for packs for one series. The AI second opinion is asked as
   * `user`, or the owner for a scheduled search.
   */
  public async search(
    id: number,
    user?: User,
    options: SearchOptions = {}
  ): Promise<void> {
    if (this.searching.has(id)) return;
    this.searching.add(id);
    const repo = getRepository(BackfillSeries);
    const candidates = getRepository(BackfillCandidate);
    let previous: BackfillSeries['status'] = 'stuck';
    try {
      const row = await repo.findOneOrFail({ where: { id } });
      previous = row.status;
      await repo.update(id, { status: 'searching', searchError: null });
      const settings = getSettings().backfill;
      const target = await this.target(row);
      const ask =
        row.kind === 'series' && options.ai
          ? aiSecondOpinion(user ?? (await owner()))
          : null;
      const { missing } = target;

      // Search under each name, in the app's order, skipping a name another
      // already covers ("Perfect World" covers "Perfect World (2021)").
      const terms: string[] = [];
      for (const name of target.names) {
        const n = name.toLowerCase();
        if (!terms.some((t) => n.includes(t.toLowerCase()))) terms.push(name);
      }
      const prowlarr = this.prowlarr();
      const found = new Map<string, ProwlarrRelease>();
      const errors: string[] = [];
      const queries = [
        ...terms.slice(0, MAX_TERMS).map(titleWithoutYear),
        ...target.extraTerms,
      ];
      for (const term of queries) {
        try {
          for (const release of await prowlarr.search(term, {
            categories: target.categories,
          })) {
            const key =
              release.infoHash?.toLowerCase() ||
              `${release.title.toLowerCase()}|${Math.round(release.size / 1e6)}`;
            const held = found.get(key);
            if (!held || (release.seeders ?? 0) > (held.seeders ?? 0)) {
              found.set(key, release);
            }
          }
        } catch (e) {
          errors.push(`${term}: ${message(e)}`);
        }
      }
      if (!found.size && errors.length) {
        throw new Error(`Prowlarr: ${errors[0]}`);
      }

      const skipped = await candidates.find({
        where: { seriesId: id, status: In(['skipped', 'approved', 'dead']) },
      });
      const passedOver = new Set(
        skipped.flatMap((c) => [c.guid, c.infoHash ?? ''].filter(Boolean))
      );
      const blocked = blockedGroups();
      const usable = [...found.values()].filter(
        (release) =>
          !!this.clientFor(release.protocol) &&
          mentionsShow(release.title, target.names) &&
          // A release group an admin blocked is never taken.
          !blockedGroupOf(release.title, null, blocked) &&
          !passedOver.has(release.guid) &&
          !passedOver.has(release.infoHash?.toLowerCase() ?? '')
      );

      const titled = await Promise.all(
        usable.map(async (release) => ({
          release,
          ...(await target.readTitle(release.title)),
        }))
      );
      // What names a missing episode is opened first, then the likeliest
      // packs.
      const toOpen = titled
        .filter((t) => !t.other)
        .sort(
          (a, b) =>
            Number(target.wants(b.release.title) > 0) -
              Number(target.wants(a.release.title) > 0) ||
            packScore(b.release) - packScore(a.release) ||
            (b.release.seeders ?? 0) - (a.release.seeders ?? 0)
        )
        .slice(0, MAX_INSPECT);

      // Packs are opened a few at a time: a magnet's file list can take
      // a minute to come from the swarm. The second opinion is asked about
      // the first few only, so one search cannot run up a bill.
      const opened = await mapLimit(
        toOpen.map((entry, i) => ({ ...entry, i })),
        OPEN_AT_ONCE,
        async ({ release, sees, i }): Promise<BackfillCandidate | null> => {
          if (this.cancelled) return null;
          const candidate = new BackfillCandidate({
            seriesId: id,
            guid: release.guid,
            title: release.title,
            indexer: release.indexer,
            indexerId: release.indexerId,
            protocol: release.protocol,
            size: release.size,
            seeders: release.seeders ?? null,
            publishDate: release.publishDate ?? null,
            downloadUrl: release.downloadUrl ?? null,
            magnetUrl: release.magnetUrl ?? null,
            infoHash: release.infoHash?.toLowerCase() ?? null,
            plan: [],
            summary: null,
            notifiedAt: null,
          });
          try {
            const files = await this.packFiles(release, candidate);
            // The same torrent from another indexer, under another name:
            // what was turned down or died once is not offered again.
            if (candidate.infoHash && passedOver.has(candidate.infoHash)) {
              return null;
            }
            const secondOpinion =
              ask && i < MAX_AI_PACKS
                ? (req: OpinionRequest) => ask(req)
                : undefined;
            const { plan, summary } = await target.judge(
              files,
              release.title,
              secondOpinion
            );
            candidate.plan = plan;
            candidate.summary = { ...summary, sonarrSeesTitle: sees };
            const useful =
              summary.fill > 0 ||
              (summary.upgrade > 0 &&
                (settings.includeCutoffUnmet || !missing));
            candidate.status = useful ? 'ready' : 'rejected';
            candidate.reason = useful
              ? null
              : (mainReason(plan) ??
                (row.kind === 'movie'
                  ? 'The movie is not in it'
                  : plan.length
                    ? 'Nothing in it the series needs'
                    : 'No episodes in it'));
          } catch (e) {
            candidate.status = 'failed';
            candidate.reason = message(e).slice(0, 250);
          }
          return candidate;
        }
      );
      const results = opened.filter((c): c is BackfillCandidate => c !== null);

      // A new search replaces what the last one found, except what an
      // admin already acted on.
      await candidates.delete({
        seriesId: id,
        status: In(['ready', 'rejected', 'failed']),
      });
      await candidates.save(results);

      const ready = rankCandidates(
        results
          .filter((c) => c.status === 'ready' && c.summary)
          .map((c) => ({ ...c, summary: c.summary! }))
      );
      const busy = await getRepository(BackfillJob).count({
        where: { seriesId: id, status: In([...ACTIVE, 'paused']) },
      });
      await repo.update(id, {
        status: busy ? 'downloading' : ready.length ? 'found' : 'none',
        missing,
        title: target.title,
        poster: target.poster ?? row.poster,
        lastSearchedAt: new Date(),
        searchError: errors.length ? errors.join('; ').slice(0, 250) : null,
      });

      if (!ready.length && !busy) {
        this.nothingFound(row);
      }

      const best = ready[0];
      const replacing =
        options.replacing && settings.replaceFailed
          ? new Set(options.replacing)
          : null;
      // In place of a failed download, the best good pack for what it was
      // fetching, even beside other downloads for the title.
      const pick = replacing
        ? ready.find(
            (c) => this.takesItself(c, replacing) && !multiMustWait(c, ready)
          )
        : best &&
            !busy &&
            settings.autoApprove.enabled &&
            options.autoApprove !== false &&
            this.takesItself(best)
          ? best
          : undefined;
      let taken = false;
      if (pick) {
        try {
          await this.approve(pick.id, {
            mode: 'missing',
            by: replacing
              ? 'Backfill (replacing a failed download)'
              : undefined,
          });
          taken = true;
        } catch (e) {
          logger.warn('Backfill could not take the pack it found', {
            label: LABEL,
            seriesId: id,
            pack: pick.title,
            errorMessage: message(e),
          });
        }
      }
      if (options.failedJob) {
        backfillNotices.add({
          kind: taken ? 'replaced' : 'failed',
          seriesId: id,
          title: row.title,
          poster: target.poster ?? row.poster,
          what: options.failedJob.what,
          detail: options.failedJob.reason,
          url: `/backfill/jobs/${options.failedJob.id}`,
        });
      }
      if (best && !taken && !busy) {
        await this.notifyFound(
          row,
          results.find((c) => c.guid === best.guid)!,
          target.poster
        );
      }
    } catch (e) {
      await repo.update(id, {
        status: previous === 'searching' ? 'stuck' : previous,
        searchError: message(e).slice(0, 250),
        lastSearchedAt: new Date(),
      });
      throw e;
    } finally {
      this.searching.delete(id);
    }
  }

  /**
   * The files in a release found anywhere (Prowlarr, or Sonarr's or Radarr's
   * own search), as a search reads them, with the torrent's hash once known.
   */
  public async filesOf(release: ProwlarrRelease): Promise<{
    files: PackFile[];
    infoHash: string | null;
    packed?: 'archives' | 'scrambled';
  }> {
    const candidate = new BackfillCandidate({
      guid: release.guid,
      title: release.title,
      indexer: release.indexer,
      indexerId: release.indexerId,
      protocol: release.protocol,
      size: release.size,
      downloadUrl: release.downloadUrl ?? null,
      magnetUrl: release.magnetUrl ?? null,
      infoHash: release.infoHash?.toLowerCase() ?? null,
    });
    try {
      const files = await this.packFiles(release, candidate);
      return { files, infoHash: candidate.infoHash };
    } catch (e) {
      // A Usenet post in RAR parts, or with scrambled names: its files
      // are only known once the client has downloaded and unpacked it.
      if (e instanceof PackedRelease) {
        return { files: [], infoHash: null, packed: e.packing };
      }
      throw e;
    }
  }

  /** The files in a result, from its .torrent, its NZB, or the swarm. */
  private async packFiles(
    release: ProwlarrRelease,
    candidate: BackfillCandidate
  ): Promise<PackFile[]> {
    const fetched = await this.fetch(candidate);
    if (fetched.kind === 'torrent') {
      const meta = parseTorrent(fetched.data);
      candidate.infoHash = meta.infoHash;
      return meta.files;
    }
    if (fetched.kind === 'nzb') {
      const contents = readNzb(fetched.data);
      const packing = packingOf(contents);
      if (packing) throw new PackedRelease(packing);
      return contents.files.map((f) => ({
        index: f.index,
        path: f.name,
        size: f.size,
      }));
    }
    const hash = magnetHash(fetched.uri);
    if (!hash) throw new Error('The magnet link has no info hash');
    candidate.infoHash = hash;
    return this.probeMagnet(fetched.uri, hash, release.title);
  }

  private fetch(candidate: BackfillCandidate): Promise<FetchedRelease> {
    return this.prowlarr().fetchRelease({
      guid: candidate.guid,
      title: candidate.title,
      size: candidate.size,
      indexerId: candidate.indexerId,
      indexer: candidate.indexer,
      protocol: candidate.protocol,
      downloadUrl: candidate.downloadUrl ?? undefined,
      magnetUrl: candidate.magnetUrl ?? undefined,
      infoHash: candidate.infoHash ?? undefined,
    });
  }

  /**
   * A magnet link carries no file list. The torrent client fetches it from
   * the swarm (qBittorrent stops there by itself; the others are held to a
   * crawl, where they allow it, and removed within seconds of having it),
   * and the torrent is removed again once the list is read.
   */
  private async probeMagnet(
    uri: string,
    hash: string,
    title: string
  ): Promise<PackFile[]> {
    const client = this.clientFor('torrent');
    if (!client) throw new Error('No torrent client is chosen');
    const torrents = torrentClientFor(client);
    const category = getSettings().backfill.category;
    const already = await torrents.findTorrent(hash);
    this.probing.add(hash);
    if (!already) {
      await torrents.ensureCategory(category);
      await torrents.addTorrent({ magnet: uri, category, metadataOnly: true });
    }
    try {
      const files = await this.fileListOf(torrents, hash);
      if (files.length) {
        return files.map((f) => ({
          index: f.index,
          path: f.name,
          size: f.size,
        }));
      }
      throw new Error(
        `Only a magnet link, and the swarm did not send its file list within a minute (${title})`
      );
    } finally {
      this.probing.delete(hash);
      if (!already) await torrents.deleteTorrent(hash).catch(() => undefined);
    }
  }

  /** A magnet's file list, once the swarm sends it; empty after a minute. */
  private async fileListOf(torrents: TorrentClient, hash: string) {
    const until = Date.now() + METADATA_WAIT_MS;
    for (;;) {
      const files = await torrents.getFiles(hash);
      if (files.length || Date.now() >= until) return files;
      await sleep(3000);
    }
  }

  /**
   * Magnet probes left behind in the torrent client: one under way when Seerr
   * stopped is never removed by it. Only Backfill's own category, only
   * torrents that downloaded nothing, belong to no download and are not
   * being read now, and only once they are old enough to be no one's.
   */
  private async sweepProbes(now = Date.now()): Promise<number> {
    // A clock set back counts as due rather than waiting out the gap.
    if (now >= this.sweptAt && now - this.sweptAt < PROBE_SWEEP_EVERY_MS) {
      return 0;
    }
    this.sweptAt = now;
    const client = this.clientFor('torrent');
    if (!client) return 0;
    const api = torrentClientFor(client);
    const torrents = await api.listCategory(getSettings().backfill.category);
    const owned = new Set(
      (
        await getRepository(BackfillJob).find({
          select: { downloadId: true },
          where: { protocol: 'torrent', downloadId: Not(IsNull()) },
        })
      ).map((j) => j.downloadId!.toLowerCase())
    );
    let removed = 0;
    for (const t of torrents) {
      const hash = t.hash.toLowerCase();
      if (
        owned.has(hash) ||
        this.probing.has(hash) ||
        t.progress > 0 ||
        // When it was added unknown: never taken for a probe.
        t.addedAt === undefined ||
        now - t.addedAt < PROBE_LEFT_AFTER_MS
      ) {
        continue;
      }
      await api.deleteTorrent(hash).catch(() => undefined);
      removed += 1;
    }
    if (removed) {
      logger.info(`Removed ${removed} magnet probes left in ${client.name}`, {
        label: LABEL,
      });
    }
    return removed;
  }

  /* ----------------------------- approve ------------------------------ */

  /**
   * More files from a release a download under way is already fetching:
   * the same torrent cannot be added twice, so the job takes them on.
   * Only while it is waiting or downloading; once it imports, the release
   * can be taken again as a new download.
   */
  public async extendJob(
    jobId: number,
    entries: PlanEntry[],
    by: string
  ): Promise<BackfillJob> {
    // A tick saving the job meanwhile would drop the files added here.
    while (this.ticking) await this.ticked;
    this.ticking = true;
    let settle!: () => void;
    this.ticked = new Promise<void>((resolve) => (settle = resolve));
    try {
      const jobs = getRepository(BackfillJob);
      const job = await jobs.findOneOrFail({ where: { id: jobId } });
      if (job.status !== 'queued' && job.status !== 'downloading') {
        throw new Error(
          `Backfill #${job.id} is ${job.status} now; once it is done, this release can be taken again.`
        );
      }
      const have = new Set(job.files.map((f) => f.index));
      const added = entries.filter((e) => !have.has(e.index));
      if (!added.length) {
        throw new Error(`Backfill #${job.id} already has these files.`);
      }
      const bytes = added.reduce((n, e) => n + e.size, 0);
      job.files = [
        ...job.files,
        ...added.map((entry) => ({ ...entry, state: 'waiting' as const })),
      ];
      job.size += bytes;
      job.sizeLeft += bytes;
      this.note(
        job,
        'ok',
        `${by} added ${added.length} file${added.length === 1 ? '' : 's'}${
          added.some((e) => e.matchedBy === 'ai')
            ? `, ${added.filter((e) => e.matchedBy === 'ai').length} matched by AI`
            : ''
        }`
      );
      await jobs.save(job);
      // A torrent whose files are chosen already: fetch these too. One
      // still choosing picks them up from the job's files.
      if (
        job.status === 'downloading' &&
        job.protocol === 'torrent' &&
        job.downloadId &&
        job.stage !== 'Choosing files' &&
        job.stage !== "Waiting for the torrent's file list"
      ) {
        const torrents = torrentClientFor(this.clientById(job.clientId));
        await torrents.setFilePriority(
          job.downloadId,
          added.map((e) => e.index),
          1
        );
        await torrents.startTorrent(job.downloadId);
      }
      return job;
    } finally {
      this.ticking = false;
      settle();
      await this.publishDownloads();
    }
  }

  public async approve(
    candidateId: number,
    options: {
      mode: 'missing' | 'all';
      user?: User;
      includeAi?: boolean;
      /** Who approved it, when not a person: "AI agent". */
      by?: string;
    }
  ): Promise<BackfillJob> {
    const candidates = getRepository(BackfillCandidate);
    const candidate = await candidates.findOneOrFail({
      where: { id: candidateId },
    });
    if (candidate.status !== 'ready') {
      throw new Error('This pack is not waiting for approval.');
    }
    const client = this.clientFor(candidate.protocol);
    if (!client) {
      throw new Error(
        `No ${candidate.protocol === 'torrent' ? 'torrent' : 'Usenet'} client is chosen in Settings → Backfill.`
      );
    }
    const includeAi = options.includeAi ?? true;
    let selected = selectEntries(candidate.plan, options.mode, includeAi);
    if (!selected.length) {
      throw new Error('Nothing in this pack would be imported.');
    }
    // The plan is as old as the search: what it fills may have arrived since,
    // and importing over it would replace a file nobody agreed to replace.
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: candidate.seriesId },
    });
    const { files: now } = await this.onDisk(row);
    if (
      selected.some(
        (e) =>
          e.action === 'fill' &&
          e.replaces === 0 &&
          e.episodeIds.length > 0 &&
          e.episodeIds.every((id) => now.get(id))
      )
    ) {
      throw new Error(
        `${appOf(row.kind)} has a file for this now. Search again for an up-to-date plan.`
      );
    }
    // Several downloads may run for one series, for different episodes; a
    // movie has only the one.
    const jobs = getRepository(BackfillJob);
    let leftOut = '';
    const running = await jobs.find({
      where: {
        seriesId: candidate.seriesId,
        status: In([...ACTIVE, 'paused']),
      },
    });
    if (running.length && row.kind === 'movie') {
      throw new Error('This title already has a backfill running.');
    }
    const taken = new Map<number, BackfillJob>();
    for (const other of running) {
      for (const file of other.files) {
        for (const id of file.episodeIds) taken.set(id, other);
      }
    }
    // What another download is already fetching is left out of this one.
    const clashing = selected.filter((e) =>
      e.episodeIds.some((id) => taken.has(id))
    );
    if (clashing.length) {
      const others = [
        ...new Set(
          clashing.flatMap((e) =>
            e.episodeIds
              .filter((id) => taken.has(id))
              .map((id) => taken.get(id)!.id)
          )
        ),
      ]
        .map((id) => `#${id}`)
        .join(', ');
      selected = selected.filter((e) => !clashing.includes(e));
      if (!selected.length) {
        throw new Error(
          `Everything in this pack is already downloading in Backfill ${others}.`
        );
      }
      leftOut = `; left out ${clashing.length} already downloading in ${others}`;
    }
    const who = options.user
      ? options.user.displayName
      : (options.by ?? 'Auto-approve');
    const job = await jobs.save(
      new BackfillJob({
        seriesId: candidate.seriesId,
        candidateId: candidate.id,
        title: candidate.title,
        status: 'queued',
        stage: null,
        mode: options.mode,
        protocol: candidate.protocol,
        clientId: client.id,
        downloadId: null,
        files: selected.map((entry) => ({ ...entry, state: 'waiting' })),
        size: selected.reduce((n, e) => n + e.size, 0),
        sizeLeft: selected.reduce((n, e) => n + e.size, 0),
        commandIds: [],
        log: [
          {
            at: new Date().toISOString(),
            kind: 'ok',
            message: `${who} approved ${selected.length} files (${
              options.mode === 'all' ? 'missing and upgrades' : 'missing only'
            }${
              selected.some((e) => e.matchedBy === 'ai')
                ? `, ${selected.filter((e) => e.matchedBy === 'ai').length} matched by AI`
                : ''
            }${leftOut})`,
          },
        ],
        approvedById: options.user?.id ?? null,
        approvedByName: who,
      })
    );
    await candidates.update(candidate.id, { status: 'approved' });
    await getRepository(BackfillSeries).update(candidate.seriesId, {
      status: 'downloading',
    });
    try {
      await this.start(job);
    } catch (e) {
      this.note(job, 'warn', `Not started yet: ${message(e)}`);
      await jobs.save(job);
    }
    await this.publishDownloads();
    return job;
  }

  public async skip(candidateId: number): Promise<void> {
    const candidates = getRepository(BackfillCandidate);
    const candidate = await candidates.findOneOrFail({
      where: { id: candidateId },
    });
    await candidates.update(candidate.id, { status: 'skipped' });
    const left = await candidates.count({
      where: { seriesId: candidate.seriesId, status: 'ready' },
    });
    if (!left) {
      const series = getRepository(BackfillSeries);
      const row = await series.findOneOrFail({
        where: { id: candidate.seriesId },
      });
      if (row.status === 'found') {
        await series.update(row.id, { status: 'none' });
      }
    }
  }

  /* ------------------------------- jobs ------------------------------- */

  /** Where the title's files go, for the free-space check. */
  private async pathOf(row: BackfillSeries): Promise<string> {
    return row.kind === 'movie'
      ? (await this.radarrFor(row.serverId).getMovieDetail(row.arrId)).path
      : (await this.sonarrFor(row.serverId).getSeriesDetail(row.arrId)).path;
  }

  /**
   * The file each episode (or the movie) has now, 0 for none, and how many
   * are still missing.
   */
  private async onDisk(
    row: BackfillSeries
  ): Promise<{ files: Map<number, number>; missing: number }> {
    if (row.kind === 'movie') {
      const movie = await this.radarrFor(row.serverId).getMovieDetail(
        row.arrId
      );
      const fileId = movie.hasFile ? movie.movieFileId : 0;
      return {
        files: new Map([[movie.id, fileId]]),
        missing: !fileId && movie.isAvailable ? 1 : 0,
      };
    }
    const includeSpecials = getSettings().backfill.includeSpecials;
    const episodes = await this.sonarrFor(row.serverId).getSeriesEpisodes(
      row.arrId
    );
    return {
      files: new Map(
        episodes.map((ep) => [ep.id, ep.hasFile ? ep.episodeFileId : 0])
      ),
      missing: episodes.filter((ep) => isMissing(ep, includeSpecials)).length,
    };
  }

  private note(job: BackfillJob, kind: BackfillLogLine['kind'], text: string) {
    job.log = [
      ...(job.log ?? []),
      { at: new Date().toISOString(), kind, message: text },
    ].slice(-MAX_LOG_LINES);
  }

  /** Adds an approved job's download, if there is room for it. */
  private async start(job: BackfillJob): Promise<void> {
    // Approving starts a job while a tick may be starting it too.
    if (this.starting.has(job.id)) return;
    this.starting.add(job.id);
    try {
      await this.startJob(job);
    } finally {
      this.starting.delete(job.id);
    }
  }

  private async startJob(job: BackfillJob): Promise<void> {
    const jobs = getRepository(BackfillJob);
    const current = await jobs.findOne({ where: { id: job.id } });
    if (current?.status !== 'queued') return;
    const settings = getSettings().backfill;
    // The limit is per client: torrents and Usenet do not share bandwidth,
    // and an import is Sonarr's or Radarr's work, not a download.
    const running = await jobs.count({
      where: {
        id: Not(job.id),
        status: 'downloading',
        protocol: job.protocol,
      },
    });
    if (running >= settings.maxActiveJobs) {
      job.stage = `Waiting for one of ${settings.maxActiveJobs} running ${
        job.protocol === 'torrent' ? 'torrent' : 'Usenet'
      } downloads to finish`;
      await jobs.save(job);
      return;
    }
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: job.seriesId },
    });
    const arr = this.arrFor(row);
    const path = await this.pathOf(row);
    const roots = await arr.getRootFoldersNow();
    const root = roots
      .filter((r) => path.startsWith(r.path.replace(/\/+$/, '')))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const need = settings.minFreeSpaceGb * 1024 ** 3 + job.size;
    if (root && root.freeSpace < need) {
      job.stage = `Waiting for disk space: ${Math.floor(
        root.freeSpace / 1024 ** 3
      )} GB free on ${root.path}`;
      await jobs.save(job);
      return;
    }

    const candidate = await getRepository(BackfillCandidate).findOneOrFail({
      where: { id: job.candidateId ?? -1 },
    });
    const client = this.clientById(job.clientId);
    const fetched = await this.fetch(candidate);
    let torrents: TorrentClient | undefined;
    if (job.protocol === 'torrent') {
      torrents = torrentClientFor(client);
      await torrents.ensureCategory(settings.category);
      if (fetched.kind === 'nzb') {
        throw new Error('Expected a torrent, got an NZB.');
      }
      const hash =
        fetched.kind === 'torrent'
          ? parseTorrent(fetched.data).infoHash
          : magnetHash(fetched.uri);
      if (!hash) throw new Error('The torrent has no info hash.');
      // A torrent already there is someone else's: removing it at the end
      // would take their files.
      if (await torrents.findTorrent(hash)) {
        throw new Error(`The torrent is already in ${client.name}.`);
      }
      await torrents.addTorrent(
        fetched.kind === 'torrent'
          ? { torrent: fetched.data, category: settings.category }
          : // A magnet must reach the swarm to get its file list, then stops.
            {
              magnet: fetched.uri,
              category: settings.category,
              metadataOnly: true,
            }
      );
      job.downloadId = hash;
      job.stage = 'Choosing files';
      this.note(job, 'info', `Added to ${client.name}`);
    } else {
      if (fetched.kind !== 'nzb') throw new Error('Expected an NZB.');
      const usenet = usenetClientFor(client);
      job.downloadId = await usenet.addNzb(
        fetched.data,
        candidate.title,
        settings.category
      );
      job.stage = `Queued in ${usenet.product}`;
      this.note(job, 'info', `Added to ${client.name}`);
    }
    job.status = 'downloading';
    job.startedAt = new Date();
    await jobs.save(job);
    if (torrents) {
      // A client that does not stop a magnet once it has its file list is
      // watched for it now, so its files are chosen within seconds.
      if (fetched.kind === 'magnet' && !torrents.stopsAtMetadata) {
        await this.fileListOf(torrents, job.downloadId!);
      }
      await this.pickFiles(job);
    }
  }

  /** Skips every file but the chosen ones, then starts the torrent. */
  private async pickFiles(job: BackfillJob): Promise<boolean> {
    const torrents = torrentClientFor(this.clientById(job.clientId));
    const files = await torrents.getFiles(job.downloadId!);
    if (!files.length) {
      job.stage = "Waiting for the torrent's file list";
      await getRepository(BackfillJob).save(job);
      return false;
    }
    const wanted = new Set(job.files.map((f) => f.index));
    const mismatch = job.files.find((f) => {
      const there = files.find((x) => x.index === f.index);
      return !there || baseName(there.name) !== baseName(f.path);
    });
    if (mismatch) {
      throw new Error(
        `The torrent's files are not the ones checked (${baseName(mismatch.path)}).`
      );
    }
    await torrents.setFilePriority(
      job.downloadId!,
      files.filter((f) => !wanted.has(f.index)).map((f) => f.index),
      0
    );
    await torrents.setFilePriority(job.downloadId!, [...wanted], 1);
    await torrents.startTorrent(job.downloadId!);
    job.stage = 'Downloading';
    this.note(
      job,
      'info',
      `Downloading ${wanted.size} of ${files.length} files; the rest are skipped`
    );
    await getRepository(BackfillJob).save(job);
    return true;
  }

  /** Every minute: moves each running job along. */
  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    let settle!: () => void;
    this.ticked = new Promise<void>((resolve) => (settle = resolve));
    try {
      const jobs = getRepository(BackfillJob);
      const open = await jobs.find({ where: { status: In(ACTIVE) } });
      for (const job of open) {
        try {
          await this.advance(job);
          this.failures.delete(job.id);
        } catch (e) {
          const count = (this.failures.get(job.id) ?? 0) + 1;
          this.failures.set(job.id, count);
          this.note(job, 'warn', message(e));
          if (count >= 10) {
            await this.fail(job, message(e));
          } else {
            await jobs.save(job);
          }
        }
      }
      await this.sweepProbes().catch((e) =>
        logger.warn(
          'Could not check the torrent client for magnet probes left behind',
          {
            label: LABEL,
            errorMessage: message(e),
          }
        )
      );
    } finally {
      await this.publishDownloads();
      this.ticking = false;
      settle();
    }
  }

  /**
   * Tells the download tracker what Backfill is downloading, and what it
   * has just imported, so title pages and cards show it like any download
   * Radarr or Sonarr runs: each episode of a series as its own item.
   */
  public async publishDownloads(): Promise<void> {
    try {
      const jobs = await getRepository(BackfillJob).find({
        where: [
          { status: In([...ACTIVE, 'paused']) },
          {
            status: 'done',
            finishedAt: MoreThan(new Date(Date.now() - RECENTLY_DONE_MS)),
          },
        ],
        relations: { series: true },
      });
      // What was downloading and is now imported shows as being added to
      // the library until the media server lists it.
      downloadTracker.setBackfillDownloads(
        jobs
          .filter((job) => job.status !== 'done')
          .flatMap((job) => backfillDownloadsOf(job)),
        jobs.flatMap((job) => backfillImportsOf(job))
      );
    } catch (e) {
      logger.debug('Could not tell the download tracker about Backfill', {
        label: LABEL,
        errorMessage: message(e),
      });
    }
  }

  private async advance(job: BackfillJob): Promise<void> {
    if (job.status === 'queued') {
      await this.start(job);
      return;
    }
    if (job.status === 'downloading') {
      const done =
        job.protocol === 'torrent'
          ? await this.followTorrent(job)
          : await this.followNzb(job);
      if (done) {
        const row = await getRepository(BackfillSeries).findOneOrFail({
          where: { id: job.seriesId },
        });
        job.stage = `Handing the files to ${appOf(row.kind)}`;
        await getRepository(BackfillJob).save(job);
        await this.importFiles(job, typeof done === 'string' ? done : '');
      }
      return;
    }
    if (job.status === 'importing') {
      await this.followImport(job);
    }
  }

  private async followTorrent(job: BackfillJob): Promise<boolean> {
    const torrents = torrentClientFor(this.clientById(job.clientId));
    const torrent = await torrents.findTorrent(job.downloadId!);
    if (!torrent) {
      throw new Error(`The torrent is no longer in ${torrents.product}.`);
    }
    if (
      job.stage === "Waiting for the torrent's file list" ||
      job.stage === 'Choosing files'
    ) {
      if (!(await this.pickFiles(job))) {
        if (
          job.startedAt &&
          Date.now() - job.startedAt.getTime() > METADATA_GIVE_UP_MS
        ) {
          await this.fail(job, 'The swarm never sent the file list.');
        }
        return false;
      }
    }
    if (torrent.state === 'error') {
      throw new Error(
        `${torrents.product} reports a problem with the torrent: ${torrent.error ?? 'an error'}.`
      );
    }
    const { have, complete, ...measured } = measureTorrent(
      job,
      torrent,
      await torrents.getFiles(job.downloadId!)
    );
    Object.assign(job, measured, { size: measured.size || job.size });
    if (complete && torrent.state === 'moving') {
      // Moved from an "incomplete" folder once done: imported after.
      job.stage = `${torrent.name} is being moved to its folder`;
      await getRepository(BackfillJob).save(job);
      return false;
    }
    if (complete) {
      await torrents.stopTorrent(job.downloadId!).catch(() => undefined);
      job.progress = 100;
      job.sizeLeft = 0;
      this.lastGain.delete(job.id);
    } else {
      const { stage, held } = torrentStage(torrent, torrents.product);
      job.stage = stage;
      const seen = this.lastGain.get(job.id);
      // Paused, queued or being checked in the client is not stalling:
      // the clock only runs while it is meant to be downloading.
      if (!seen || have > seen.have || held) {
        this.lastGain.set(job.id, { have, at: Date.now() });
      } else {
        const hours = getSettings().backfill.stallHours;
        if (hours > 0 && Date.now() - seen.at > hours * 60 * 60_000) {
          this.lastGain.delete(job.id);
          await this.fail(
            job,
            `Nothing downloaded for ${hours} hour${hours === 1 ? '' : 's'}: nobody seems to be sharing it.`
          );
          return false;
        }
      }
    }
    await getRepository(BackfillJob).save(job);
    return complete;
  }

  /** The Usenet client's folder for the finished job, once it is finished. */
  private async followNzb(job: BackfillJob): Promise<string | false> {
    const usenet = usenetClientFor(this.clientById(job.clientId));
    const nzbJob = await usenet.getJob(job.downloadId!);
    if (!nzbJob) throw new Error(`The job is no longer in ${usenet.product}.`);
    Object.assign(job, this.paced(job.id, measureNzb(nzbJob), nzbJob.speed), {
      size: nzbJob.size || job.size,
    });
    job.stage = usenetStage(nzbJob, usenet.product);
    if (nzbJob.place === 'history') this.nzbPace.delete(job.id);
    if (nzbJob.place === 'history') {
      if (/^failed$/i.test(nzbJob.status)) {
        await this.fail(
          job,
          `${usenet.product} could not finish it: ${nzbJob.failMessage ?? 'failed'}`
        );
        return false;
      }
      if (/^completed$/i.test(nzbJob.status)) {
        if (!nzbJob.storage) {
          throw new Error(
            `${usenet.product} did not say where it put the files.`
          );
        }
        await getRepository(BackfillJob).save(job);
        return nzbJob.storage;
      }
    }
    await getRepository(BackfillJob).save(job);
    return false;
  }

  /** Where the client's path is, as Sonarr or Radarr sees it. */
  private async arrPath(
    arr: Arr,
    client: DownloadClientSettings,
    path: string
  ): Promise<string> {
    const windows = /^[a-z]:\\|^\\\\/i.test(path);
    const norm = (p: string) =>
      windows ? p.replace(/\//g, '\\').toLowerCase() : p;
    const mapping = (await arr.getRemotePathMappings())
      .filter(
        (m) =>
          m.host.toLowerCase() === client.hostname.toLowerCase() &&
          norm(path).startsWith(norm(m.remotePath))
      )
      .sort((a, b) => b.remotePath.length - a.remotePath.length)[0];
    return mapping
      ? mapping.localPath + path.slice(mapping.remotePath.length)
      : path;
  }

  private async importFiles(job: BackfillJob, folder: string): Promise<void> {
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: job.seriesId },
    });
    const arr = this.arrFor(row);
    const app = appOf(row.kind);
    const client = this.clientById(job.clientId);
    const { files: fileOf } = await this.onDisk(row);

    const paths = new Map<number, string>();
    if (job.protocol === 'torrent') {
      const torrents = torrentClientFor(client);
      const torrent = await torrents.findTorrent(job.downloadId!);
      const files = await torrents.getFiles(job.downloadId!);
      const save = (torrent?.savePath ?? '').replace(/[\\/]+$/, '');
      const sep = save.includes('\\') ? '\\' : '/';
      for (const file of job.files) {
        const there = files.find((f) => f.index === file.index);
        if (there) {
          const inside = there.name.replace(/[\\/]/g, sep);
          paths.set(
            file.index,
            await this.arrPath(arr, client, `${save}${sep}${inside}`)
          );
        }
      }
    } else {
      const seen = await arr.getFolderFiles(
        await this.arrPath(arr, client, folder)
      );
      for (const file of job.files) {
        if (file.whole) {
          // Grabbed whole (packed in archives, or with scrambled names):
          // its one video, whatever it was named. With several, which is
          // the episode cannot be told.
          const videos = seen.filter(
            (s) =>
              isVideo(s.path) && !isExtra(s.path) && s.size >= WHOLE_MIN_BYTES
          );
          if (videos.length === 1) paths.set(file.index, videos[0].path);
          else if (videos.length > 1) {
            file.note = `${videos.length} videos in it; which is the one cannot be told`;
          }
          continue;
        }
        const want = baseName(file.path).toLowerCase();
        const match = seen.find((s) => baseName(s.path).toLowerCase() === want);
        if (match) paths.set(file.index, match.path);
      }
    }

    const ready: BackfillJobFile[] = [];
    for (const file of job.files) {
      const path = paths.get(file.index);
      if (!path) {
        file.state = 'failed';
        file.note ??= 'Not found in the finished download';
        continue;
      }
      file.before = file.episodeIds.map((id) => fileOf.get(id) ?? 0);
      file.state = 'importing';
      ready.push({ ...file, path });
    }
    const commandIds: number[] = [];
    for (let i = 0; i < ready.length; i += IMPORT_BATCH) {
      const batch = ready.slice(i, i + IMPORT_BATCH);
      commandIds.push(
        arr instanceof BackfillRadarr
          ? await arr.manualImport(
              batch.map((file) => ({
                path: file.path,
                movieId: row.arrId,
                quality: file.quality!,
                languages: file.languages ?? [],
                releaseGroup: file.releaseGroup,
              }))
            )
          : await arr.manualImport(
              batch.map((file) => ({
                path: file.path,
                seriesId: row.arrId,
                episodeIds: file.episodeIds,
                quality: file.quality!,
                languages: file.languages ?? [],
                releaseGroup: file.releaseGroup,
              }))
            )
      );
    }
    job.status = 'importing';
    job.commandIds = commandIds;
    job.stage = `${app} is importing ${ready.length} file${ready.length === 1 ? '' : 's'}`;
    this.note(job, 'ok', 'Download complete');
    this.note(
      job,
      'info',
      `Sent ${ready.length} files to ${app}'s manual import`
    );
    await getRepository(BackfillJob).save(job);
    if (!ready.length) {
      await this.finish(job, row);
    }
  }

  private async followImport(job: BackfillJob): Promise<void> {
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: job.seriesId },
    });
    const arr = this.arrFor(row);
    // A command the app no longer knows (restarted, or cleared) is over.
    const commands = await Promise.all(
      job.commandIds.map((id) =>
        arr.getCommand(id).catch((e) => {
          if (isAxiosError(e) && e.response?.status === 404) {
            const gone: SonarrCommand = {
              id,
              name: 'ManualImport',
              status: 'completed',
            };
            return gone;
          }
          throw e;
        })
      )
    );
    const waiting = commands.filter((c) => !commandFinished(c.status));
    const started = job.updatedAt?.getTime() ?? Date.now();
    if (waiting.length && Date.now() - started < IMPORT_GIVE_UP_MS) {
      return;
    }
    for (const failed of commands.filter((c) => c.status === 'failed')) {
      this.note(
        job,
        'warn',
        `${appOf(row.kind)}'s import reported: ${failed.message ?? 'failed'}`
      );
    }
    await this.finish(job, row);
  }

  /** Checks what landed in Sonarr or Radarr, cleans up, and reports. */
  private async finish(job: BackfillJob, row: BackfillSeries): Promise<void> {
    const { files: fileOf, missing } = await this.onDisk(row);
    let imported = 0;
    let replaced = 0;
    let rejected = 0;
    for (const file of job.files) {
      if (file.state !== 'importing') {
        if (file.state === 'failed') rejected++;
        continue;
      }
      const landed = file.episodeIds.every((id, i) => {
        const now = fileOf.get(id);
        return !!now && now !== file.before?.[i];
      });
      if (landed) {
        file.state = 'imported';
        imported++;
        replaced += (file.before ?? []).filter(Boolean).length ? 1 : 0;
      } else {
        file.state = 'failed';
        file.note = `${appOf(row.kind)} did not import it`;
        rejected++;
      }
    }
    job.imported = imported;
    job.replaced = replaced;
    job.rejected = rejected;
    job.commandIds = [];

    if (imported && !rejected) {
      try {
        await this.removeDownload(job);
        this.note(job, 'info', 'Removed the download and what was left of it');
      } catch (e) {
        this.note(job, 'warn', `Could not remove the download: ${message(e)}`);
      }
    } else if (rejected) {
      // What was not taken is left for an admin to import by hand.
      this.note(
        job,
        'warn',
        `Kept the download: ${rejected} file${rejected === 1 ? '' : 's'} did not import`
      );
    }

    job.status = imported ? 'done' : 'failed';
    job.error = imported ? null : 'Nothing was imported.';
    job.stage = null;
    job.finishedAt = new Date();
    this.note(
      job,
      imported ? 'ok' : 'error',
      `Imported ${imported} of ${job.files.length} files${
        replaced ? `, replacing ${replaced}` : ''
      }`
    );
    await getRepository(BackfillJob).save(job);
    // The other packs found were judged against the files as they were:
    // once some landed, what they would fill or replace has changed.
    const candidates = getRepository(BackfillCandidate);
    const others = await candidates.count({
      where: { seriesId: row.id, status: 'ready' },
    });
    const stale = others > 0 && (imported > 0 || !missing);
    if (stale) {
      await candidates.delete({ seriesId: row.id, status: 'ready' });
    }
    const alsoRunning = await this.othersRunning(row.id, job.id);
    await getRepository(BackfillSeries).update(row.id, {
      status: alsoRunning
        ? 'downloading'
        : !missing
          ? 'done'
          : others && !stale
            ? 'found'
            : 'none',
      missing,
      lastSearchedAt: new Date(),
    });
    backfillNotices.add({
      kind: 'finished',
      seriesId: row.id,
      title: row.title,
      poster: row.poster,
      what: jobWhat(row, job),
      detail:
        imported < job.files.length
          ? `imported ${imported} of ${job.files.length} files`
          : undefined,
      url: `/backfill/jobs/${job.id}`,
    });
    // Still missing some: the packs are judged again against what is there.
    if (stale && missing) this.startSearch(row.id);
  }

  /**
   * Whether Backfill may take a pack without an admin: it fills something
   * missing, replaces nothing on disk, nothing in it was placed by the AI
   * alone, and it meets auto-approve's score and size. With `wanted` (a
   * failed download's episodes), it must fill at least one of them.
   */
  private takesItself(
    pack: { plan: PlanEntry[]; summary: PlanSummary },
    wanted?: Set<number>
  ): boolean {
    const auto = getSettings().backfill.autoApprove;
    const fills = pack.plan.filter((e) => e.action === 'fill');
    return (
      pack.summary.fill > 0 &&
      pack.summary.replaces === 0 &&
      pack.summary.score >= auto.minScore &&
      pack.summary.fillBytes <= auto.maxSizeGb * 1024 ** 3 &&
      // Nothing the AI placed is ever taken without an admin seeing it.
      !fills.some((e) => e.matchedBy === 'ai') &&
      (!wanted || fills.some((e) => e.episodeIds.some((id) => wanted.has(id))))
    );
  }

  private async fail(job: BackfillJob, reason: string): Promise<void> {
    job.status = 'failed';
    job.error = reason;
    job.stage = null;
    job.finishedAt = new Date();
    this.note(job, 'error', reason);
    await getRepository(BackfillJob).save(job);
    await this.removeDownload(job).catch(() => undefined);
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: job.seriesId },
    });
    const outcome = await this.offerNext(row, job);
    // A search for a replacement says what became of it once it is done.
    if (outcome !== 'searching') {
      backfillNotices.add({
        kind: outcome === 'replaced' ? 'replaced' : 'failed',
        seriesId: row.id,
        title: row.title,
        poster: row.poster,
        what: jobWhat(row, job),
        detail: reason,
        url: `/backfill/jobs/${job.id}`,
      });
    }
  }

  /** Other downloads still under way for a series. */
  private othersRunning(seriesId: number, jobId: number): Promise<number> {
    return getRepository(BackfillJob).count({
      where: {
        seriesId,
        id: Not(jobId),
        status: In([...ACTIVE, 'paused']),
      },
    });
  }

  /**
   * After a download fails, its release is marked dead and a good pack for
   * the same episodes takes its place on its own (see takesItself): one
   * from the last search, or else from a new one. That goes on until no
   * good pack is left, when the best one found is offered to an admin; or
   * until MAX_FAILED_PER_DAY failed in a day.
   */
  private async offerNext(
    row: BackfillSeries,
    job: BackfillJob
  ): Promise<'replaced' | 'searching' | 'offered' | 'none'> {
    const candidates = getRepository(BackfillCandidate);
    if (job.candidateId) {
      await candidates.update(job.candidateId, {
        status: 'dead',
        reason: (job.error ?? 'The download failed').slice(0, 250),
      });
    }
    const ready = await candidates.find({
      where: { seriesId: row.id, status: 'ready' },
    });
    const ranked = rankCandidates(
      ready.filter((c) => c.summary).map((c) => ({ ...c, summary: c.summary! }))
    );
    const wanted = new Set(job.files.flatMap((f) => f.episodeIds));

    let held: string | null = null;
    if (getSettings().backfill.replaceFailed && wanted.size) {
      const failed = await getRepository(BackfillJob).count({
        where: {
          seriesId: row.id,
          status: 'failed',
          finishedAt: MoreThan(new Date(Date.now() - 24 * 60 * 60_000)),
        },
      });
      if (this.searching.has(row.id)) {
        // A search under way judges the packs afresh; it offers what it finds.
        held = 'A search for this title is under way';
      } else if (failed >= MAX_FAILED_PER_DAY) {
        held = `${failed} downloads for this title failed in the last day, so the next is left for an admin`;
      } else {
        const pick = ranked.find(
          (c) => this.takesItself(c, wanted) && !multiMustWait(c, ranked)
        );
        if (pick) {
          try {
            const next = await this.approve(pick.id, {
              mode: 'missing',
              by: `Backfill (replacing #${job.id})`,
            });
            this.note(job, 'info', `Replaced by #${next.id}: ${pick.title}`);
            await getRepository(BackfillJob).save(job);
            return 'replaced';
          } catch (e) {
            this.note(
              job,
              'warn',
              `Could not start ${pick.title}: ${message(e)}`
            );
          }
        }
        this.note(job, 'info', 'Searching again for a replacement');
        await getRepository(BackfillJob).save(job);
        this.startSearch(row.id, undefined, {
          replacing: [...wanted],
          failedJob: {
            id: job.id,
            what: jobWhat(row, job),
            reason: job.error ?? 'The download failed',
          },
        });
        return 'searching';
      }
    }

    const next = ranked[0];
    await getRepository(BackfillSeries).update(row.id, {
      status: (await this.othersRunning(row.id, job.id))
        ? 'downloading'
        : next
          ? 'found'
          : 'none',
    });
    if (held) this.note(job, 'warn', held);
    if (next) {
      const entity = ready.find((c) => c.id === next.id)!;
      this.note(job, 'info', `Offered the next pack: ${entity.title}`);
      await this.notifyFound(row, entity);
    }
    await getRepository(BackfillJob).save(job);
    return next ? 'offered' : 'none';
  }

  private async removeDownload(job: BackfillJob): Promise<void> {
    if (!job.downloadId) return;
    const client = this.clientById(job.clientId);
    if (job.protocol === 'torrent') {
      await torrentClientFor(client).deleteTorrent(job.downloadId);
    } else {
      await usenetClientFor(client).deleteJob(job.downloadId);
    }
  }

  public async pause(id: number): Promise<BackfillJob> {
    const jobs = getRepository(BackfillJob);
    const job = await jobs.findOneOrFail({ where: { id } });
    if (job.status !== 'downloading') {
      throw new Error('Only a download can be paused.');
    }
    const client = this.clientById(job.clientId);
    if (job.protocol === 'torrent') {
      await torrentClientFor(client).stopTorrent(job.downloadId!);
    } else {
      await usenetClientFor(client).pauseJob(job.downloadId!);
    }
    job.status = 'paused';
    job.speed = 0;
    this.lastGain.delete(job.id);
    this.note(job, 'info', 'Paused');
    return jobs.save(job);
  }

  public async resume(id: number): Promise<BackfillJob> {
    const jobs = getRepository(BackfillJob);
    const job = await jobs.findOneOrFail({ where: { id } });
    if (job.status !== 'paused') throw new Error('The job is not paused.');
    const client = this.clientById(job.clientId);
    if (job.protocol === 'torrent') {
      await torrentClientFor(client).startTorrent(job.downloadId!);
    } else {
      await usenetClientFor(client).resumeJob(job.downloadId!);
    }
    job.status = 'downloading';
    this.lastGain.delete(job.id);
    this.note(job, 'info', 'Resumed');
    return jobs.save(job);
  }

  /** Stops a job and removes its download; imported files stay. */
  public async end(id: number, user?: User): Promise<BackfillJob> {
    // A tick under way would save the job over the ending.
    await this.ticked;
    const jobs = getRepository(BackfillJob);
    const job = await jobs.findOneOrFail({ where: { id } });
    if (job.status === 'importing') {
      throw new Error(
        'Its files are being imported; it can be ended once that is done.'
      );
    }
    if (!['queued', 'downloading', 'paused'].includes(job.status)) {
      throw new Error('The job has already finished.');
    }
    await this.removeDownload(job).catch((e) =>
      this.note(job, 'warn', `Could not remove the download: ${message(e)}`)
    );
    job.status = 'cancelled';
    job.stage = null;
    job.finishedAt = new Date();
    this.note(job, 'info', `Ended by ${user?.displayName ?? 'an admin'}`);
    await jobs.save(job);
    const ready = await getRepository(BackfillCandidate).count({
      where: { seriesId: job.seriesId, status: 'ready' },
    });
    await getRepository(BackfillSeries).update(job.seriesId, {
      status: (await this.othersRunning(job.seriesId, job.id))
        ? 'downloading'
        : ready
          ? 'found'
          : 'none',
    });
    await this.publishDownloads();
    return job;
  }

  /* --------------------------- notifications -------------------------- */

  private async notifyFound(
    row: BackfillSeries,
    candidate: BackfillCandidate,
    poster = row.poster
  ) {
    if (candidate.notifiedAt || !candidate.summary) return;
    const s = candidate.summary;
    const parts =
      row.kind === 'movie'
        ? [s.fill ? 'has the movie' : 'upgrades the movie']
        : [
            s.fill
              ? `fills ${s.fill} missing episode${s.fill === 1 ? '' : 's'}`
              : '',
            s.upgrade ? `upgrades ${s.upgrade}` : '',
          ].filter(Boolean);
    backfillNotices.add({
      kind: 'found',
      seriesId: row.id,
      title: row.title,
      poster,
      what: candidate.title,
      detail: `${parts.join(' and ')}${
        s.quality ? ` (${s.quality}, score ${s.score})` : ''
      }`,
      url: `/backfill/series/${row.id}`,
    });
    await getRepository(BackfillCandidate).update(candidate.id, {
      notifiedAt: new Date(),
    });
  }

  /** Download clients Backfill can use, for the settings page. */
  public clientsFor(protocol: 'torrent' | 'usenet') {
    return getSettings()
      .downloadClients.filter(
        (c) => isTorrentClient(c.type) === (protocol === 'torrent')
      )
      .map((c) => ({ id: c.id, name: c.name }));
  }

  /** What keeps a client chosen in Backfill from working fully, if anything. */
  public clientProblems(client: DownloadClientSettings): Promise<string[]> {
    return downloadClientFor(client).backfillProblems();
  }

  /** Whether the settings' client still answers, for the settings test. */
  public async testClient(id: number): Promise<string> {
    return downloadClientFor(this.clientById(id)).getVersion();
  }
}

const backfill = new Backfill();
export default backfill;
