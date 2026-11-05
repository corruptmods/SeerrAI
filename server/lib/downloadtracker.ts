import type { LiveDownload } from '@server/api/downloadclients';
import { downloadClientFor } from '@server/api/downloadclients';
import type { ImportRecord } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type { DownloadStage, DownloadStep } from '@server/constants/downloads';
import { MediaType } from '@server/constants/media';
import { lidarrApi, musicReady } from '@server/lib/music/access';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

interface EpisodeNumberResult {
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number;
  id: number;
}
export type { DownloadStage, DownloadStep } from '@server/constants/downloads';

/**
 * A download Backfill (or the admin agent through it) runs outside Radarr's and
 * Sonarr's queues.
 */
export interface BackfillDownload {
  kind: 'movie' | 'series' | 'album';
  serverId: number;
  /** The Backfill job it is part of. */
  jobId: number;
  item: DownloadingItem;
}

const backfillKey = (d: BackfillDownload) =>
  `${d.jobId}|${d.item.episode?.id ?? ''}`;

export interface DownloadingItem {
  mediaType: MediaType;
  externalId: number;
  size: number;
  sizeLeft: number;
  /** Radarr's or Sonarr's raw status. */
  status: string;
  stage: DownloadStage;
  /** The download client's step within the stage, when read directly. */
  step?: DownloadStep;
  timeLeft: string;
  /** Only while there is something left to download. */
  estimatedCompletionTime?: Date;
  title: string;
  downloadId: string;
  episode?: EpisodeNumberResult;
  /** Music: the album it is for. `externalId` is then Lidarr's artist. */
  album?: { id: number; title: string; foreignAlbumId: string };
  /**
   * Song Fetch: MusicBrainz ids of the only recordings taken from the album.
   */
  songs?: string[];
  /**
   * Imported, but this media server matched it wrongly (or not at all) and
   * it awaits correction (lib/matchWatch).
   */
  matching?: string;
}

interface QueueFields {
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  size?: number;
  sizeleft?: number;
  estimatedCompletionTime?: string | null;
}

/** The stage of one Radarr or Sonarr queue item. */
export const downloadStageOf = (item: QueueFields): DownloadStage => {
  const status = (item.status ?? '').toLowerCase();
  const state = (item.trackedDownloadState ?? '').toLowerCase();
  const health = (item.trackedDownloadStatus ?? '').toLowerCase();
  const allIn = (item.size ?? 0) > 0 && !item.sizeleft;

  if (state === 'failedpending' || state === 'failed' || status === 'failed') {
    return 'failed';
  }
  // The client reports a problem mid-download (a stalled or errored
  // torrent): all that is certain is it isn't downloading.
  if (status === 'warning' && !allIn && state !== 'importblocked') {
    return 'stalled';
  }
  if (
    state === 'importblocked' ||
    health === 'warning' ||
    health === 'error' ||
    status === 'warning' ||
    status === 'downloadclientunavailable'
  ) {
    return 'needsAttention';
  }
  if (
    state === 'importpending' ||
    state === 'importing' ||
    state === 'imported' ||
    status === 'completed'
  ) {
    return 'importing';
  }
  if (status === 'delay') {
    return 'waiting';
  }
  if (status === 'paused') {
    return 'paused';
  }
  if (status === 'queued' || status === 'fallback') {
    // qBittorrent re-checking a finished torrent is reported as queued.
    return allIn ? 'finishing' : 'queued';
  }
  if (status === 'downloading' && allIn) {
    return 'finishing';
  }
  return 'downloading';
};

/**
 * Finish estimate, only while bytes are arriving or queued. After that
 * Radarr and Sonarr report "now" (an already-passed estimate), and for a
 * delay-profile hold they report when the hold ends.
 */
const estimateOf = (
  item: QueueFields,
  stage: DownloadStage
): Date | undefined => {
  if (
    (stage !== 'downloading' && stage !== 'queued') ||
    !item.estimatedCompletionTime
  ) {
    return undefined;
  }
  const at = new Date(item.estimatedCompletionTime);
  return Number.isNaN(at.getTime()) ? undefined : at;
};

