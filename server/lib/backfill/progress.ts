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
 * Where a Backfill download stands: what its client says it is doing, in
 * words, how far along its chosen files are, and how the download tracker
 * shows it beside Radarr's and Sonarr's own downloads.
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
  if (row.kind === 'album') {
    if (imported && !(job.status === 'done' && job.imported > 0)) return [];
    // Music is followed by its artist, each download naming its album.
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
    // The client's own estimate, else what is left at today's speed.
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
