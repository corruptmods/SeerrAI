import type { TorrentState } from '@server/api/downloadclients';
import {
  CLIENT_PRODUCTS,
  TORRENT_CLIENT_TYPES,
} from '@server/api/downloadclients';
import { MediaType } from '@server/constants/media';
import type BackfillJob from '@server/entity/BackfillJob';
import type {
  BackfillDownload,
  DownloadStage,
} from '@server/lib/downloadtracker';

/*
 * A Backfill download's state: the client's activity in words, progress over
 * the chosen files, and how the download tracker shows it beside Radarr's
 * and Sonarr's downloads.
 */

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
 * A job as download tracker items: what is still to come, or (imported)
 * what has arrived.
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
  if (row.kind === 'album') {
    if (imported && !(job.status === 'done' && job.imported > 0)) return [];
    // Music is tracked under its artist, each download naming its album.
    if (!row.artistArrId) return [];
    return [
      {
        kind: 'album',
        serverId: row.serverId,
        jobId: job.id,
        item: {
          ...base,
          mediaType: MediaType.MUSIC,
          externalId: row.artistArrId,
          size: job.size,
          sizeLeft: job.sizeLeft,
          album: {
            id: row.arrId,
            title: row.title,
            foreignAlbumId: row.foreignId ?? '',
          },
        },
      },
    ];
  }
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
  // One item per episode, with its share of what's left.
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

/** A running job's download tracker items. */
export const backfillDownloadsOf = (
  job: BackfillJob,
  now = Date.now()
): BackfillDownload[] => downloadsOf(job, false, now);

/** A job's imports: each episode, or the movie once done. */
export const backfillImportsOf = (
  job: BackfillJob,
  now = Date.now()
): BackfillDownload[] => downloadsOf(job, true, now);

/**
 * A Usenet download's activity in words: client status names ("Running",
 * "Extracting") mean little alone, and post-processing can take a while.
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
 * A torrent's activity in words, and whether the client is holding it
 * (paused, queued behind its download limit, checking, moving): held time
 * doesn't count as stalled.
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

/** The torrent stages above, which a live reading may replace. */
export const TORRENT_STAGES = new Set([
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

/** A download's progress, as its page shows it. */
export interface Progress {
  progress: number;
  size: number;
  sizeLeft: number;
  speed: number;
  secondsLeft: number | null;
  /** Live activity: downloading, or waiting for peers. */
  stage?: string;
}

/** A torrent's progress over the chosen files only. */
export const measureTorrent = (
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
    // The client's estimate, else what's left at the current speed.
    secondsLeft:
      torrent.secondsLeft ??
      (speed > 0 && sizeLeft > 0 ? Math.round(sizeLeft / speed) : null),
  };
};

export const measureNzb = (nzbJob: {
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
