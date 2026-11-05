import type { PlanSummary } from '@server/lib/backfill/plan';

/*
 * Backfill admin API response types (server/routes/backfill.ts). Import paths
 * and Prowlarr links stay server-side.
 */

export type TitleKind = 'series' | 'movie' | 'album';

export type SeriesStatus =
  | 'stuck'
  | 'searching'
  | 'found'
  | 'none'
  | 'downloading'
  | 'ignored'
  | 'done';

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'importing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface Readiness {
  ready: boolean;
  enabled: boolean;
  prowlarr: boolean;
  torrentClient?: string;
  usenetClient?: string;
  problem?: string;
  /** Backfill also handles albums. */
  music: boolean;
}

export interface SeriesView {
  id: number;
  kind: TitleKind;
  serverId: number;
  arrId: number;
  tvdbId: number | null;
  tmdbId: number | null;
  /** Album MusicBrainz id, for its page link. */
  foreignId?: string | null;
  artistName?: string | null;
  title: string;
  year: number | null;
  seriesType: string;
  poster: string | null;
  status: SeriesStatus;
  missing: number;
  belowCutoff: number;
  searchTerms: string[];
  lastArrSearchAt: string | null;
  lastSearchedAt: string | null;
  searchError: string | null;
  /** When the agent last ran unprompted; it does so once per title. */
  agentAutoRunAt?: string | null;
}

export interface EntryView {
  index: number;
  name: string;
  size: number;
  episodeIds: number[];
  absolute?: number;
  season?: number;
  episode?: number;
  quality?: string;
  version?: number;
  score: number;
  action: 'fill' | 'upgrade' | 'skip' | 'reject';
  reason?: string;
  replaces: number;
  /** `ai` when placed by the AI second opinion; `why` holds its reading. */
  matchedBy?: 'ai' | 'title';
  why?: string;
}

export interface CandidateView {
  id: number;
  seriesId: number;
  title: string;
  indexer: string;
  protocol: 'torrent' | 'usenet';
  size: number;
  seeders: number | null;
  publishDate: string | null;
  status: 'ready' | 'rejected' | 'approved' | 'skipped' | 'failed' | 'dead';
  reason: string | null;
  summary: PlanSummary | null;
  createdAt: string;
  plan?: EntryView[];
}

export interface LogLine {
  at: string;
  kind: 'info' | 'ok' | 'warn' | 'error';
  message: string;
  /** Repeat count and last time for a repeated line. */
  count?: number;
  lastAt?: string;
}

/**
 * A failed download's follow-up. The agent stops after three failed
 * replacements in a day or when its daily downloads are used up.
 */
export type JobFollowUp =
  | 'replaced'
  | 'searching'
  | 'agent'
  | 'offered'
  | 'offeredAgain'
  | 'none'
  | 'gaveUp'
  | 'limit';

export interface JobView {
  id: number;
  seriesId: number;
  candidateId: number | null;
  title: string;
  status: JobStatus;
  stage: string | null;
  mode: 'missing' | 'all';
  protocol: 'torrent' | 'usenet';
  progress: number;
  size: number;
  sizeLeft: number;
  speed: number;
  secondsLeft: number | null;
  imported: number;
  replaced: number;
  rejected: number;
  fileCount: number;
  error: string | null;
  /** Retry time while waiting on the indexer's download limit. */
  retryAt: string | null;
  approvedByName: string | null;
  /** After a failure: the follow-up and the replacing download. */
  followUp: JobFollowUp | null;
  replacedById: number | null;
  /** Agent run that started it. */
  agentRunId: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  files?: (EntryView & {
    state: 'waiting' | 'importing' | 'imported' | 'failed';
    note?: string;
  })[];
  log?: LogLine[];
  series?: SeriesView;
}

export interface SearchAllStatus {
  running: {
    total: number;
    done: number;
    found: number;
    current?: string;
    startedAt: string;
  } | null;
  last: {
    total: number;
    done: number;
    found: number;
    startedAt: string;
    finishedAt: string;
    stoppedBecause?: string;
  } | null;
}

export interface Overview {
  readiness: Readiness;
  scanning: boolean;
  searchAll: SearchAllStatus;
  stats: {
    stuck: number;
    missing: number;
    awaiting: number;
    filledThisWeek: number;
    filledTitles: string[];
  };
  counts: { all: number; found: number; ignored: number; done: number };
  series: (SeriesView & {
    best?: CandidateView;
    readyCount: number;
    job?: JobView;
  })[];
  jobs: (JobView & { series?: SeriesView })[];
  awaiting: (CandidateView & { series?: SeriesView })[];
}

/** Backfill lookup for one title's media page. */
export type TitleLookup = SeriesView & {
  readyCount: number;
  /** Agent run currently working on it. */
  workingRunId?: number | null;
  /** First of `jobs`. */
  job?: JobView;
  /** Running downloads, oldest first. */
  jobs: JobView[];
};

export interface CoverageEpisode {
  id: number;
  season: number;
  episode: number;
  absolute?: number;
  title?: string;
  airDate?: string;
  state: 'missing' | 'onDisk' | 'unaired' | 'unmonitored';
  quality?: string;
  score?: number;
  belowCutoff?: boolean;
}

export interface SeriesDetail {
  series: SeriesView;
  readiness: Readiness;
  sonarr?: {
    title: string;
    year: number;
    seriesType: string;
    profile: string;
    minFormatScore: number;
    names: string[];
    coverage: CoverageEpisode[];
  };
  movie?: {
    title: string;
    year: number;
    profile: string;
    minFormatScore: number;
    names: string[];
    available: boolean;
    file?: { quality: string; score?: number; belowCutoff?: boolean };
  };
  album?: {
    title: string;
    artist: string;
    profile: string;
    minFormatScore: number;
    names: string[];
    tracks: {
      id: number;
      number?: number;
      title: string;
      state: 'missing' | 'onDisk';
      quality?: string;
    }[];
  };
  arrError?: string;
  candidates: CandidateView[];
  jobs: JobView[];
}

export const ACTIVE_JOB: JobStatus[] = [
  'queued',
  'downloading',
  'paused',
  'importing',
];