/** A Radarr or Sonarr queue item as Seerr keeps it. */
const trackedItem = (
  item: QueueFields & {
    title: string;
    timeleft: string;
    downloadId: string;
    size: number;
    sizeleft: number;
  },
  mediaType: MediaType,
  externalId: number,
  episode?: EpisodeNumberResult,
  album?: DownloadingItem['album']
): DownloadingItem => {
  const stage = downloadStageOf(item);
  return {
    externalId,
    mediaType,
    size: item.size,
    sizeLeft: item.sizeleft,
    status: item.status ?? '',
    stage,
    timeLeft: item.timeleft,
    estimatedCompletionTime: estimateOf(item, stage),
    title: item.title,
    downloadId: item.downloadId,
    ...(episode ? { episode } : {}),
    ...(album ? { album } : {}),
  };
};

/**
 * Sonarr's queue without episodes a pack can't hold yet. Until a torrent's
 * file list is in, Sonarr lists a season pack under every episode, unaired
 * ones too, so ten would show downloading when four have aired. A single
 * episode's download is kept whatever its date, as is a pack with no aired
 * episodes.
 */
export const airedEpisodesOf = <
  T extends {
    downloadId?: string;
    episode?: { airDateUtc?: string | null };
  },
>(
  items: T[],
  now = Date.now()
): T[] => {
  const perRelease = new Map<string, number>();
  for (const item of items) {
    if (item.downloadId) {
      perRelease.set(
        item.downloadId,
        (perRelease.get(item.downloadId) ?? 0) + 1
      );
    }
  }
  const aired = (item: T) => {
    const at = item.episode?.airDateUtc
      ? Date.parse(item.episode.airDateUtc)
      : NaN;
    return !Number.isNaN(at) && at <= now;
  };
  const releasesWithAired = new Set(
    items.filter(aired).map((item) => item.downloadId)
  );
  return items.filter(
    (item) =>
      !item.downloadId ||
      (perRelease.get(item.downloadId) ?? 0) < 2 ||
      !releasesWithAired.has(item.downloadId) ||
      aired(item)
  );
};

const LIVE_REFRESH_MS = 5_000;

/**
 * A queue item updated from its download client. Radarr or Sonarr decides
 * delay holds, imports and failures; the client decides progress, time left
 * and current step.
 */
export const withLiveProgress = (
  item: DownloadingItem,
  live: LiveDownload | undefined,
  now = Date.now()
): DownloadingItem => {
  if (!live) {
    return item;
  }
  const arrDecides =
    item.stage === 'waiting' ||
    item.stage === 'importing' ||
    item.stage === 'failed' ||
    // Unless the only trouble is Radarr or Sonarr can't reach the client,
    // which Seerr just did.
    (item.stage === 'needsAttention' &&
      item.status.toLowerCase() !== 'downloadclientunavailable');
  const stage = arrDecides ? item.stage : live.stage;
  const known = live.size > 0;
  return {
    ...item,
    size: known ? live.size : item.size,
    sizeLeft: known ? live.sizeLeft : item.sizeLeft,
    stage,
    step: arrDecides ? undefined : live.step,
    estimatedCompletionTime:
      (stage === 'downloading' || stage === 'queued') && live.secondsLeft
        ? new Date(now + live.secondsLeft * 1000)
        : undefined,
  };
};

/** Queue read interval while someone watches, with download clients linked. */
const QUEUE_REFRESH_WITH_CLIENTS_MS = 30_000;

/**
 * Max time an imported download stays shown, awaiting the media server (usually
 * a minute or two).
 */
export const IMPORTED_HOLD_MS = 30 * 60_000;

/**
 * Delay before the post-import recently added scan, so titles show available
 * within a minute.
 */
export const IMPORTED_SCAN_DELAY_MS = 60_000;

/**
 * Tries of that scan, a minute apart, while an import is still unlisted.
 * The regular scan takes over after.
 */
export const IMPORTED_SCAN_TRIES = 4;

/**
 * An imported title a media server mismatched, awaiting correction. For
 * Lidarr, `externalId` is the artist and `albumId` the album.
 */
export interface MatchWait {
  kind: ImportedDownload['kind'];
  serverId: number;
  externalId: number;
  albumId?: number;
  mediaServer: string;
  title: string;
}

/**
 * How far before the last look history is read for imports, so one recorded
 * mid-read isn't missed. Seen imports are deduplicated by history id.
 */
