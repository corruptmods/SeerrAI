import type { TorrentClient } from '@server/api/downloadclients';
import {
  downloadClientFor,
  isTorrentClient,
  torrentClientFor,
  usenetClientFor,
} from '@server/api/downloadclients';
import type { FetchedRelease, ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI, {
  AUDIO_CATEGORIES,
  MOVIE_CATEGORIES,
  TV_CATEGORIES,
  isUnusableLink,
} from '@server/api/prowlarr';
import type { LidarrAlbum } from '@server/api/servarr/lidarr';
import { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import type {
  BackfillJobFile,
  BackfillLogLine,
} from '@server/entity/BackfillJob';
import BackfillJob from '@server/entity/BackfillJob';
import type { BackfillKind } from '@server/entity/BackfillSeries';
import BackfillSeries from '@server/entity/BackfillSeries';
import SongFetch from '@server/entity/SongFetch';
import type { User } from '@server/entity/User';
import {
  episodeNamedIn,
  episodeTitled,
  ownTitle,
  sceneDiffers,
} from '@server/lib/agent/numbering';
import type { AlbumContext } from '@server/lib/backfill/albums';
import { judgeAlbumPack } from '@server/lib/backfill/albums';
import { magnetHash, parseTorrent } from '@server/lib/backfill/bencode';
import {
  IndexerLimitReached,
  PROWLARR,
  indexerLimits,
} from '@server/lib/backfill/indexerLimit';
import { arrIndexerOrigins } from '@server/lib/backfill/indexerOrigins';
import type { AlbumTrack } from '@server/lib/backfill/lidarr';
import BackfillLidarr from '@server/lib/backfill/lidarr';
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
import {
  escapesFolder,
  mapRemotePath,
  placeFiles,
} from '@server/lib/backfill/paths';
import type { PlanEntry, PlanSummary } from '@server/lib/backfill/plan';
import {
  multiMustWait,
  rankCandidates,
  selectEntries,
  unseeded,
} from '@server/lib/backfill/plan';
import {
  PackedRelease,
  ReleaseProblem,
  SaidPlainly,
  isUnreachable,
  message,
  plainProblem,
  requestOf,
} from '@server/lib/backfill/problems';
import type { Progress } from '@server/lib/backfill/progress';
import {
  TORRENT_STAGES,
  backfillDownloadsOf,
  backfillImportsOf,
  measureNzb,
  measureTorrent,
  torrentStage,
  usenetStage,
} from '@server/lib/backfill/progress';
import type { RadarrMovieDetail } from '@server/lib/backfill/radarr';
import BackfillRadarr from '@server/lib/backfill/radarr';
import {
  albumsAskedSince,
  freshRequests,
  pickSearches,
  requestedSince,
} from '@server/lib/backfill/schedule';
import type { OpinionRequest } from '@server/lib/backfill/secondOpinion';
import { aiSecondOpinion } from '@server/lib/backfill/secondOpinion';
import type { SizeProblem } from '@server/lib/backfill/sizeLimits';
import {
  limitsOf,
  sizeNote,
  sizeProblems,
} from '@server/lib/backfill/sizeLimits';
import type {
  SonarrCommand,
  SonarrEpisode,
  SonarrQualityProfile,
} from '@server/lib/backfill/sonarr';
import BackfillSonarr, { commandFinished } from '@server/lib/backfill/sonarr';
import { TorrentWatch, swarmLacks } from '@server/lib/backfill/watchdog';
import { blockedGroupOf, blockedGroups } from '@server/lib/blockedGroups';
import downloadTracker from '@server/lib/downloadtracker';
import { musicReady } from '@server/lib/music/access';
import { namesAlbum } from '@server/lib/music/albumRelease';
import { owner } from '@server/lib/owner';
import type {
  DownloadClientSettings,
  LidarrSettings,
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
 * Scan: find series with monitored, aired episodes and movies the arr has
 * searched for and not found, with nothing in its queue.
 * Search: search Prowlarr under every name the title has, open the most
 * pack-like results, and judge every file with Sonarr or Radarr.
 * Approve (admin or auto-approve rule): add the pack to the download client
 * with only the needed files selected.
 * Monitor (every minute): follow the download; when done, manually import
 * the files into Sonarr or Radarr, verify what landed, remove the download.
 */

const LABEL = 'Backfill';

/** How long a finished job's imports stay reported. */
const RECENTLY_DONE_MS = 10 * 60_000;

const MAX_TERMS = 5;
/** Seasons with missing episodes searched by number, most missing first. */
const MAX_SEASON_TERMS = 3;
/**
 * Missing specials and scene-renumbered episodes searched by title: releases
 * seldom use the library's number for them.
 */
const MAX_TITLE_TERMS = 3;
/** Packs opened per search; each open fetches it and parses every file. */
const MAX_INSPECT = 10;
/** Packs per search the AI second opinion is asked about. */
const MAX_AI_PACKS = 3;
/** Packs opened concurrently during a search. */
const OPEN_AT_ONCE = 3;
/** Time a magnet link gets to produce its file list. */
const METADATA_WAIT_MS = 60_000;
/** Minimum time between two readings used for a Usenet job's speed. */
const PACE_MIN_MS = 5_000;
/** How often the torrent client is swept for leftover magnet probes. */
const PROBE_SWEEP_EVERY_MS = 10 * 60_000;
/** A probe this old is orphaned; probes are read within a minute. */
const PROBE_LEFT_AFTER_MS = 10 * 60_000;
const METADATA_GIVE_UP_MS = 30 * 60_000;
const IMPORT_GIVE_UP_MS = 3 * 60 * 60_000;
const MAX_LOG_LINES = 300;
const IMPORT_BATCH = 50;
/** How long a job waits on its indexer's download limit before failing. */
const LIMIT_GIVE_UP_MS = 24 * 60 * 60_000;
/**
 * After a pack's download fails to start, only an admin can take it for
 * this long: the cause will likely recur, and auto-retrying would loop.
 */
const START_FAILED_HOLD_MS = 24 * 60 * 60_000;
/** Why a pack is held for an admin after its download didn't start. */
const heldReason = (error: string | null): string => {
  // Short enough to fit whole in the pack's reason.
  const why = error ? ` (${error.replace(/\.$/, '').slice(0, 100)})` : '';
  return `Its last download did not start${why}, so Backfill will not take it by itself for a day: approve it by hand once that is put right`;
};
/** Approver name for packs taken by the auto-approve rule. */
const AUTO_APPROVED = 'Backfill (auto-approve)';
const ACTIVE: BackfillJob['status'][] = ['queued', 'downloading', 'importing'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const titleWithoutYear = (title: string) =>
  title.replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim();

/** Trimmed, non-empty, de-duplicated names in order. */
const uniqueNames = (names: string[]): string[] => [
  ...new Set(names.map((n) => n.trim()).filter(Boolean)),
];

export const posterOf = (
  images?: { coverType: string; remoteUrl?: string }[]
): string | null =>
  images?.find((i) => i.coverType === 'poster' || i.coverType === 'cover')
    ?.remoteUrl ?? null;

/** Tracks an album is missing, per Lidarr; 1 when unknown. */
const tracksMissing = (album: LidarrAlbum): number => {
  const stats = album.statistics;
  if (!stats) return 1;
  return Math.max(0, (stats.trackCount ?? 0) - (stats.trackFileCount ?? 0));
};

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
  /** Albums are searched too. */
  music: boolean;
}

/** The title kinds Backfill searches, per Settings → Backfill. */
const followedKinds = (): BackfillKind[] => {
  const settings = getSettings().backfill;
  return [
    'series',
    ...(settings.includeMovies ? (['movie'] as const) : []),
    ...(settings.includeMusic && musicReady() ? (['album'] as const) : []),
  ];
};

/** The shared arr API surface for downloads and imports. */
type Arr = BackfillSonarr | BackfillRadarr | BackfillLidarr;

/** A title ready to search: its names and how to judge a pack. */
interface Target {
  title: string;
  poster: string | null;
  names: string[];
  missing: number;
  categories: number[];
  /**
   * Searches beyond the names, e.g. a season ("Wayfarer Ledger S17"): a
   * name alone returns the most popular releases, often old season packs.
   */
  extraTerms: string[];
  /** How many missing items a release title names. */
  wants(title: string): number;
  /** Whether the app reads a release title as another title or this one. */
  readTitle(title: string): Promise<{ other: boolean; sees: boolean }>;
  judge(
    files: PackFile[],
    packTitle: string,
    secondOpinion?: SeriesContext['secondOpinion']
  ): Promise<{ plan: PlanEntry[]; summary: PlanSummary }>;
  /** Files to take that are outside the app's size limits. */
  sizeCheck?(plan: PlanEntry[]): SizeProblem[];
}

const appOf = (kind: BackfillKind) =>
  kind === 'album' ? 'Lidarr' : kind === 'movie' ? 'Radarr' : 'Sonarr';

/** What a download was for, as notices name it: "S17E02, S17E03". */
const jobWhat = (row: BackfillSeries, job: BackfillJob): string => {
  if (row.kind === 'movie') return 'the movie';
  if (row.kind === 'album') {
    const tracks = job.files.filter((f) => f.episodeIds.length).length;
    return `${tracks} track${tracks === 1 ? '' : 's'} of ${row.title}`;
  }
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

/** Below this, a video in a whole-grabbed release is a sample. */
const WHOLE_MIN_BYTES = 20 * 1024 * 1024;

export interface SearchOptions {
  /** False disables auto-approve, for user-requested searches. */
  autoApprove?: boolean;
  /**
   * Lets the AI place files named only by title. Only for admin-started
   * single-title searches; Backfill's own searches never spend tokens.
   */
  ai?: boolean;
  /**
   * Episodes (or movie) of a failed download: a good pack for any of them
   * is taken automatically, regardless of auto-approve.
   */
  replacing?: number[];
  /** The download being replaced, to report what became of it. */
  failedJob?: { id: number; what: string; reason: string };
  /**
   * Whether the owning run (a scan) was cancelled: the search then stops
   * and leaves earlier findings unchanged.
   */
  cancelled?: () => boolean;
}

/**
 * What the admin agent does with a failed download it started: look for
 * another release (`look` starts it once the job says so), or stop, with
 * why. Null when it can't (off, or the conversation is gone): Backfill then
 * searches as for any download.
 */
export type AgentHandBack =
  | { look: () => Promise<void> }
  | { stopped: 'gaveUp' | 'limit'; why: string }
  | null;

/** Whether the admin agent, not Backfill or an admin, started a download. */
export const startedByAgent = (job: BackfillJob): boolean =>
  (job.agentRunId ?? null) !== null ||
  // Older jobs have no agentRunId; check the approver name.
  /^AI agent\b/.test(job.approvedByName ?? '');

/** Episode (or movie) ids a download was for. */
export const jobEpisodes = (job: Pick<BackfillJob, 'files'>): number[] => [
  ...new Set(job.files.flatMap((f) => f.episodeIds)),
];

/**
 * Failed downloads of one title per day before Backfill stops replacing
 * them automatically: past this, something besides the releases is likely
 * wrong.
 */
export const MAX_FAILED_PER_DAY = 6;

/** Whether an arr date is set and earlier than `when`. */
const before = (date: string | undefined, when: number) =>
  !!date && new Date(date).getTime() < when;

/** Pause between titles when searching everything stuck. */
const SEARCH_ALL_PAUSE_MS = 30_000;
/** Consecutive Prowlarr failures before Search All stops. */
const SEARCH_ALL_FAILURES_TO_STOP = 3;
/**
 * For Search Right After: how long after the arr's own search a requested
 * title still missing, with nothing queued, counts as not found.
 */
const ARR_SETTLE_MS = 20 * 60_000;
/** How often requested titles are checked for Search Right After. */
const QUICK_SCAN_EVERY_MS = 15 * 60_000;
/** Requests newer than this are searched right after; older wait their turn. */
const FRESH_REQUEST_MS = 3 * 24 * 60 * 60_000;

interface SearchAllProgress {
  total: number;
  done: number;
  /** Titles a pack was found for. */
  found: number;
  /** The title being searched, or the setup step before the first. */
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

/** Minimum time between early ticks for finished downloads. */
const KICK_EVERY_MS = 30_000;

class Backfill {
  private scanning = false;
  /** When requested titles were last checked for Search Right After. */
  private quickScannedAt = 0;
  /**
   * The running scan, if any. Cancelling ends only that scan and its
   * searches, not ones started later by an admin or the next scan.
   */
  private scanRun: { cancelled: boolean } | null = null;
  /**
   * Held by a tick and by anything else that changes a job (pausing,
   * ending, adding files): a tick loads every job at start and saves each
   * as it goes, so a concurrent change would be overwritten.
   */
  private ticking = false;
  private searching = new Set<number>();
  private failures = new Map<number, number>();
  private starting = new Set<number>();
  /** Hashes of magnet links being read for their file lists. */
  private probing = new Set<string>();
  // The first sweep waits a full interval after start too.
  private sweptAt = Date.now();
  /** Settles when the running tick, if any, ends. */
  private ticked: Promise<void> = Promise.resolve();
  /** Gives up on torrents that stall, can't finish or crawl. */
  private watch = new TorrentWatch();
  /** When a page last triggered an early tick. */
  private kickedAt = 0;
  /**
   * Each Usenet download's last remaining bytes and time, to derive its own
   * speed when the client reports only one figure for the whole queue.
   */
  private nzbPace = new Map<
    number,
    { left: number; at: number; speed: number }
  >();
  /** In-flight live readings, shared by concurrent page requests. */
  private readings = new Map<number, Promise<Progress | null>>();

  /**
   * A downloading job's current progress from the client, not the last
   * tick's. Null when unreadable; the page then shows the saved values.
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

  /** Jobs with live readings applied over the saved ones. */
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
      // Finished: import now rather than at the next tick.
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
    // Downloaded; the client is still unpacking or running its script.
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
   * A Usenet download's speed: the client's figure when it is per job, else
   * progress since a reading at least PACE_MIN_MS old, else the last known.
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
   * Ticks now for a download a page saw finish, unless a tick is running or
   * was triggered recently: a failing import must not retry at the page's
   * poll rate, since each try counts toward giving up.
   */
  private tickSoon(): void {
    if (this.ticking || Date.now() - this.kickedAt < KICK_EVERY_MS) return;
    this.kickedAt = Date.now();
    this.tick().catch(() => undefined);
  }

  /** Settles when the running tick, if any, ends. */
  public tickDone(): Promise<void> {
    return this.ticked;
  }

  public status() {
    return { running: this.scanning };
  }

  /* ------------------------ searching everything ------------------------ */

  /** The running Search All, if any. */
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
   * Searches every stuck title one at a time with a pause between, not a
   * few per scan: requested titles first. Recent arr searches count too.
   * Titles Backfill searched within a day are skipped. Auto-approve applies
   * as in a scan. In memory only: a restart ends it.
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
      const repo = getRepository(BackfillSeries);
      const kinds = followedKinds();
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
        // The search records a title's own failure on it; the rest go on.
        await this.search(row.id, user).catch((e) =>
          logger.warn('Backfill could not search a title', {
            label: LABEL,
            seriesId: row.id,
            errorMessage: message(e),
          })
        );
        run.done += 1;
        const after = await repo.findOne({ where: { id: row.id } });
        if (after && ['found', 'downloading'].includes(after.status)) {
          run.found += 1;
        }
        // Prowlarr down fails every search alike, so stop.
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

  /** Waits `ms`, ending early once `stop` returns true. */
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

  /** Cancels the running scan, if any. */
  public cancel() {
    if (this.scanRun) this.scanRun.cancelled = true;
  }

  /**
   * Called for each title a search found nothing usable for, so the admin
   * agent can look further. Set once at startup.
   */
  public onNothingFound: ((row: BackfillSeries) => void) | null = null;

  /**
   * Called for each agent-started download that failed for its release, so
   * the agent can look for another. Set by the agent.
   */
  public onAgentDownloadFailed:
    | ((job: BackfillJob) => Promise<AgentHandBack>)
    | null = null;

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

  /**
   * A title's current status. One saved as searching with no running search
   * was left by a restart, and is stuck.
   */
  public statusOf(
    row: Pick<BackfillSeries, 'id' | 'status'>
  ): BackfillSeries['status'] {
    if (this.searching.has(row.id)) return 'searching';
    return row.status === 'searching' ? 'stuck' : row.status;
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
        ? 'Prowlarr is not set up in Settings → Services.'
        : !torrent && !usenet
          ? 'No download client is chosen in Settings → Backfill.'
          : !settings.sonarr.length &&
              !(backfill.includeMovies && settings.radarr.length) &&
              !(backfill.includeMusic && musicReady())
            ? 'No Sonarr, Radarr or Lidarr server is set up.'
            : undefined;
    return {
      ready: !problem,
      enabled: backfill.enabled,
      prowlarr,
      torrentClient: torrent?.name,
      usenetClient: usenet?.name,
      problem,
      music: backfill.includeMusic && musicReady(),
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

  /**
   * Plan files outside Sonarr's or Radarr's size limits for a series or
   * movie; the admin agent checks this before a grab.
   */
  public async sizeProblemsFor(
    title: { kind: BackfillKind; serverId: number; arrId: number },
    plan: PlanEntry[]
  ): Promise<SizeProblem[]> {
    if (title.kind === 'movie') {
      const radarr = this.radarrFor(title.serverId);
      const movie = await radarr.getMovieDetail(title.arrId);
      const profile = await radarr.getQualityProfile(movie.qualityProfileId);
      return (await this.sizeChecker(radarr, profile, movie.runtime, 'Radarr'))(
        plan
      );
    }
    if (title.kind === 'series') {
      const sonarr = this.sonarrFor(title.serverId);
      const series = await sonarr.getSeriesDetail(title.arrId);
      const profile = await sonarr.getQualityProfile(series.qualityProfileId);
      return (
        await this.sizeChecker(sonarr, profile, series.runtime, 'Sonarr')
      )(plan);
    }
    return [];
  }

  public lidarrFor(serverId: number): BackfillLidarr {
    const server = getSettings().lidarr.find((s) => s.id === serverId);
    if (!server) throw new Error('That Lidarr server is no longer set up.');
    return BackfillLidarr.forServer(server);
  }

  /**
   * Finds an album in Lidarr by MusicBrainz id, trying the given server
   * first. Undefined when no Lidarr has it.
   */
  public async findAlbum(
    mbId: string,
    serverId?: number
  ): Promise<{ serverId: number; arrId: number; title: string } | undefined> {
    const servers = this.distinct(getSettings().lidarr).sort(
      (a, b) => Number(b.id === serverId) - Number(a.id === serverId)
    );
    for (const server of servers) {
      const album = await BackfillLidarr.forServer(server)
        .getAlbumByMbid(mbId)
        .catch(() => undefined);
      if (album) {
        return { serverId: server.id, arrId: album.id, title: album.title };
      }
    }
    return undefined;
  }

  public arrFor(row: BackfillSeries): Arr {
    return row.kind === 'album'
      ? this.lidarrFor(row.serverId)
      : row.kind === 'movie'
        ? this.radarrFor(row.serverId)
        : this.sonarrFor(row.serverId);
  }

  /** One per instance: two entries for one host (a 4K one) are one app. */
  private distinct<T extends SonarrSettings | RadarrSettings | LidarrSettings>(
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
   * Reads what the arrs are missing, tracks what is stuck, and searches the
   * titles due. `everything` tracks all that is missing regardless of recent
   * arr searches; `searches: false` only reads.
   */
  public async scan({
    everything = false,
    searches = true,
    quick = false,
  }: {
    everything?: boolean;
    searches?: boolean;
    /**
     * Search Right After: search only recently requested titles the arr
     * searched for and didn't find.
     */
    quick?: boolean;
  } = {}): Promise<void> {
    if (this.scanning || !this.readiness().ready) {
      return;
    }
    this.scanning = true;
    const run = { cancelled: false };
    this.scanRun = run;
    try {
      const settings = getSettings().backfill;
      const repo = getRepository(BackfillSeries);
      await this.unstickSearches();
      const stuckBefore = everything
        ? Date.now()
        : Date.now() - settings.stuckAfterHours * 3_600_000;
      // For fresh requests under Search Right After, a recent arr search is
      // enough to count as stuck.
      const askedBefore = Date.now() - ARR_SETTLE_MS;
      const freshlyAsked = quick
        ? await freshRequests(Date.now() - FRESH_REQUEST_MS)
        : { movie: new Set<number>(), tv: new Set<number>() };
      for (const server of this.distinct(getSettings().sonarr)) {
        if (run.cancelled) return;
        const sonarr = BackfillSonarr.forServer(server);
        const missingList = await sonarr.getWanted('missing');
        const cutoffList = settings.includeCutoffUnmet
          ? await sonarr.getWanted('cutoff')
          : { records: [], complete: true };
        const wanted = missingList.records;
        const cutoff = cutoffList.records;
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
            // Searched a while ago and still missing, or never searched
            // (added without search) but aired and in Sonarr a while.
            const after =
              record.series.tmdbId && freshlyAsked.tv.has(record.series.tmdbId)
                ? Math.max(stuckBefore, askedBefore)
                : stuckBefore;
            if (
              searched
                ? searched < after
                : before(record.airDateUtc, after) &&
                  before(record.series.added, after)
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
          if (run.cancelled) return;
          const row = byId.get(seriesId);
          const gap = entry.stuck > 0 || entry.belowCutoff > 0;
          if (!row && !gap) continue;
          // Anything queued means Sonarr is still working on it.
          if (!row && (await sonarr.getSeriesQueueCount(seriesId)) > 0) {
            continue;
          }
          const read = {
            title: entry.series.title,
            year: entry.series.year ?? null,
            tvdbId: entry.series.tvdbId ?? null,
            tmdbId: entry.series.tmdbId ?? null,
            seriesType: entry.series.seriesType ?? 'standard',
            poster: posterOf(entry.series.images) ?? row?.poster ?? null,
            missing: entry.missing,
            belowCutoff: entry.belowCutoff,
            lastArrSearchAt: entry.lastSearch
              ? new Date(entry.lastSearch)
              : null,
          };
          if (!row) {
            await repo.save(
              new BackfillSeries({
                kind: 'series',
                serverId: server.id,
                arrId: seriesId,
                status: 'stuck',
                searchTerms: [],
                ...read,
              })
            );
          } else {
            await this.refresh(row.id, read);
          }
        }
        // Anything no longer missing is done, unless the list was cut short
        // and may have left it out.
        if (missingList.complete && cutoffList.complete) {
          await this.markDone(known.filter((row) => !bySeries.has(row.arrId)));
        } else {
          logger.warn(
            `Sonarr's wanted list is too long to read whole; titles not in the part read are left as they are`,
            { label: LABEL, server: server.name }
          );
        }
      }
      if (settings.includeMovies) {
        for (const server of this.distinct(getSettings().radarr)) {
          if (run.cancelled) return;
          // One Radarr down must not block the series searches.
          await this.scanMovies(
            server,
            (tmdbId) =>
              tmdbId && freshlyAsked.movie.has(tmdbId)
                ? Math.max(stuckBefore, askedBefore)
                : stuckBefore,
            run
          ).catch((e) =>
            logger.error('Backfill could not read Radarr', {
              label: LABEL,
              server: server.name,
              errorMessage: message(e),
            })
          );
        }
      }
      if (settings.includeMusic && musicReady()) {
        for (const server of this.distinct(getSettings().lidarr)) {
          if (run.cancelled) return;
          await this.scanAlbums(
            server,
            quick ? Math.max(stuckBefore, askedBefore) : stuckBefore,
            run
          ).catch((e) =>
            logger.error('Backfill could not read Lidarr', {
              label: LABEL,
              server: server.name,
              errorMessage: message(e),
            })
          );
        }
      }
      await this.dropStaleOffers();
      // A running Search All does the searching itself.
      if (!searches || this.searchAllRun) return;

      const kinds = followedKinds();
      const due = await repo.find({
        where: [
          { status: 'stuck', kind: In(kinds) },
          { status: 'none', kind: In(kinds) },
        ],
      });
      const requested = await requestedSince(due);
      const toSearch = quick
        ? // Only recent requests Backfill hasn't searched yet.
          pickSearches(
            due.filter(
              (row) =>
                !row.lastSearchedAt &&
                (requested.get(row.id)?.getTime() ?? 0) >=
                  Date.now() - FRESH_REQUEST_MS
            ),
            requested,
            settings
          )
        : pickSearches(due, requested, settings);
      if (quick && toSearch.length) {
        logger.info(
          'Searching titles Sonarr, Radarr or Lidarr found nothing for',
          {
            label: LABEL,
            titles: toSearch.map((row) => row.title),
          }
        );
      }
      let prowlarrFailed = 0;
      for (const row of toSearch) {
        if (run.cancelled) return;
        // A title's failure is recorded on it and the rest go on, unless
        // Prowlarr is down, which fails every search alike.
        const failed = await this.search(row.id, undefined, {
          cancelled: () => run.cancelled,
        }).then(
          () => undefined,
          (e) => message(e)
        );
        if (failed) {
          logger.warn('Backfill could not search a title', {
            label: LABEL,
            seriesId: row.id,
            errorMessage: failed,
          });
        }
        prowlarrFailed = failed?.startsWith('Prowlarr')
          ? prowlarrFailed + 1
          : 0;
        if (prowlarrFailed >= SEARCH_ALL_FAILURES_TO_STOP) {
          logger.warn('Backfill stopped searching: Prowlarr is not answering', {
            label: LABEL,
            errorMessage: failed,
          });
          return;
        }
      }
    } catch (e) {
      logger.error('Backfill scan failed', {
        label: LABEL,
        errorMessage: message(e),
      });
    } finally {
      this.scanning = false;
      this.scanRun = null;
    }
  }

  /**
   * Resets titles left "searching" by a restart mid-search to stuck. Runs at
   * startup and before each scan.
   */
  public async unstickSearches(): Promise<void> {
    const repo = getRepository(BackfillSeries);
    const left = await repo.find({
      where: { status: 'searching' },
      select: { id: true },
    });
    for (const row of left) {
      if (this.searching.has(row.id)) continue;
      await repo.update(
        { id: row.id, status: 'searching' },
        { status: 'stuck' }
      );
    }
  }

  /**
   * Saves what a scan read for a tracked title. Only these columns belong
   * to the scan; status, search terms and the rest are owned by searches,
   * approvals and admins. A done title missing something again is stuck.
   */
  private async refresh(
    id: number,
    read: Partial<BackfillSeries>
  ): Promise<void> {
    const repo = getRepository(BackfillSeries);
    await repo.update(id, read);
    await repo.update({ id, status: 'done' }, { status: 'stuck' });
  }

  /** Marks titles no longer missing anything done, unless otherwise held. */
  private async markDone(rows: BackfillSeries[]): Promise<void> {
    for (const row of rows) {
      if (!['stuck', 'none', 'found'].includes(row.status)) continue;
      // Conditional on status, so a title approved or ignored since it was
      // read is left alone.
      await getRepository(BackfillSeries).update(
        { id: row.id, status: In(['stuck', 'none', 'found']) },
        { status: 'done', missing: 0, belowCutoff: 0 }
      );
    }
  }

  /**
   * Deletes ready packs for titles no longer missing anything: they were
   * judged against old files and offer nothing now.
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
   * Tracks movies Radarr searched for and didn't find before `stuckBefore`,
   * or whose file is below cutoff, with nothing in Radarr's queue.
   */
  private async scanMovies(
    server: RadarrSettings,
    stuckBeforeFor: (tmdbId?: number | null) => number,
    run: { cancelled: boolean }
  ) {
    const settings = getSettings().backfill;
    const repo = getRepository(BackfillSeries);
    const radarr = BackfillRadarr.forServer(server);
    const missingList = await radarr.getWanted('missing');
    const cutoffList = settings.includeCutoffUnmet
      ? await radarr.getWanted('cutoff')
      : { records: [], complete: true };
    const missing = missingList.records.filter((movie) => movie.isAvailable);
    const wanted = new Map<
      number,
      { movie: RadarrMovieDetail; missing: boolean }
    >();
    for (const movie of cutoffList.records) {
      wanted.set(movie.id, { movie, missing: false });
    }
    for (const movie of missing) wanted.set(movie.id, { movie, missing: true });

    const known = await repo.find({
      where: { kind: 'movie', serverId: server.id },
    });
    const byId = new Map(known.map((row) => [row.arrId, row]));
    for (const [movieId, entry] of wanted) {
      if (run.cancelled) return;
      const row = byId.get(movieId);
      const searched = entry.movie.lastSearchTime
        ? new Date(entry.movie.lastSearchTime).getTime()
        : 0;
      const stuckBefore = stuckBeforeFor(entry.movie.tmdbId);
      // Searched a while ago and still missing, or never searched but in
      // Radarr a while.
      const stuck =
        entry.missing &&
        (searched > 0
          ? searched < stuckBefore
          : before(entry.movie.added, stuckBefore));
      if (!row && !stuck && entry.missing) continue;
      if (!row && (await radarr.getMovieQueueCount(movieId)) > 0) continue;
      const read = {
        title: entry.movie.title,
        year: entry.movie.year ?? null,
        tmdbId: entry.movie.tmdbId ?? null,
        poster: posterOf(entry.movie.images) ?? row?.poster ?? null,
        missing: entry.missing ? 1 : 0,
        belowCutoff: entry.missing ? 0 : 1,
        lastArrSearchAt: searched ? new Date(searched) : null,
      };
      if (!row) {
        await repo.save(
          new BackfillSeries({
            ...this.movieRow(server.id, entry.movie),
            ...read,
          })
        );
      } else {
        await this.refresh(row.id, read);
      }
    }
    if (missingList.complete && cutoffList.complete) {
      await this.markDone(known.filter((row) => !wanted.has(row.arrId)));
    } else {
      logger.warn(
        `Radarr's wanted list is too long to read whole; movies not in the part read are left as they are`,
        { label: LABEL, server: server.name }
      );
    }
  }

  /**
   * Tracks requested albums Lidarr is missing (or has below cutoff) and has
   * had its chance at, with nothing queued. Lidarr lists every album of an
   * added artist as wanted, so only requested or admin-chosen albums are
   * tracked. Lidarr doesn't report its last search, so an album is stuck
   * once it was released, its artist added, and its request approved, all
   * before `stuckBefore`.
   */
  private async scanAlbums(
    server: LidarrSettings,
    stuckBefore: number,
    run: { cancelled: boolean }
  ) {
    const settings = getSettings().backfill;
    const repo = getRepository(BackfillSeries);
    const lidarr = BackfillLidarr.forServer(server);
    const missingList = await lidarr.getWanted('missing');
    const cutoffList = settings.includeCutoffUnmet
      ? await lidarr.getWanted('cutoff')
      : { records: [], complete: true };
    const wanted = new Map<number, { album: LidarrAlbum; missing: boolean }>();
    for (const album of cutoffList.records) {
      wanted.set(album.id, { album, missing: false });
    }
    for (const album of missingList.records) {
      wanted.set(album.id, { album, missing: true });
    }

    const asked = await albumsAskedSince(
      [...wanted.values()].map((w) => w.album.foreignAlbumId)
    );
    const known = await repo.find({
      where: { kind: 'album', serverId: server.id },
    });
    const byId = new Map(known.map((row) => [row.arrId, row]));
    for (const [albumId, entry] of wanted) {
      if (run.cancelled) return;
      const { album } = entry;
      const row = byId.get(albumId);
      const askedAt = asked.get(album.foreignAlbumId);
      if (!askedAt && !row?.byHand) continue;
      const stuck =
        entry.missing &&
        before(album.releaseDate, stuckBefore) &&
        before(album.artist?.added, stuckBefore) &&
        !!askedAt &&
        askedAt.getTime() < stuckBefore;
      if (!row && !stuck && entry.missing) continue;
      if (!row && (await lidarr.getAlbumQueueCount(albumId)) > 0) continue;
      const read = {
        title: album.title,
        year: album.releaseDate
          ? new Date(album.releaseDate).getUTCFullYear()
          : null,
        poster: posterOf(album.images) ?? row?.poster ?? null,
        missing: entry.missing ? Math.max(1, tracksMissing(album)) : 0,
        belowCutoff: entry.missing ? 0 : 1,
        artistName: album.artist?.artistName ?? row?.artistName ?? null,
        artistArrId: album.artistId,
        foreignId: album.foreignAlbumId,
      };
      if (!row) {
        await repo.save(
          new BackfillSeries({ ...this.albumRow(server.id, album), ...read })
        );
      } else {
        await this.refresh(row.id, read);
      }
    }
    // Drop albums no longer requested and not admin-chosen, with their
    // waiting packs, unless Backfill downloaded for them (history stays).
    await this.letGo(
      known.filter(
        (row) =>
          !row.byHand &&
          !(row.foreignId && asked.has(row.foreignId)) &&
          wanted.has(row.arrId)
      )
    );
    if (missingList.complete && cutoffList.complete) {
      await this.markDone(known.filter((row) => !wanted.has(row.arrId)));
    } else {
      logger.warn(
        `Lidarr's wanted list is too long to read whole; albums not in the part read are left as they are`,
        { label: LABEL, server: server.name }
      );
    }
  }

  /**
   * Stops tracking titles a scan shouldn't have: each is deleted with its
   * packs, unless Backfill downloaded anything for it.
   */
  private async letGo(rows: BackfillSeries[]): Promise<void> {
    // One being searched is left to the next scan.
    const idle = rows.filter((row) => !this.isSearching(row.id));
    if (!idle.length) return;
    const jobs = await getRepository(BackfillJob).find({
      select: { seriesId: true, status: true },
      where: { seriesId: In(idle.map((r) => r.id)) },
    });
    const repo = getRepository(BackfillSeries);
    // With past downloads: kept as done for its history, so it isn't
    // searched; a new request tracks it again. One with a running download
    // is left alone.
    const kept = idle.filter(
      (row) =>
        jobs.some((job) => job.seriesId === row.id) &&
        !jobs.some(
          (job) =>
            job.seriesId === row.id &&
            [...ACTIVE, 'paused'].includes(job.status)
        )
    );
    if (kept.length) {
      await repo.update(
        {
          id: In(kept.map((row) => row.id)),
          byHand: false,
          status: In(['stuck', 'none', 'found']),
        },
        { status: 'done', missing: 0, belowCutoff: 0 }
      );
    }
    const gone = idle.filter(
      (row) => !jobs.some((job) => job.seriesId === row.id)
    );
    if (!gone.length) return;
    // `byHand: false` keeps any an admin chose since the scan read it.
    await repo.delete({ id: In(gone.map((row) => row.id)), byHand: false });
    logger.info(
      `Backfill no longer follows ${gone.length} album${gone.length === 1 ? '' : 's'} nobody requested`,
      { label: LABEL }
    );
  }

  private albumRow(serverId: number, album: LidarrAlbum) {
    return new BackfillSeries({
      kind: 'album',
      serverId,
      arrId: album.id,
      title: album.title,
      year: album.releaseDate
        ? new Date(album.releaseDate).getUTCFullYear()
        : null,
      tvdbId: null,
      tmdbId: null,
      foreignId: album.foreignAlbumId,
      artistName: album.artist?.artistName ?? null,
      artistArrId: album.artistId,
      seriesType: 'standard',
      poster: posterOf(album.images),
      status: 'stuck',
      missing: Math.max(1, tracksMissing(album)),
      searchTerms: [],
    });
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

  /** Tracks a title by its arr id, as from a title page. */
  public async track(
    kind: BackfillKind,
    serverId: number,
    arrId: number,
    /** Admin-chosen: kept whether or not anyone requested it. */
    byHand = false
  ): Promise<BackfillSeries> {
    const repo = getRepository(BackfillSeries);
    const existing = await repo.findOne({ where: { kind, serverId, arrId } });
    if (existing) {
      if (byHand && !existing.byHand) {
        await repo.update(existing.id, { byHand: true });
        existing.byHand = true;
      }
      return existing;
    }
    if (kind === 'album') {
      const lidarr = this.lidarrFor(serverId);
      const album = await lidarr.getAlbumDetail(arrId);
      const artist =
        album.artist ?? (await lidarr.getArtistDetail(album.artistId));
      return repo.save(
        new BackfillSeries({
          ...this.albumRow(serverId, { ...album, artist }),
          byHand,
        })
      );
    }
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
    const names = uniqueNames([
      titleWithoutYear(series.title),
      series.title,
      // Sonarr v5 may show a translated title; releases usually use the
      // original one, if it's in Latin letters.
      ...(series.originalTitle && /[a-z]/i.test(series.originalTitle)
        ? [series.originalTitle]
        : []),
      ...(series.alternateTitles ?? []).map((alt) => alt.title),
      ...(row.searchTerms ?? []),
    ]);
    return { series, episodes, files, profile, names, sonarr };
  }

  public async movieContext(row: BackfillSeries): Promise<MovieContext> {
    const radarr = this.radarrFor(row.serverId);
    const movie = await radarr.getMovieDetail(row.arrId);
    const [file, profile] = await Promise.all([
      movie.hasFile ? radarr.getMovieFile(movie.id) : null,
      radarr.getQualityProfile(movie.qualityProfileId),
    ]);
    const names = uniqueNames([
      movie.title,
      movie.originalTitle ?? '',
      ...(movie.alternateTitles ?? []).map((alt) => alt.title),
      ...(row.searchTerms ?? []),
    ]);
    return { movie, file, profile, names, radarr };
  }

  public async albumContext(row: BackfillSeries): Promise<AlbumContext> {
    const lidarr = this.lidarrFor(row.serverId);
    const album = await lidarr.getAlbumDetail(row.arrId);
    const artist = await lidarr.getArtistDetail(album.artistId);
    const [tracks, files, profile] = await Promise.all([
      lidarr.getAlbumTracks(album.id),
      lidarr.getAlbumTrackFiles(album.id),
      lidarr.getQualityProfile(artist.qualityProfileId),
    ]);
    const editions = new Map<number, Promise<AlbumTrack[]>>();
    const names = uniqueNames([
      `${artist.artistName} ${album.title}`,
      album.title,
      ...(row.searchTerms ?? []),
    ]);
    return {
      album,
      artist,
      tracks,
      files,
      profile,
      names,
      lidarr,
      editionTracks: (releaseId) => {
        if (!editions.has(releaseId)) {
          editions.set(releaseId, lidarr.getEditionTracks(releaseId));
        }
        return editions.get(releaseId)!;
      },
    };
  }

  /** What a search needs to know about a series, movie or album. */
  private async target(row: BackfillSeries): Promise<Target> {
    if (row.kind === 'album') {
      const ctx = await this.albumContext(row);
      const named = (title: string) =>
        namesAlbum(title, ctx.album.title, ctx.artist.artistName);
      return {
        title: `${ctx.artist.artistName}: ${ctx.album.title}`,
        poster: posterOf(ctx.album.images),
        names: ctx.names,
        missing: ctx.tracks.filter((t) => !t.hasFile).length,
        categories: AUDIO_CATEGORIES,
        extraTerms: [],
        wants: (title) => Number(named(title)),
        // Skip another Lidarr album, or a name that isn't this album by
        // this artist (someone else's "Greatest Hits").
        readTitle: async (title) => {
          const parsed = await ctx.lidarr.parse(title).catch(() => null);
          const albums = parsed?.albums ?? [];
          const sees = albums.some((a) => a.id === ctx.album.id);
          return {
            other: !named(title) || (!!albums.length && !sees),
            sees,
          };
        },
        judge: (files, packTitle) => judgeAlbumPack(files, packTitle, ctx),
      };
    }
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
        sizeCheck: await this.sizeChecker(
          ctx.radarr,
          ctx.profile,
          ctx.movie.runtime,
          'Radarr'
        ),
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
    // Anime packs use absolute numbers, so season searches find little.
    const seasons =
      ctx.series.seriesType === 'anime'
        ? []
        : [...bySeason.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_SEASON_TERMS)
            .map(([season]) => season);
    const wanted = missing.flatMap((ep) =>
      [
        [ep.seasonNumber, ep.episodeNumber],
        // Also by scene numbers, as Sonarr searches.
        ...(sceneDiffers(ep)
          ? [[ep.sceneSeasonNumber!, ep.sceneEpisodeNumber!]]
          : []),
      ].map(
        ([season, episode]) =>
          new RegExp(`\\bS${pad(season)}E${pad(episode)}\\b`, 'i')
      )
    );
    const missingIds = new Set(missing.map((ep) => ep.id));
    /** Whether a title names a missing episode by its title, numbered or not. */
    const namesMissing = (title: string) => {
      const ep =
        episodeTitled(title, ctx.episodes) ??
        episodeNamedIn(title, ctx.episodes, ctx.names);
      return !!ep && missingIds.has(ep.id);
    };
    const byTitle = [
      ...missing.filter((ep) => ep.seasonNumber === 0),
      ...missing.filter((ep) => ep.seasonNumber > 0 && sceneDiffers(ep)),
    ]
      .filter(ownTitle)
      .slice(0, MAX_TITLE_TERMS);
    const wantedSeasons = [...bySeason.keys()].map(
      (season) => new RegExp(`\\bS${pad(season)}\\b(?!E)`, 'i')
    );
    return {
      title: ctx.series.title,
      poster: posterOf(ctx.series.images),
      names: ctx.names,
      missing: missing.length,
      categories: TV_CATEGORIES,
      extraTerms: [
        ...seasons.map(
          (season) => `${titleWithoutYear(ctx.series.title)} S${pad(season)}`
        ),
        ...byTitle.map(
          (ep) => `${titleWithoutYear(ctx.series.title)} ${ep.title}`
        ),
      ],
      wants: (title) =>
        wanted.filter((rx) => rx.test(title)).length +
        wantedSeasons.filter((rx) => rx.test(title)).length +
        Number(namesMissing(title)),
      // A title Sonarr matches to another of its shows (Tsumuden, for
      // Kitsuraga) belongs to that show.
      readTitle: async (title) => {
        const parsed = await ctx.sonarr.parse(title).catch(() => null);
        return {
          other: !!parsed?.series && parsed.series.id !== ctx.series.id,
          sees: parsed?.series?.id === ctx.series.id,
        };
      },
      judge: (files, packTitle, secondOpinion) =>
        judgePack(files, packTitle, { ...ctx, secondOpinion }),
      sizeCheck: await this.sizeChecker(
        ctx.sonarr,
        ctx.profile,
        ctx.series.runtime,
        'Sonarr'
      ),
    };
  }

  /**
   * A checker for plan files against the app's size limits for the
   * profile. Unreadable limits don't block the search.
   */
  private async sizeChecker(
    arr: BackfillSonarr | BackfillRadarr,
    profile: SonarrQualityProfile,
    runtime: number | undefined,
    app: 'Sonarr' | 'Radarr'
  ): Promise<(plan: PlanEntry[]) => SizeProblem[]> {
    const definitions = await arr.getQualityDefinitions().catch(() => []);
    const limits = limitsOf(profile, definitions);
    return (plan) => sizeProblems(plan, limits, runtime, app);
  }

  /** Starts a search without waiting; the page polls its status. */
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
   * Searches for packs for one title. The AI second opinion runs as `user`,
   * or as the owner for scheduled searches.
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

      // Search each name in the app's order, skipping names another already
      // covers ("Ninefold Sky" covers "Ninefold Sky (2021)").
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
          for (const release of await indexerLimits.guard(
            PROWLARR,
            'search',
            () => prowlarr.search(term, { categories: target.categories })
          )) {
            const key =
              release.infoHash?.toLowerCase() ||
              `${release.title.toLowerCase()}|${Math.round(release.size / 1e6)}`;
            const held = found.get(key);
            if (!held || (release.seeders ?? 0) > (held.seeders ?? 0)) {
              found.set(key, release);
            }
          }
        } catch (e) {
          errors.push(`${term}: ${plainProblem(e)}`);
          if (!(e instanceof IndexerLimitReached) || e.asked) {
            logger.warn('Prowlarr could not search', {
              label: LABEL,
              seriesId: id,
              term,
              errorMessage: message(e),
            });
          }
          // Further names would only spend searches against the limit.
          if (e instanceof IndexerLimitReached) break;
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
      // Open releases naming a missing item first, then the likeliest packs.
      const wanting = new Map(
        titled.map((t) => [t.release, target.wants(t.release.title) > 0])
      );
      const toOpen = titled
        .filter((t) => !t.other)
        .sort(
          (a, b) =>
            Number(wanting.get(b.release)) - Number(wanting.get(a.release)) ||
            packScore(b.release) - packScore(a.release) ||
            (b.release.seeders ?? 0) - (a.release.seeders ?? 0)
        )
        .slice(0, MAX_INSPECT);

      // Open a few at a time: a magnet's file list can take a minute. Only
      // the first few packs get the second opinion, capping AI cost.
      const opened = await mapLimit(
        toOpen.map((entry, i) => ({ ...entry, i })),
        OPEN_AT_ONCE,
        async ({ release, sees, i }): Promise<BackfillCandidate | null> => {
          if (options.cancelled?.()) return null;
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
            // The same torrent under another name or indexer: don't offer
            // what was skipped or died before.
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
            const outside = target.sizeCheck?.(plan) ?? [];
            candidate.summary = {
              ...summary,
              sonarrSeesTitle: sees,
              ...(outside.length
                ? { outsideSize: outside.length, sizeNote: sizeNote(outside) }
                : {}),
            };
            const useful =
              summary.fill > 0 ||
              (summary.upgrade > 0 &&
                (settings.includeCutoffUnmet || !missing));
            candidate.status = useful ? 'ready' : 'rejected';
            candidate.reason = useful
              ? null
              : (mainReason(plan) ??
                (row.kind === 'album'
                  ? 'No track the album needs is in it'
                  : row.kind === 'movie'
                    ? 'The movie is not in it'
                    : plan.length
                      ? 'Nothing in it the series needs'
                      : 'No episodes in it'));
          } catch (e) {
            candidate.status = 'failed';
            candidate.reason = plainProblem(e, release.indexer).slice(0, 250);
          }
          return candidate;
        }
      );
      const results = opened.filter((c): c is BackfillCandidate => c !== null);
      // Cancelled midway: results are partial, so keep the last search's
      // findings and restore the title's status.
      if (options.cancelled?.()) {
        await repo.update(
          { id, status: 'searching' },
          { status: previous === 'searching' ? 'stuck' : previous }
        );
        return;
      }

      // Replace the last search's findings, except those an admin acted on.
      await candidates.delete({
        seriesId: id,
        status: In(['ready', 'rejected', 'failed']),
      });
      // A pack whose download recently failed to start still waits for an
      // admin, with the reason.
      const startFailed = await this.startFailures(id);
      for (const c of results) {
        const held = c.status === 'ready' ? startFailed(c) : undefined;
        if (held) c.reason = held;
      }
      // Size limits hold: a pack outside them is rejected if another within
      // them was found, else offered to an admin, never taken automatically.
      const withinLimits = results.some(
        (c) => c.status === 'ready' && !c.summary?.outsideSize
      );
      for (const c of results) {
        if (c.status !== 'ready' || !c.summary?.outsideSize) continue;
        if (withinLimits) c.status = 'rejected';
        c.reason ??= c.summary.sizeNote ?? null;
      }
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
      // Replacing a failed download: the best good pack for its items, even
      // beside other downloads for the title. Never one that recently failed
      // to start.
      const pick = replacing
        ? ready.find(
            (c) =>
              this.takesItself(c, replacing) &&
              !multiMustWait(c, ready) &&
              !startFailed(c)
          )
        : best &&
            !busy &&
            settings.autoApprove.enabled &&
            options.autoApprove !== false &&
            this.takesItself(best) &&
            !startFailed(best)
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
        // Approving a pack already linked it; otherwise record on the
        // failed download what was offered instead, or that nothing was.
        if (!taken) {
          await this.settleFailed(
            options.failedJob.id,
            best && !busy ? 'offered' : 'none'
          );
        }
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
      if (options.failedJob) {
        await this.settleFailed(options.failedJob.id, 'none').catch(
          () => undefined
        );
      }
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
   * A release's files (from Prowlarr or an arr's search), as a search reads
   * them, with the torrent hash once known.
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
      // RAR or scrambled Usenet posts: files are known only after download.
      if (e instanceof PackedRelease) {
        return { files: [], infoHash: null, packed: e.packing };
      }
      throw e;
    }
  }

  /** A result's files, from its .torrent, its NZB, or the swarm. */
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

  /**
   * Fetches a release's .torrent or .nzb via Prowlarr; skipped while the
   * indexer waits out its download limit.
   */
  private fetch(candidate: BackfillCandidate): Promise<FetchedRelease> {
    return indexerLimits.guard(
      { id: candidate.indexerId, name: candidate.indexer },
      'download',
      async () => {
        try {
          return await this.prowlarr().fetchRelease(
            {
              guid: candidate.guid,
              title: candidate.title,
              size: candidate.size,
              indexerId: candidate.indexerId,
              indexer: candidate.indexer,
              protocol: candidate.protocol,
              downloadUrl: candidate.downloadUrl ?? undefined,
              magnetUrl: candidate.magnetUrl ?? undefined,
              infoHash: candidate.infoHash ?? undefined,
            },
            { indexerOrigins: arrIndexerOrigins }
          );
        } catch (e) {
          throw isUnusableLink(e) ? new ReleaseProblem(message(e)) : e;
        }
      }
    );
  }

  /**
   * Gets a magnet's file list via the torrent client, which fetches it from
   * the swarm (qBittorrent stops there itself; others are throttled where
   * possible and removed within seconds), then removes the torrent.
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
    try {
      if (!already) {
        await torrents.ensureCategory(category);
        await torrents.addTorrent({
          magnet: uri,
          hash,
          category,
          metadataOnly: true,
        });
      }
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

  /** A magnet's file list once the swarm sends it; empty after a timeout. */
  private async fileListOf(torrents: TorrentClient, hash: string) {
    const until = Date.now() + METADATA_WAIT_MS;
    for (;;) {
      const files = await torrents.getFiles(hash);
      if (files.length || Date.now() >= until) return files;
      await sleep(3000);
    }
  }

  /**
   * Removes magnet probes orphaned by a restart. Only torrents in Backfill's
   * category that downloaded nothing, belong to no download, aren't being
   * read now, and are old enough to be orphaned.
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
      [
        ...(await getRepository(BackfillJob).find({
          select: { downloadId: true },
          where: { protocol: 'torrent', downloadId: Not(IsNull()) },
        })),
        // Album song fetches share the category (lib/music/songFetch).
        ...(await getRepository(SongFetch).find({
          select: { id: true, downloadId: true },
          where: { downloadId: Not(IsNull()) },
        })),
      ].map((j) => j.downloadId!.toLowerCase())
    );
    let removed = 0;
    for (const t of torrents) {
      const hash = t.hash.toLowerCase();
      if (
        owned.has(hash) ||
        this.probing.has(hash) ||
        t.progress > 0 ||
        // Unknown add time: never treated as a probe.
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
   * Runs `fn` with exclusive access to jobs: no tick or other job change
   * runs meanwhile; a tick due then is skipped until next minute.
   */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.ticking) await this.ticked;
    this.ticking = true;
    let settle!: () => void;
    this.ticked = new Promise<void>((resolve) => (settle = resolve));
    try {
      return await fn();
    } finally {
      this.ticking = false;
      settle();
    }
  }

  /**
   * Adds files to a running download of the same release, since a torrent
   * can't be added twice. Only while queued or downloading; once importing,
   * the release can be taken again as a new download.
   */
  public async extendJob(
    jobId: number,
    entries: PlanEntry[],
    by: string
  ): Promise<BackfillJob> {
    try {
      // A concurrent tick save would drop the files added here.
      return await this.exclusive(async () => {
        const jobs = getRepository(BackfillJob);
        const job = await jobs.findOneOrFail({ where: { id: jobId } });
        if (job.status !== 'queued' && job.status !== 'downloading') {
          throw new Error(
            `Backfill #${job.id} is ${job.status} now; once it is done, this release can be taken again.`
          );
        }
        // By path: once chosen, a job's file indexes are the client's,
        // which can differ from the pack's.
        const have = new Set(job.files.map((f) => f.path));
        let added = entries.filter((e) => !have.has(e.path));
        if (!added.length) {
          throw new Error(`Backfill #${job.id} already has these files.`);
        }
        // If the torrent's files are already chosen, select these too; one
        // still choosing picks them up from the job's files.
        const chosen =
          job.status === 'downloading' &&
          job.protocol === 'torrent' &&
          job.downloadId &&
          job.stage !== 'Choosing files' &&
          job.stage !== "Waiting for the torrent's file list";
        const torrents = chosen
          ? torrentClientFor(this.clientById(job.clientId))
          : undefined;
        if (torrents) {
          const at = placeFiles(
            added,
            await torrents.getFiles(job.downloadId!)
          );
          const lost = added.find((_, i) => at[i] === undefined);
          if (lost) {
            throw new Error(
              `The torrent's files are not the ones checked (${baseName(lost.path)}).`
            );
          }
          added = added.map((e, i) => ({ ...e, index: at[i]! }));
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
        if (torrents) {
          await torrents.setFilePriority(
            job.downloadId!,
            added.map((e) => e.index),
            1
          );
          await torrents.startTorrent(job.downloadId!);
        }
        return job;
      });
    } finally {
      await this.publishDownloads();
    }
  }

  public async approve(
    candidateId: number,
    options: {
      mode: 'missing' | 'all';
      user?: User;
      includeAi?: boolean;
      /** Approver name when not a person: "AI agent". */
      by?: string;
      /** The admin agent conversation taking it. */
      agentRunId?: number;
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
    // The plan is as old as the search: a file may have arrived since, and
    // importing over it would replace a file nobody agreed to replace.
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
    // An album plan is for one edition. If Lidarr has since imported files
    // into another, importing here would switch editions and unlink them.
    if (row.kind === 'album' && [...now.values()].some(Boolean)) {
      const monitored = (
        await this.lidarrFor(row.serverId).getAlbumDetail(row.arrId)
      ).releases?.find((r) => r.monitored)?.id;
      if (
        monitored != null &&
        selected.some((e) => e.releaseId != null && e.releaseId !== monitored)
      ) {
        throw new Error(
          'Lidarr has files in another edition of this album now. Search again for an up-to-date plan.'
        );
      }
    }
    // A series may run several downloads for different episodes; a movie
    // only one.
    const jobs = getRepository(BackfillJob);
    let leftOut = '';
    const running = await jobs.find({
      where: {
        seriesId: candidate.seriesId,
        status: In([...ACTIVE, 'paused']),
      },
    });
    // Albums too: two at once could target different editions.
    if (running.length && (row.kind === 'movie' || row.kind === 'album')) {
      throw new Error('This title already has a backfill running.');
    }
    const taken = new Map<number, BackfillJob>();
    for (const other of running) {
      for (const file of other.files) {
        for (const id of file.episodeIds) taken.set(id, other);
      }
    }
    // Leave out what another download is already fetching.
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
    // The approver: the person, what approved for them ("Sam (API key)",
    // "AI agent"), or Backfill itself.
    const who = options.by ?? options.user?.displayName ?? AUTO_APPROVED;
    // Claim only if still ready, so of two concurrent approvals (two
    // admins, or an admin and auto-approve) only one starts a download.
    const claimed = await candidates.update(
      { id: candidate.id, status: 'ready' },
      // The reason it waited for an admin no longer applies.
      { status: 'approved', reason: null }
    );
    if (!claimed.affected) {
      throw new Error('This pack is not waiting for approval.');
    }
    const job = await jobs
      .save(
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
          agentRunId: options.agentRunId ?? null,
        })
      )
      .catch(async (e) => {
        await candidates.update(candidate.id, { status: 'ready' });
        throw e;
      });
    await this.linkReplacement(job);
    await getRepository(BackfillSeries).update(candidate.seriesId, {
      status: 'downloading',
    });
    try {
      await this.start(job);
    } catch (e) {
      // Same wording as the tick, so later retries collapse into one line.
      logger.warn('Backfill could not start a download yet', {
        label: LABEL,
        jobId: job.id,
        errorMessage: message(e),
      });
      this.note(job, 'warn', plainProblem(e));
      // Only if still queued: a tick may have started it, or an admin ended
      // it, since.
      await jobs.update(
        { id: job.id, status: 'queued' },
        { log: job.log, stage: job.stage }
      );
    }
    await this.publishDownloads();
    return job;
  }

  /**
   * Marks failed downloads of the same title from the last week, still
   * awaiting follow-up, as replaced by this job if it covers any of their
   * episodes, whoever started it (Backfill, an admin, the admin agent).
   */
  private async linkReplacement(job: BackfillJob): Promise<void> {
    const jobs = getRepository(BackfillJob);
    const wanted = new Set(jobEpisodes(job));
    const failed = await jobs.find({
      select: { id: true, files: true },
      where: {
        seriesId: job.seriesId,
        status: 'failed',
        id: Not(job.id),
        replacedById: IsNull(),
        followUp: Not(IsNull()),
        finishedAt: MoreThan(new Date(Date.now() - 7 * 24 * 60 * 60_000)),
      },
    });
    for (const old of failed) {
      if (!jobEpisodes(old).some((id) => wanted.has(id))) continue;
      await jobs.update(
        { id: old.id, replacedById: IsNull() },
        { followUp: 'replaced', replacedById: job.id }
      );
    }
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

  /** The title's destination folder, for the free-space check. */
  private async pathOf(row: BackfillSeries): Promise<string> {
    if (row.kind === 'album') {
      const lidarr = this.lidarrFor(row.serverId);
      const album = await lidarr.getAlbumDetail(row.arrId);
      return (await lidarr.getArtistDetail(album.artistId)).path ?? '';
    }
    return row.kind === 'movie'
      ? (await this.radarrFor(row.serverId).getMovieDetail(row.arrId)).path
      : (await this.sonarrFor(row.serverId).getSeriesDetail(row.arrId)).path;
  }

  /**
   * Each episode's (or the movie's) current file id, 0 for none, and how
   * many are still missing.
   */
  private async onDisk(
    row: BackfillSeries
  ): Promise<{ files: Map<number, number>; missing: number }> {
    if (row.kind === 'album') {
      // Tracks of the monitored edition; importing into another edition
      // makes that one monitored.
      const tracks = await this.lidarrFor(row.serverId).getAlbumTracks(
        row.arrId
      );
      return {
        files: new Map(
          tracks.map((t) => [t.id, t.hasFile ? (t.trackFileId ?? 0) : 0])
        ),
        missing: tracks.filter((t) => !t.hasFile).length,
      };
    }
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

  /**
   * Adds a line to a job's activity. A repeat of the last line bumps its
   * count and lastAt instead.
   */
  private note(job: BackfillJob, kind: BackfillLogLine['kind'], text: string) {
    const at = new Date().toISOString();
    const last = job.log?.at(-1);
    if (last && last.message === text && last.kind === kind) {
      job.log = [
        ...job.log.slice(0, -1),
        { ...last, count: (last.count ?? 1) + 1, lastAt: at },
      ];
      return;
    }
    job.log = [...(job.log ?? []), { at, kind, message: text }].slice(
      -MAX_LOG_LINES
    );
  }

  /** Adds an approved job's download, if there is room for it. */
  private async start(job: BackfillJob): Promise<void> {
    // Approval and a tick may start the same job at once.
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
    const candidate = await getRepository(BackfillCandidate).findOneOrFail({
      where: { id: job.candidateId ?? -1 },
    });
    const indexer = { id: candidate.indexerId, name: candidate.indexer };
    // A limit wait saved on the job survives restarts.
    const kept = job.indexerWait;
    if (kept && Date.parse(kept.until) > Date.now()) {
      indexerLimits.restore(
        indexer,
        'download',
        Date.parse(kept.until),
        kept.strikes
      );
    }
    // While the indexer waits out its limit, so does the job.
    const waiting = indexerLimits.waiting(indexer);
    if (waiting) {
      await this.waitOutLimit(job, waiting, candidate.indexerId);
      return;
    }
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: job.seriesId },
    });
    // The limit is per protocol (torrent and Usenet don't share bandwidth)
    // and per kind; imports are the arr's work and don't count.
    const limit =
      row.kind === 'movie'
        ? settings.maxMovieJobs
        : row.kind === 'album'
          ? settings.maxMusicJobs
          : settings.maxActiveJobs;
    const running = await jobs.count({
      where: {
        id: Not(job.id),
        status: 'downloading',
        protocol: job.protocol,
        series: { kind: row.kind },
      },
    });
    if (running >= limit) {
      job.stage = `Waiting for one of ${limit} running ${
        job.protocol === 'torrent' ? 'torrent' : 'Usenet'
      } ${
        row.kind === 'movie'
          ? 'movie'
          : row.kind === 'album'
            ? 'music'
            : 'series'
      } downloads to finish`;
      await jobs.save(job);
      return;
    }
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

    const client = this.clientById(job.clientId);
    let fetched: FetchedRelease;
    try {
      fetched = await this.fetch(candidate);
    } catch (e) {
      if (e instanceof IndexerLimitReached) {
        await this.waitOutLimit(job, e, candidate.indexerId);
        return;
      }
      logger.warn('Backfill could not fetch a release from its indexer', {
        label: LABEL,
        jobId: job.id,
        indexer: candidate.indexer,
        errorMessage: message(e),
      });
      // 404/410: the release is gone, not Prowlarr.
      const status = requestOf(e)?.status ?? 0;
      if ([404, 410].includes(status)) {
        throw new ReleaseProblem(`${candidate.indexer} no longer has it.`);
      }
      throw status === 401 || status === 403
        ? new SaidPlainly(plainProblem(e, candidate.indexer), { cause: e })
        : e;
    }
    if (job.indexerWait) job.indexerWait = null;
    let torrents: TorrentClient | undefined;
    if (job.protocol === 'torrent') {
      torrents = torrentClientFor(client);
      await torrents.ensureCategory(settings.category);
      if (fetched.kind === 'nzb') {
        throw new ReleaseProblem('Expected a torrent, got an NZB.');
      }
      let hash: string | undefined;
      try {
        hash =
          fetched.kind === 'torrent'
            ? parseTorrent(fetched.data).infoHash
            : magnetHash(fetched.uri);
      } catch (e) {
        throw new ReleaseProblem(message(e));
      }
      if (!hash) throw new ReleaseProblem('The torrent has no info hash.');
      if (await torrents.findTorrent(hash)) {
        // Take over Backfill's own torrent (from an earlier start attempt
        // whose answer was lost, or a leftover probe). Anything else is
        // someone else's; removing it later would delete their files.
        if (!(await this.unowned(torrents, hash, settings.category, job.id))) {
          throw new Error(`The torrent is already in ${client.name}.`);
        }
        this.note(job, 'info', `Took on the torrent already in ${client.name}`);
      } else {
        await torrents.addTorrent(
          fetched.kind === 'torrent'
            ? { torrent: fetched.data, hash, category: settings.category }
            : // A magnet fetches its file list from the swarm, then stops.
              {
                magnet: fetched.uri,
                hash,
                category: settings.category,
                metadataOnly: true,
              }
        );
        this.note(job, 'info', `Added to ${client.name}`);
      }
      job.downloadId = hash;
      job.stage = 'Choosing files';
    } else {
      if (fetched.kind !== 'nzb') throw new ReleaseProblem('Expected an NZB.');
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
      // A client that doesn't stop at metadata is watched now, so files are
      // chosen within seconds.
      if (fetched.kind === 'magnet' && !torrents.stopsAtMetadata) {
        await this.fileListOf(torrents, job.downloadId!);
      }
      await this.pickFiles(job);
    }
  }

  /**
   * The indexer hit its download limit: the job stays queued, says so, and
   * isn't retried before the reset (see indexerLimit). After a day it gives
   * up, leaving the pack for an admin.
   */
  private async waitOutLimit(
    job: BackfillJob,
    limit: IndexerLimitReached,
    indexerId: number
  ): Promise<void> {
    const now = Date.now();
    const since = job.indexerWait ? Date.parse(job.indexerWait.since) : now;
    if (now - since > LIMIT_GIVE_UP_MS) {
      job.indexerWait = null;
      await this.fail(
        job,
        `${limit.indexer} has been at its download limit for over a day, so Backfill stopped trying`,
        { releaseAtFault: false }
      );
      return;
    }
    job.indexerWait = {
      indexer: limit.indexer,
      indexerId,
      since: new Date(since).toISOString(),
      until: limit.until.toISOString(),
      strikes: limit.strikes,
    };
    job.stage = limit.message;
    // Log only actual tries; the stage shows the waiting.
    if (limit.asked) {
      this.note(job, 'warn', limit.message);
      logger.info('An indexer has reached its download limit', {
        label: LABEL,
        jobId: job.id,
        indexer: limit.indexer,
        until: limit.until.toISOString(),
      });
    }
    await getRepository(BackfillJob).save(job);
  }

  /**
   * Whether a torrent with this hash is Backfill's and unclaimed: in
   * Backfill's category, not a magnet being probed, and no other Backfill
   * download, running or finished, uses it. A failed download of it doesn't
   * count, so re-approving the release reuses what it fetched.
   */
  private async unowned(
    torrents: TorrentClient,
    hash: string,
    category: string,
    jobId: number
  ): Promise<boolean> {
    const id = hash.toLowerCase();
    if (this.probing.has(id) || this.probing.has(hash)) return false;
    const mine = (await torrents.listCategory(category)).some(
      (t) => t.hash.toLowerCase() === id
    );
    if (!mine) return false;
    const owners = await getRepository(BackfillJob).find({
      select: { downloadId: true, status: true },
      where: {
        id: Not(jobId),
        protocol: 'torrent',
        downloadId: Not(IsNull()),
      },
    });
    if (
      owners.some(
        (other) =>
          other.downloadId!.toLowerCase() === id && other.status !== 'failed'
      )
    ) {
      return false;
    }
    // Album song fetches share the category (lib/music/songFetch); a
    // running fetch owns its torrent.
    const songFetches = await getRepository(SongFetch).find({
      select: { id: true, downloadId: true },
      where: {
        downloadId: Not(IsNull()),
        status: In(['queued', 'searching', 'downloading', 'importing']),
      },
    });
    return !songFetches.some((f) => f.downloadId!.toLowerCase() === id);
  }

  /** Skips all but the chosen files, then starts the torrent. */
  private async pickFiles(job: BackfillJob): Promise<boolean> {
    const torrents = torrentClientFor(this.clientById(job.clientId));
    const files = await torrents.getFiles(job.downloadId!);
    if (!files.length) {
      job.stage = "Waiting for the torrent's file list";
      await getRepository(BackfillJob).save(job);
      return false;
    }
    // From here on the job's file indexes are the client's.
    const at = placeFiles(job.files, files);
    const mismatch = job.files.find((_, i) => at[i] === undefined);
    if (mismatch) {
      throw new ReleaseProblem(
        `The torrent's files are not the ones checked (${baseName(mismatch.path)}).`
      );
    }
    job.files = job.files.map((f, i) => ({ ...f, index: at[i]! }));
    const wanted = new Set(job.files.map((f) => f.index));
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

  /** Runs every minute: advances each active job. */
  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    // Search Right After: requested titles the arrs found nothing for.
    if (
      getSettings().backfill.searchAfterArr &&
      Date.now() - this.quickScannedAt >= QUICK_SCAN_EVERY_MS &&
      !this.scanning
    ) {
      this.quickScannedAt = Date.now();
      void this.scan({ quick: true });
    }
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
          await this.stumbled(job, e).catch((e2) =>
            logger.error(
              'Backfill could not record a problem with a download',
              {
                label: LABEL,
                jobId: job.id,
                errorMessage: message(e2),
              }
            )
          );
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
    } catch (e) {
      // E.g. the database not answering; retried next minute.
      logger.error('Backfill could not follow its downloads', {
        label: LABEL,
        errorMessage: message(e),
      });
    } finally {
      await this.publishDownloads();
      this.ticking = false;
      settle();
    }
  }

  /**
   * Handles a failed tick for a job. An unreachable arr or download client
   * is waited out indefinitely and logged once on the job. Anything else
   * counts; ten in a row fail the job.
   */
  private async stumbled(job: BackfillJob, e: unknown): Promise<void> {
    // Plain words on the job, the raw error in the server log. Unreachable
    // apps retry each minute, so they log at debug only.
    const said = plainProblem(e);
    logger[isUnreachable(e) ? 'debug' : 'warn'](
      'Backfill ran into a problem with a download',
      { label: LABEL, jobId: job.id, errorMessage: message(e) }
    );
    if (isUnreachable(e)) {
      const waiting = `${said}; trying again each minute`;
      if (job.log?.at(-1)?.message !== waiting) {
        this.note(job, 'warn', waiting);
      }
      // Unreachable time doesn't count as stalled.
      this.watch.forget(job.id);
      await getRepository(BackfillJob).save(job);
      return;
    }
    const count = (this.failures.get(job.id) ?? 0) + 1;
    this.failures.set(job.id, count);
    this.note(job, 'warn', said);
    if (count >= 10) {
      this.failures.delete(job.id);
      await this.fail(job, said, {
        releaseAtFault: e instanceof ReleaseProblem,
      });
    } else {
      await getRepository(BackfillJob).save(job);
    }
  }

  /**
   * Publishes Backfill's downloads and recent imports to the download
   * tracker, so pages show them like arr downloads, one item per episode.
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
      // Imports show as being added to the library until the media server
      // lists them.
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
    const files = await torrents.getFiles(job.downloadId!);
    const { have, complete, ...measured } = measureTorrent(job, torrent, files);
    Object.assign(job, measured, { size: measured.size || job.size });
    if (complete && torrent.state === 'moving') {
      // Being moved out of an "incomplete" folder; import after.
      job.stage = `${torrent.name} is being moved to its folder`;
      await getRepository(BackfillJob).save(job);
      return false;
    }
    if (complete) {
      await torrents.stopTorrent(job.downloadId!).catch(() => undefined);
      job.progress = 100;
      job.sizeLeft = 0;
      this.watch.forget(job.id);
    } else {
      const { stage, held } = torrentStage(torrent, torrents.product);
      job.stage = stage;
      const wanted = new Set(job.files.map((f) => f.index));
      const { stallHours, slowHours } = getSettings().backfill;
      const giveUp = this.watch.check(
        job.id,
        {
          have,
          left: measured.sizeLeft,
          held,
          incomplete: swarmLacks(
            torrent,
            files.filter((f) => wanted.has(f.index))
          ),
        },
        { stallHours, slowHours }
      );
      if (giveUp) {
        await this.fail(job, giveUp);
        return false;
      }
    }
    await getRepository(BackfillJob).save(job);
    return complete;
  }

  /** The Usenet client's folder for the job once finished, else false. */
  private async followNzb(job: BackfillJob): Promise<string | false> {
    const usenet = usenetClientFor(this.clientById(job.clientId));
    const nzbJob = await usenet.getJob(job.downloadId!);
    if (!nzbJob) throw new Error(`The job is no longer in ${usenet.product}.`);
    Object.assign(job, this.paced(job.id, measureNzb(nzbJob), nzbJob.speed), {
      size: nzbJob.size || job.size,
    });
    job.stage = usenetStage(nzbJob, usenet.product);
    if (nzbJob.place === 'history') {
      this.nzbPace.delete(job.id);
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

  /** A client path as the arr sees it. */
  private async arrPath(
    arr: Arr,
    client: DownloadClientSettings,
    path: string
  ): Promise<string> {
    return mapRemotePath(
      path,
      client.hostname,
      await arr.getRemotePathMappings()
    );
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
        // A name escaping the torrent's folder would make the arr import a
        // file from elsewhere on its disk.
        if (there && escapesFolder(there.name)) {
          file.note = 'The torrent names files outside its own folder.';
          continue;
        }
        if (there) {
          const inside = there.name.replace(/[\\/]/g, sep);
          paths.set(
            file.index,
            await this.arrPath(arr, client, `${save}${sep}${inside}`)
          );
        }
      }
    } else {
      const there = await this.arrPath(arr, client, folder);
      const seen =
        arr instanceof BackfillLidarr
          ? await arr.getFolderFiles(there, row.artistArrId ?? undefined)
          : await arr.getFolderFiles(there);
      for (const file of job.files) {
        if (file.whole) {
          // Grabbed whole (archives or scrambled names): take its one
          // video, whatever its name. With several, the episode is unknown.
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
        arr instanceof BackfillLidarr
          ? await arr.importAlbumFiles(
              batch.map((file) => ({
                path: file.path,
                artistId: row.artistArrId!,
                albumId: row.arrId,
                albumReleaseId: file.releaseId!,
                trackIds: file.episodeIds,
                quality: file.quality!,
              }))
            )
          : arr instanceof BackfillRadarr
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
    // A command the app no longer knows (restarted or cleared) is over.
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

  /** Verifies what the arr imported, cleans up, and reports. */
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
      // Leave rejected files for an admin to import by hand.
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
    // Other packs were judged against the old files; once some landed,
    // what they would fill or replace has changed.
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
    // Still missing some: search again against the current files.
    if (stale && missing) this.startSearch(row.id);
  }

  /**
   * Whether Backfill may take a pack without an admin: it fills something,
   * replaces nothing, has no AI-only matches, isn't an unseeded torrent, is
   * within size limits, and meets auto-approve's score and size. With
   * `wanted` (a failed download's episodes), it must fill one of them.
   */
  private takesItself(
    pack: {
      plan: PlanEntry[];
      summary: PlanSummary;
      protocol?: string;
      seeders?: number | null;
    },
    wanted?: Set<number>
  ): boolean {
    const auto = getSettings().backfill.autoApprove;
    const fills = pack.plan.filter((e) => e.action === 'fill');
    return (
      pack.summary.fill > 0 &&
      !unseeded(pack) &&
      !pack.summary.outsideSize &&
      pack.summary.replaces === 0 &&
      pack.summary.score >= auto.minScore &&
      pack.summary.fillBytes <= auto.maxSizeGb * 1024 ** 3 &&
      // AI matches are never taken without an admin seeing them.
      !fills.some((e) => e.matchedBy === 'ai') &&
      (!wanted || fills.some((e) => e.episodeIds.some((id) => wanted.has(id))))
    );
  }

  /**
   * Fails a job. The download is removed only when the release is at fault
   * (stalled, no file list, the client couldn't finish) and its chosen
   * files aren't all in; the release is then marked dead and another
   * offered. Otherwise the download is kept: if finished (or unknown), for
   * an admin to import by hand; if unfinished, stopped in the client, with
   * the pack offered again.
   */
  private async fail(
    job: BackfillJob,
    reason: string,
    { releaseAtFault = true }: { releaseAtFault?: boolean } = {}
  ): Promise<void> {
    job.status = 'failed';
    job.error = reason;
    job.stage = null;
    job.finishedAt = new Date();
    this.note(job, 'error', reason);
    await getRepository(BackfillJob).save(job);
    const complete = await this.downloaded(job);
    if (complete !== false) {
      this.note(
        job,
        'warn',
        complete
          ? 'Kept the download: its files are all in, to be imported by hand'
          : 'Kept the download: the client could not be asked whether it is finished'
      );
      await getRepository(BackfillJob).save(job);
    } else if (!releaseAtFault) {
      // A job that never reached the client has nothing to keep.
      if (job.downloadId) {
        await this.stopDownload(job).catch(() => undefined);
        this.note(
          job,
          'warn',
          'Kept what was downloaded, stopped in the client'
        );
        await getRepository(BackfillJob).save(job);
      }
    } else {
      await this.removeDownload(job).catch(() => undefined);
    }
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: job.seriesId },
    });
    // Never reached the client: the pack waits for an admin for a day
    // (see startFailures).
    const notStarted = !job.startedAt && !job.downloadId;
    const { outcome, stopped }: { outcome: string; stopped?: string } =
      releaseAtFault
        ? await this.offerNext(row, job)
        : { outcome: await this.offerAgain(row, job, notStarted) };
    // A replacement search, or the admin agent, reports the outcome itself.
    if (outcome !== 'searching' && outcome !== 'agent') {
      const why = reason.replace(/\.$/, '');
      backfillNotices.add({
        kind: outcome === 'replaced' ? 'replaced' : 'failed',
        seriesId: row.id,
        title: row.title,
        poster: row.poster,
        what: jobWhat(row, job),
        detail: stopped
          ? `${why}. ${stopped}`
          : notStarted && outcome === 'offered'
            ? `${why}. It never started, so Backfill will not take the pack by itself for a day: approve it by hand once that is put right`
            : reason,
        url: `/backfill/jobs/${job.id}`,
      });
    }
  }

  /**
   * Records a failed download's follow-up once the replacement search ends,
   * unless something replaced it meanwhile.
   */
  private async settleFailed(
    jobId: number,
    followUp: 'offered' | 'none'
  ): Promise<void> {
    await getRepository(BackfillJob).update(
      { id: jobId, followUp: 'searching', replacedById: IsNull() },
      { followUp }
    );
  }

  /**
   * Hands a failed agent-started download back to the agent. Null if not
   * the agent's, or the agent can't take it.
   */
  private async agentHandBack(job: BackfillJob): Promise<AgentHandBack> {
    if (!this.onAgentDownloadFailed || !startedByAgent(job)) return null;
    try {
      return await this.onAgentDownloadFailed(job);
    } catch (e) {
      logger.warn('Could not hand a failed download back to the admin agent', {
        label: LABEL,
        jobId: job.id,
        errorMessage: message(e),
      });
      return null;
    }
  }

  /**
   * A lookup for packs whose download failed to start in the last day,
   * matched by id or by name (a new search re-finds the release as a new
   * pack). Returns the held reason, or undefined if not held.
   */
  private async startFailures(
    seriesId: number
  ): Promise<(pack: { id?: number; title: string }) => string | undefined> {
    const failed = await getRepository(BackfillJob).find({
      select: { candidateId: true, title: true, error: true },
      where: {
        seriesId,
        status: 'failed',
        startedAt: IsNull(),
        finishedAt: MoreThan(new Date(Date.now() - START_FAILED_HOLD_MS)),
      },
      order: { finishedAt: 'DESC' },
    });
    return (pack) => {
      const last = failed.find(
        (j) =>
          (pack.id !== undefined && j.candidateId === pack.id) ||
          j.title === pack.title
      );
      return last ? heldReason(last.error) : undefined;
    };
  }

  /** Count of other active downloads for a title. */
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
   * After a failure, marks the release dead and auto-takes a good pack for
   * the same episodes (see takesItself), from the last search or a new one.
   * Repeats until no good pack is left, when the best is offered to an
   * admin, or until MAX_FAILED_PER_DAY fail in a day.
   */
  private async offerNext(
    row: BackfillSeries,
    job: BackfillJob
  ): Promise<{
    outcome: 'replaced' | 'searching' | 'agent' | 'offered' | 'none';
    /** Why the admin agent stopped looking, if it did. */
    stopped?: string;
  }> {
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
    let stopped: { followUp: 'gaveUp' | 'limit'; why: string } | undefined;
    if (getSettings().backfill.replaceFailed && wanted.size) {
      const failed = await getRepository(BackfillJob).count({
        where: {
          seriesId: row.id,
          status: 'failed',
          finishedAt: MoreThan(new Date(Date.now() - 24 * 60 * 60_000)),
        },
      });
      if (this.searching.has(row.id)) {
        // A running search re-judges the packs and offers what it finds.
        held = 'A search for this title is under way';
      } else if (failed >= MAX_FAILED_PER_DAY) {
        held = `${failed} downloads for this title failed in the last day, so the next is left for an admin`;
      } else {
        const notAgain = await this.startFailures(row.id);
        const pick = ranked.find(
          (c) =>
            this.takesItself(c, wanted) &&
            !multiMustWait(c, ranked) &&
            !notAgain(c)
        );
        if (pick) {
          try {
            const next = await this.approve(pick.id, {
              mode: 'missing',
              by: `Backfill (replacing #${job.id})`,
            });
            this.note(job, 'info', `Replaced by #${next.id}: ${pick.title}`);
            job.followUp = 'replaced';
            job.replacedById = next.id;
            await getRepository(BackfillJob).save(job);
            return { outcome: 'replaced' };
          } catch (e) {
            this.note(
              job,
              'warn',
              `Could not start ${pick.title}: ${message(e)}`
            );
          }
        }
        // An agent-started download goes back to the agent, which searches
        // the way it did before, where Backfill's own search found nothing.
        const handBack = await this.agentHandBack(job);
        if (handBack && 'look' in handBack) {
          this.note(
            job,
            'info',
            'Handed back to the admin agent, to look for another release'
          );
          job.followUp = 'agent';
          // Save first: whatever the agent starts links itself to this job,
          // and nothing here may overwrite that.
          await getRepository(BackfillJob).save(job);
          await handBack.look();
          return { outcome: 'agent' };
        }
        if (handBack) {
          stopped = { followUp: handBack.stopped, why: handBack.why };
          held = handBack.why;
        } else {
          this.note(job, 'info', 'Searching again for a replacement');
          job.followUp = 'searching';
          await getRepository(BackfillJob).save(job);
          this.startSearch(row.id, undefined, {
            replacing: [...wanted],
            failedJob: {
              id: job.id,
              what: jobWhat(row, job),
              reason: job.error ?? 'The download failed',
            },
          });
          return { outcome: 'searching' };
        }
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
    // The agent stopping matters most to an admin, even with a pack offered.
    job.followUp = stopped?.followUp ?? (next ? 'offered' : 'none');
    await getRepository(BackfillJob).save(job);
    return { outcome: next ? 'offered' : 'none', stopped: stopped?.why };
  }

  /**
   * After a failure not caused by the release, offers the pack again for
   * approval once the problem is fixed.
   */
  private async offerAgain(
    row: BackfillSeries,
    job: BackfillJob,
    byHand = false
  ): Promise<'offered' | 'none'> {
    const back = job.candidateId
      ? await getRepository(BackfillCandidate).update(
          { id: job.candidateId, status: 'approved' },
          { status: 'ready', reason: byHand ? heldReason(job.error) : null }
        )
      : undefined;
    const offered = !!back?.affected;
    job.followUp = offered ? 'offeredAgain' : 'none';
    const running = await this.othersRunning(row.id, job.id);
    await getRepository(BackfillSeries).update(
      { id: row.id, status: In(['downloading', 'found', 'none', 'stuck']) },
      { status: running ? 'downloading' : offered ? 'found' : 'none' }
    );
    if (offered) {
      this.note(
        job,
        'info',
        byHand
          ? 'The pack waits for an admin to approve it by hand, once that is put right'
          : 'The pack is offered again, to approve once that is put right'
      );
    }
    await getRepository(BackfillJob).save(job);
    return offered ? 'offered' : 'none';
  }

  /**
   * Whether a download's chosen files are all in; undefined if the client
   * can't be asked, so the download is kept rather than lost.
   */
  private async downloaded(job: BackfillJob): Promise<boolean | undefined> {
    if (!job.downloadId) return false;
    if (
      job.files.some((f) => f.state === 'importing' || f.state === 'imported')
    ) {
      return true;
    }
    try {
      const client = this.clientById(job.clientId);
      if (job.protocol === 'torrent') {
        const torrents = torrentClientFor(client);
        const torrent = await torrents.findTorrent(job.downloadId);
        if (!torrent) return false;
        return measureTorrent(
          job,
          torrent,
          await torrents.getFiles(job.downloadId)
        ).complete;
      }
      const nzbJob = await usenetClientFor(client).getJob(job.downloadId);
      return nzbJob?.place === 'history' && /^completed$/i.test(nzbJob.status);
    } catch {
      return undefined;
    }
  }

  /** Stops a download in its client, leaving it there. */
  private async stopDownload(job: BackfillJob): Promise<void> {
    if (!job.downloadId) return;
    const client = this.clientById(job.clientId);
    if (job.protocol === 'torrent') {
      await torrentClientFor(client).stopTorrent(job.downloadId);
    } else {
      await usenetClientFor(client).pauseJob(job.downloadId);
    }
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

  /**
   * Saves a job's status change only if it is still in a `from` status;
   * otherwise it changed meanwhile and this throws.
   */
  private async moveJob(
    job: BackfillJob,
    from: BackfillJob['status'][],
    change: Partial<BackfillJob>
  ): Promise<BackfillJob> {
    const jobs = getRepository(BackfillJob);
    const moved = await jobs.update(
      { id: job.id, status: In(from) },
      { ...change, log: job.log }
    );
    if (!moved.affected) {
      throw new Error('The job changed meanwhile; look again and retry.');
    }
    return jobs.findOneOrFail({ where: { id: job.id } });
  }

  public async pause(id: number): Promise<BackfillJob> {
    return this.exclusive(async () => {
      const job = await getRepository(BackfillJob).findOneOrFail({
        where: { id },
      });
      if (job.status !== 'downloading') {
        throw new Error('Only a download can be paused.');
      }
      await this.stopDownload(job);
      this.watch.forget(job.id);
      this.note(job, 'info', 'Paused');
      return this.moveJob(job, ['downloading'], { status: 'paused', speed: 0 });
    });
  }

  public async resume(id: number): Promise<BackfillJob> {
    return this.exclusive(async () => {
      const job = await getRepository(BackfillJob).findOneOrFail({
        where: { id },
      });
      if (job.status !== 'paused') throw new Error('The job is not paused.');
      const client = this.clientById(job.clientId);
      if (job.protocol === 'torrent') {
        await torrentClientFor(client).startTorrent(job.downloadId!);
      } else {
        await usenetClientFor(client).resumeJob(job.downloadId!);
      }
      this.watch.forget(job.id);
      this.note(job, 'info', 'Resumed');
      return this.moveJob(job, ['paused'], { status: 'downloading' });
    });
  }

  /** Stops a job and removes its download; imported files stay. */
  public async end(id: number, user?: User): Promise<BackfillJob> {
    // A running tick would overwrite the ending.
    const job = await this.exclusive(async () => {
      const job = await getRepository(BackfillJob).findOneOrFail({
        where: { id },
      });
      if (job.status === 'importing') {
        throw new Error(
          'Its files are being imported; it can be ended once that is done.'
        );
      }
      if (!['queued', 'downloading', 'paused'].includes(job.status)) {
        throw new Error('The job has already finished.');
      }
      // Mid-add from an approval: end it once it's in the client, so its
      // download is removed too.
      if (this.starting.has(job.id)) {
        throw new Error(
          'It is being added to the download client; try again in a moment.'
        );
      }
      await this.removeDownload(job).catch((e) =>
        this.note(job, 'warn', `Could not remove the download: ${message(e)}`)
      );
      this.note(job, 'info', `Ended by ${user?.displayName ?? 'an admin'}`);
      return this.moveJob(job, ['queued', 'downloading', 'paused'], {
        status: 'cancelled',
        stage: null,
        finishedAt: new Date(),
      });
    });
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
      row.kind === 'album'
        ? [
            s.fill
              ? `fills ${s.fill} missing track${s.fill === 1 ? '' : 's'}`
              : '',
            s.upgrade ? `upgrades ${s.upgrade}` : '',
          ].filter(Boolean)
        : row.kind === 'movie'
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
      // The title page's review, showing this pack.
      url: `/backfill/series/${row.id}?pack=${candidate.id}#review`,
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

  /** What keeps a Backfill client from working fully, if anything. */
  public clientProblems(client: DownloadClientSettings): Promise<string[]> {
    return downloadClientFor(client).backfillProblems();
  }

  /** The client's version, for the settings test. */
  public async testClient(id: number): Promise<string> {
    return downloadClientFor(this.clientById(id)).getVersion();
  }
}

const backfill = new Backfill();
export default backfill;