const IMPORT_OVERLAP_MS = 60_000;

/** Stages from which leaving the queue means it was imported. */
const DONE_STAGES: DownloadStage[] = ['importing', 'finishing'];

/** A download that left the queue imported, held a while. */
export interface ImportedDownload {
  kind: 'movie' | 'series' | 'music';
  serverId: number;
  item: DownloadingItem;
  at: number;
}

const itemKey = (item: DownloadingItem) =>
  `${item.downloadId ?? ''}|${item.episode?.id ?? ''}|${item.album?.id ?? ''}|${
    item.externalId
  }`;

/** Same address means same server. */
const sameServer = (a: DVRSettings, b: DVRSettings) =>
  a.hostname === b.hostname && a.port === b.port && a.baseUrl === b.baseUrl;

/**
 * Whether a download that left the queue was imported, not removed: it was
 * importing or finishing, or had nothing left and hadn't failed.
 */
export const leftImported = (item: DownloadingItem): boolean =>
  DONE_STAGES.includes(item.stage) ||
  (item.sizeLeft <= 0 &&
    item.size > 0 &&
    !['failed', 'needsAttention', 'imported'].includes(item.stage));

class DownloadTracker {
  private radarrServers: Record<number, DownloadingItem[]> = {};
  private sonarrServers: Record<number, DownloadingItem[]> = {};
  private lidarrServers: Record<number, DownloadingItem[]> = {};
  /** Imported downloads still shown until the media server lists them. */
  private imported = new Map<string, ImportedDownload>();
  private onImport?: () => Promise<void> | void;
  private onImported?: (imported: ImportedDownload[]) => Promise<void> | void;
  private importTimer?: ReturnType<typeof setTimeout>;
  private matchWaits: MatchWait[] = [];

  /**
   * Callback for each import as soon as it is seen (new request match check).
   * Replaces any previous one.
   */
  public onEachImport(
    run: (imported: ImportedDownload[]) => Promise<void> | void
  ) {
    this.onImported = run;
  }

  /** Titles a media server has yet to match correctly (lib/matchWatch). */
  public setMatchWaits(waits: MatchWait[]) {
    this.matchWaits = waits;
  }

  /**
   * A mismatched import, once the import itself is no longer shown: still
   * being added to the library, awaiting the server.
   */
  private waitingFor(
    kind: ImportedDownload['kind'],
    serverId: number,
    externalId: number
  ): DownloadingItem[] {
    return this.matchWaits
      .filter(
        (w) =>
          w.kind === kind &&
          w.serverId === serverId &&
          w.externalId === externalId
      )
      .map((w) => ({
        mediaType:
          kind === 'movie'
            ? MediaType.MOVIE
            : kind === 'music'
              ? MediaType.MUSIC
              : MediaType.TV,
        externalId,
        // Fully downloaded: the rest is the server's part.
        size: 1,
        sizeLeft: 0,
        status: 'imported',
        stage: 'imported',
        timeLeft: '',
        title: w.title,
        downloadId: `match:${w.mediaServer}:${w.albumId ?? externalId}`,
        album: w.albumId
          ? { id: w.albumId, title: w.title, foreignAlbumId: '' }
          : undefined,
        matching: w.mediaServer,
      }));
  }

  /** What was imported for a title, or else what waits on its match. */
  private importedOrWaiting(
    kind: ImportedDownload['kind'],
    serverId: number,
    externalId: number
  ): DownloadingItem[] {
    const imported = this.importedFor(kind, serverId, externalId);
    // The held import shows instead; an album yields only to its own import.
    const waiting = this.waitingFor(kind, serverId, externalId).filter(
      (w) =>
        !imported.some((i) => kind !== 'music' || i.album?.id === w.album?.id)
    );
    return [...imported, ...waiting];
  }

  /**
   * Callback a minute after imports (the recently added scan), repeated each
   * minute while some is unlisted. Replaces any previous one.
   */
  public whenImported(run: () => Promise<void> | void) {
    this.onImport = run;
  }

  /**
   * Records queue items that left imported, for every server entry sharing that
   * queue.
   */
  private noteImported(
    kind: ImportedDownload['kind'],
    serverIds: number[],
    before: DownloadingItem[],
    after: DownloadingItem[],
    now = Date.now()
  ) {
    const still = new Set(after.map(itemKey));
    const imported: ImportedDownload[] = [];
    for (const item of before) {
      if (still.has(itemKey(item)) || !leftImported(item)) continue;
      for (const serverId of serverIds) {
        imported.push(this.hold(kind, serverId, item, now));
      }
    }
    if (imported.length) this.importedNow(imported);
  }

  /** Where each Radarr's and Sonarr's history was last read to. */
  private importMarks = new Map<string, { at: number; lastId: number }>();

  /**
   * Imports since the last look, from history. A fast download can be
   * grabbed and imported between queue reads without being seen leaving;
   * these are held too. Manual imports (no download id) are skipped:
   * Backfill holds its own.
   */
  private async noteImportedFromHistory(
    kind: 'movie' | 'series',
    api: RadarrAPI | SonarrAPI,
    markKey: string,
    serverIds: number[],
    queue: DownloadingItem[]
  ) {
    const startedAt = Date.now();
    const mark = this.importMarks.get(markKey);
    if (!mark) {
      // The first look only sets the mark.
      this.importMarks.set(markKey, { at: startedAt, lastId: 0 });
      return;
    }

    let records: ImportRecord[];
    try {
      records = await api.getImportsSince(
        new Date(mark.at - IMPORT_OVERLAP_MS)
      );
    } catch (e) {
      // Retry from the same mark next time.
      logger.debug('Could not read imports from history', {
        label: 'Download Tracker',
        server: markKey,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    this.importMarks.set(markKey, {
      at: startedAt,
      lastId: Math.max(mark.lastId, ...records.map((record) => record.id)),
    });

    const inQueue = new Set(queue.map(itemKey));
    const held: ImportedDownload[] = [];
    for (const record of records) {
      const externalId = kind === 'movie' ? record.movieId : record.seriesId;
      if (record.id <= mark.lastId || !record.downloadId || !externalId) {
        continue;
      }
      const size = Number(record.data?.size) || 0;
      const item: DownloadingItem = {
        mediaType: kind === 'movie' ? MediaType.MOVIE : MediaType.TV,
        externalId,
        size,
        sizeLeft: 0,
        status: 'completed',
        stage: 'imported',
        timeLeft: '',
        title: record.sourceTitle,
        downloadId: record.downloadId,
        ...(record.episode
          ? {
              episode: {
                id: record.episode.id,
                seasonNumber: record.episode.seasonNumber,
                episodeNumber: record.episode.episodeNumber,
                absoluteEpisodeNumber:
                  record.episode.absoluteEpisodeNumber ?? 0,
              },
            }
          : {}),
      };
      // Still queued, or already seen leaving.
      if (inQueue.has(itemKey(item))) continue;
      for (const serverId of serverIds) {
        if (!this.imported.has(`${kind}:${serverId}:${itemKey(item)}`)) {
          held.push(this.hold(kind, serverId, item, startedAt));
        }
      }
    }
    if (held.length) this.importedNow(held);
  }

  /** Shows a download as being added to the library until it is listed. */
  private hold(
    kind: ImportedDownload['kind'],
    serverId: number,
    item: DownloadingItem,
    now: number
  ): ImportedDownload {
    const held: ImportedDownload = {
      kind,
      serverId,
      at: now,
      item: {
        ...item,
        stage: 'imported',
        step: undefined,
        sizeLeft: 0,
        timeLeft: '',
        estimatedCompletionTime: undefined,
      },
    };
    this.imported.set(`${kind}:${serverId}:${itemKey(item)}`, held);
    return held;
  }

  private importedNow(imported: ImportedDownload[]) {
    // Several imports close together make one scan.
    if (this.onImport) this.scanSoon(1);
    if (this.onImported) {
      Promise.resolve()
        .then(() => this.onImported?.(imported))
        .catch((e) =>
          logger.warn('Could not note what was imported', {
            label: 'Download Tracker',
            errorMessage: e instanceof Error ? e.message : String(e),
          })
        );
    }
  }

  private scanSoon(attempt: number) {
    if (this.importTimer) clearTimeout(this.importTimer);
    this.importTimer = setTimeout(async () => {
      this.importTimer = undefined;
      try {
        await this.onImport?.();
      } catch {
        // The regular scan still runs.
      }
      // Not all listed yet: retry shortly.
      if (
        attempt < IMPORTED_SCAN_TRIES &&
        !this.importTimer &&
        this.isHoldingImports()
      ) {
        this.scanSoon(attempt + 1);
      }
    }, IMPORTED_SCAN_DELAY_MS);
    this.importTimer.unref?.();
  }

  /** Whether any imported download is still awaiting listing. */
  private isHoldingImports(now = Date.now()): boolean {
    for (const [key, held] of this.imported) {
      if (now - held.at > IMPORTED_HOLD_MS) {
        this.imported.delete(key);
      } else {
        return true;
      }
    }
    return false;
  }

  private importedFor(
    kind: ImportedDownload['kind'],
    serverId: number,
    externalId: number,
    now = Date.now()
  ): DownloadingItem[] {
    const found: DownloadingItem[] = [];
    for (const [key, held] of this.imported) {
      if (now - held.at > IMPORTED_HOLD_MS) {
        this.imported.delete(key);
      } else if (
        held.kind === kind &&
        held.serverId === serverId &&
        held.item.externalId === externalId
      ) {
        found.push(held.item);
      }
    }
    return found;
  }

  /** Held Lidarr imports, by Lidarr and album. */
  public heldMusicImports(now = Date.now()): {
    serverId: number;
    albumId: number;
  }[] {
    this.isHoldingImports(now);
    return [...this.imported.values()].flatMap((held) =>
      held.kind === 'music' && held.item.album
        ? [{ serverId: held.serverId, albumId: held.item.album.id }]
        : []
    );
  }

  /**
   * An imported album is now listed: stop showing its downloads. Those
   * imported after the scan began stay until the next one.
   */
  public forgetImportedAlbum(
    serverId: number,
    albumId: number,
    before = Date.now()
  ) {
    for (const [key, held] of this.imported) {
      if (
        held.kind === 'music' &&
        held.serverId === serverId &&
        held.item.album?.id === albumId &&
        held.at <= before
      ) {
        this.imported.delete(key);
      }
    }
  }

  /**
   * The media server listed a title: stop showing its imported downloads.
   * Those imported after the scan began stay until the next one.
   */
  public forgetImported(
    kind: ImportedDownload['kind'],
    serverId: number,
    externalId: number,
    before = Date.now()
  ) {
    for (const [key, held] of this.imported) {
      if (
        held.kind === kind &&
        held.serverId === serverId &&
        held.item.externalId === externalId &&
        held.at <= before
      ) {
        this.imported.delete(key);
      }
    }
  }
  /** Latest download client state, by lower-cased download id. */
  private live = new Map<string, LiveDownload>();

  /** Backfill's own downloads, as last reported. */
  private backfill: BackfillDownload[] = [];

  /** Song Fetch's downloads, each for a Lidarr artist, as last reported. */
  private songs: { serverId: number; item: DownloadingItem }[] = [];

  /**
   * Song Fetch's downloads and imports, outside Lidarr's queue. Progress is
   * from the songs' files, not the whole release.
   */
  public setSongDownloads(
    downloads: { serverId: number; item: DownloadingItem }[]
  ) {
    this.songs = downloads;
  }

  /**
   * Backfill's current downloads and recent imports. A download that becomes
   * imported shows as being added to the library, as Radarr's and Sonarr's
   * do, until the media server lists it.
   */
  public setBackfillDownloads(
    downloads: BackfillDownload[],
    imported: BackfillDownload[] = [],
    now = Date.now()
  ) {
    const shown = new Set(this.backfill.map(backfillKey));
    const held: ImportedDownload[] = [];
    for (const done of imported) {
      if (!shown.has(backfillKey(done))) continue;
      held.push(
        this.hold(
          done.kind === 'album' ? 'music' : done.kind,
          done.serverId,
          done.item,
          now
        )
      );
    }
    this.backfill = downloads;
    if (held.length) this.importedNow(held);
  }

  private backfillFor(
    kind: BackfillDownload['kind'],
    serverId: number,
    externalId: number
  ) {
    return this.backfill
      .filter(
        (d) =>
          d.kind === kind &&
          d.serverId === serverId &&
          d.item.externalId === externalId
      )
      .map((d) => d.item);
  }

  private withLive = (item: DownloadingItem) =>
    withLiveProgress(item, this.live.get(item.downloadId?.toLowerCase()));

  public getMovieProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    return [
      ...(this.radarrServers[serverId] ?? []).filter(
        (item) => item.externalId === externalServiceId
      ),
      ...this.backfillFor('movie', serverId, externalServiceId),
    ]
      .map(this.withLive)
      .concat(this.importedOrWaiting('movie', serverId, externalServiceId));
  }

  public getSeriesProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    return [
      ...(this.sonarrServers[serverId] ?? []).filter(
        (item) => item.externalId === externalServiceId
      ),
      ...this.backfillFor('series', serverId, externalServiceId),
    ]
      .map(this.withLive)
      .concat(this.importedOrWaiting('series', serverId, externalServiceId));
  }

  /**
   * An artist's Lidarr downloads, each tagged with its album; one album's only,
   * given its id.
   */
  public getMusicProgress(
    serverId: number,
    artistId: number,
    albumId?: number
  ): DownloadingItem[] {
    const forAlbum = (item: DownloadingItem) =>
      albumId === undefined || item.album?.id === albumId;
    return (this.lidarrServers[serverId] ?? [])
      .filter((item) => item.externalId === artistId && forAlbum(item))
      .map(this.withLive)
      .concat(
        this.songs
          .filter(
            (d) =>
              d.serverId === serverId &&
              d.item.externalId === artistId &&
              forAlbum(d.item)
          )
          .map((d) => d.item),
        this.backfillFor('album', serverId, artistId)
          .filter(forAlbum)
          .map(this.withLive),
        this.importedOrWaiting('music', serverId, artistId).filter(forAlbum)
      );
  }

  /**
   * A release group's download from Lidarr, Song Fetch or Backfill, whichever
   * has it.
   */
  public getAlbumDownload(foreignAlbumId: string): DownloadingItem | undefined {
    const forIt = (item: DownloadingItem) =>
      item.album?.foreignAlbumId === foreignAlbumId;
    const item =
      Object.values(this.lidarrServers).flat().find(forIt) ??
      this.songs.map((d) => d.item).find(forIt) ??
      this.backfill
        .filter((d) => d.kind === 'album')
        .map((d) => d.item)
        .find(forIt);
    return item && this.withLive(item);
  }

  public async resetDownloadTracker() {
    this.radarrServers = {};
    this.sonarrServers = {};
    this.lidarrServers = {};
    this.live = new Map();
    this.backfill = [];
    this.songs = [];
    this.imported = new Map();
    this.importMarks = new Map();
    this.queueDown = new Set();
    // Nothing held: nothing to scan for.
    if (this.importTimer) {
      clearTimeout(this.importTimer);
      this.importTimer = undefined;
    }
  }

  private updating?: Promise<void>;
  private lastUpdate = 0;

  /**
   * Reads every Radarr, Sonarr and Lidarr queue, then the download clients; one
   * pass at a time.
   */
  public updateDownloads(): Promise<void> {
    if (!this.updating) {
      this.lastUpdate = Date.now();
      this.updating = Promise.all([
        this.updateRadarrDownloads(),
        this.updateSonarrDownloads(),
        this.updateLidarrDownloads(),
      ])
        .then(() => this.updateLive())
        .finally(() => {
          this.updating = undefined;
        });
    }
    return this.updating;
  }

  private liveUpdating?: Promise<void>;
  private lastLive = 0;
  private unreachable = new Set<number>();

  /**
   * Asks each linked download client about queued downloads. An unanswering
   * client's downloads stay as Radarr or Sonarr last described them.
   */
  public updateLive(): Promise<void> {
    if (!this.liveUpdating) {
      this.lastLive = Date.now();
      this.liveUpdating = this.readClients().finally(() => {
        this.liveUpdating = undefined;
      });
    }
    return this.liveUpdating;
  }

  private async readClients(): Promise<void> {
    const clients = getSettings().downloadClients;
    const ids = [
      ...new Set(
        [
          ...Object.values(this.radarrServers),
          ...Object.values(this.sonarrServers),
          ...Object.values(this.lidarrServers),
          this.backfill.map((d) => d.item),
        ]
          .flat()
          .map((item) => item.downloadId)
          .filter(Boolean)
      ),
    ];
    if (!clients.length || !ids.length) {
      this.live = new Map();
      return;
    }

    const answers = await Promise.all(
      clients.map(async (client) => {
        try {
          const found = await downloadClientFor(client).getDownloads(ids);
          if (this.unreachable.delete(client.id)) {
            logger.info(`Reaching ${client.name} again`, {
              label: 'Download Tracker',
            });
          }
          return found;
        } catch (e) {
          // Logged once, not every pass while down.
          if (!this.unreachable.has(client.id)) {
            this.unreachable.add(client.id);
            logger.warn(`Could not read downloads from ${client.name}`, {
              label: 'Download Tracker',
              errorMessage: e instanceof Error ? e.message : String(e),
            });
          }
          return new Map<string, LiveDownload>();
        }
      })
    );

    this.live = new Map(answers.flatMap((answer) => [...answer]));
  }

  /**
   * Someone is watching a download: refresh if the last check is more than a
   * few seconds old, so progress moves faster than the scheduled job. With
   * download clients linked, they are asked every few seconds and queues less
   * often. This response has current data; the next gets fresher numbers.
   */
  public keepFresh() {
    const now = Date.now();
    const linked = getSettings().downloadClients.length > 0;
    if (
      now - this.lastUpdate >=
      (linked ? QUEUE_REFRESH_WITH_CLIENTS_MS : LIVE_REFRESH_MS)
    ) {
      void this.updateDownloads();
    } else if (linked && now - this.lastLive >= LIVE_REFRESH_MS) {
      void this.updateLive();
    }
  }

  /** Servers whose last queue read failed, as "Sonarr:2". */
  private queueDown = new Set<string>();

  /**
   * A failed queue read. Warns once with the reason when the server stops
   * answering, then logs at debug while it stays down (still polled every
   * pass), so a server off for the day doesn't fill the logs.
   */
  private queueFailed(
    kind: 'Radarr' | 'Sonarr' | 'Lidarr',
    server: { id: number; name: string },
    e: unknown
  ) {
    const key = `${kind}:${server.id}`;
    const errorMessage = e instanceof Error ? e.message : String(e);
    if (this.queueDown.has(key)) {
      logger.debug(`${kind} server ${server.name} is still not answering`, {
        label: 'Download Tracker',
        errorMessage,
      });
      return;
    }
    this.queueDown.add(key);
    logger.warn(
      `${kind} server ${server.name} is not answering; its downloads are left as they were`,
      { label: 'Download Tracker', errorMessage }
    );
  }

  /** A successful queue read: logs recovery if the server was down. */
  private queueAnswered(
    kind: 'Radarr' | 'Sonarr' | 'Lidarr',
    server: { id: number; name: string }
  ) {
    if (this.queueDown.delete(`${kind}:${server.id}`)) {
      logger.info(`${kind} server ${server.name} is answering again`, {
        label: 'Download Tracker',
      });
    }
  }

  private async updateRadarrDownloads() {
    const settings = getSettings();

    const filteredServers = uniqWith(settings.radarr, (radarrA, radarrB) => {
      return (
        radarrA.hostname === radarrB.hostname &&
        radarrA.port === radarrB.port &&
        radarrA.baseUrl === radarrB.baseUrl
      );
    });

    await Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const radarr = new RadarrAPI({
            apiKey: server.apiKey,
            url: RadarrAPI.buildUrl(server, '/api/v3'),
          });

          try {
            await radarr.refreshMonitoredDownloads();
            const queueItems = await radarr.getQueue();
            this.queueAnswered('Radarr', server);

            const before = this.radarrServers[server.id] ?? [];
            this.radarrServers[server.id] = queueItems.map((item) =>
              trackedItem(item, MediaType.MOVIE, item.movieId)
            );
            const sharing = settings.radarr
              .filter(
                (rs) =>
                  rs.id === server.id ||
                  (rs.syncEnabled &&
                    rs.hostname === server.hostname &&
                    rs.port === server.port &&
                    rs.baseUrl === server.baseUrl)
              )
              .map((rs) => rs.id);
            this.noteImported(
              'movie',
              sharing,
              before,
              this.radarrServers[server.id]
            );
            await this.noteImportedFromHistory(
              'movie',
              radarr,
              `Radarr ${server.id}`,
              sharing,
              this.radarrServers[server.id]
            );

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Radarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
          } catch (e) {
            this.queueFailed('Radarr', server, e);
          }

          // Copy to entries sharing this address.
          const matchingServers = settings.radarr.filter(
            (rs) =>
              rs.hostname === server.hostname &&
              rs.port === server.port &&
              rs.baseUrl === server.baseUrl &&
              rs.id !== server.id
          );

          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Radarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.radarrServers[ms.id] = this.radarrServers[server.id];
            }
          });
        }
      })
    );
  }

  private async updateSonarrDownloads() {
    const settings = getSettings();

    const filteredServers = uniqWith(settings.sonarr, (sonarrA, sonarrB) => {
      return (
        sonarrA.hostname === sonarrB.hostname &&
        sonarrA.port === sonarrB.port &&
        sonarrA.baseUrl === sonarrB.baseUrl
      );
    });

    await Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const sonarr = new SonarrAPI({
            apiKey: server.apiKey,
            url: SonarrAPI.buildUrl(server, '/api/v3'),
          });

          try {
            await sonarr.refreshMonitoredDownloads();
            const queueItems = await sonarr.getQueue();
            this.queueAnswered('Sonarr', server);

            const before = this.sonarrServers[server.id] ?? [];
            this.sonarrServers[server.id] = airedEpisodesOf(queueItems).map(
              (item) =>
                trackedItem(item, MediaType.TV, item.seriesId, item.episode)
            );
            const sharing = settings.sonarr
              .filter(
                (ss) =>
                  ss.id === server.id ||
                  (ss.syncEnabled &&
                    ss.hostname === server.hostname &&
                    ss.port === server.port &&
                    ss.baseUrl === server.baseUrl)
              )
              .map((ss) => ss.id);
            this.noteImported(
              'series',
              sharing,
              before,
              this.sonarrServers[server.id]
            );
            await this.noteImportedFromHistory(
              'series',
              sonarr,
              `Sonarr ${server.id}`,
              sharing,
              this.sonarrServers[server.id]
            );

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Sonarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
          } catch (e) {
            this.queueFailed('Sonarr', server, e);
          }

          // Copy to entries sharing this address.
          const matchingServers = settings.sonarr.filter(
            (ss) =>
              ss.hostname === server.hostname &&
              ss.port === server.port &&
              ss.baseUrl === server.baseUrl &&
              ss.id !== server.id
          );

          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Sonarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.sonarrServers[ms.id] = this.sonarrServers[server.id];
            }
          });
        }
      })
    );
  }

  /**
   * Every Lidarr queue, while music is on. Read even if the Lidarr's library
   * isn't scanned: every music request goes through one. A Lidarr listed
   * twice (same address) is asked once.
   */
  private async updateLidarrDownloads() {
    if (!musicReady()) {
      this.lidarrServers = {};
      return;
    }
    const servers = getSettings().lidarr;
    const distinct = uniqWith(servers, sameServer);

    await Promise.all(
      distinct.map(async (server) => {
        const sharing = servers
          .filter(
            (other) => other.id === server.id || sameServer(other, server)
          )
          .map((other) => other.id);
        try {
          const lidarr = lidarrApi(server);
          await lidarr.refreshMonitoredDownloads();
          const queueItems = await lidarr.getMusicQueue();
          this.queueAnswered('Lidarr', server);

          const before = this.lidarrServers[server.id] ?? [];
          const items = queueItems.map((item) =>
            trackedItem(
              item,
              MediaType.MUSIC,
              item.artistId,
              undefined,
              item.album
                ? {
                    id: item.album.id,
                    title: item.album.title,
                    foreignAlbumId: item.album.foreignAlbumId,
                  }
                : item.albumId
                  ? { id: item.albumId, title: '', foreignAlbumId: '' }
                  : undefined
            )
          );
          for (const id of sharing) {
            this.lidarrServers[id] = items;
          }
          this.noteImported('music', sharing, before, items);

          if (queueItems.length > 0) {
            logger.debug(
              `Found ${queueItems.length} item(s) in progress on Lidarr server: ${server.name}`,
              { label: 'Download Tracker' }
            );
          }
        } catch (e) {
          this.queueFailed('Lidarr', server, e);
        }
      })
    );
  }
}

const downloadTracker = new DownloadTracker();

export default downloadTracker;
