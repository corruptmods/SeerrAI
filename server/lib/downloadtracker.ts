import type { LiveDownload } from '@server/api/downloadclients';
import { downloadClientFor } from '@server/api/downloadclients';
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
 * A download Backfill (or the admin agent through it) runs itself, outside
 * Radarr's and Sonarr's queues, for the title it is for.
 */
export interface BackfillDownload {
  kind: 'movie' | 'series';
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
  /** Radarr's or Sonarr's own word for it, as sent. */
  status: string;
  stage: DownloadStage;
  /** What the download client is doing within the stage, when read directly. */
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
   * Imported, but this media server matched it to another title (or none)
   * and has yet to be put right: the title waits for it (lib/matchWatch).
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
  // The client itself reporting a problem part-way through: for a torrent,
  // stalled with no one to download from, or stopped on an error. It isn't
  // downloading, which is what can be said for certain.
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
 * When it should finish, only while bytes are still arriving or queued to.
 * Radarr and Sonarr report "now" for everything after that, which would read
 * as an estimate that has already passed, and for a delay-profile hold the
 * time the hold ends, which is not when anything finishes.
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

/** How stale progress may get while someone is looking at it. */
const LIVE_REFRESH_MS = 5_000;

/**
 * A Radarr or Sonarr queue item, brought up to date by what its download
 * client says now. Radarr or Sonarr still has the last word on a delay hold,
 * the import (pending, in progress or blocked) and a failure; the client on
 * how far along the download is, how long is left and what it is doing.
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
    // Unless the trouble is only that Radarr or Sonarr can't reach the
    // client, which Seerr just did.
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

/** How often Radarr's and Sonarr's queues are read while someone watches. */
const QUEUE_REFRESH_WITH_CLIENTS_MS = 30_000;

/**
 * How long a download is still shown once Radarr or Sonarr imported it,
 * at most: until the media server lists it, which is usually within a
 * minute or two.
 */
export const IMPORTED_HOLD_MS = 30 * 60_000;

/**
 * How soon after imports the media server's recently added scan runs, so
 * a title shows as available in a minute rather than at the next scan.
 */
export const IMPORTED_SCAN_DELAY_MS = 60_000;

/**
 * How many times that scan runs, a minute apart, while the media server
 * has yet to list something imported. The regular scan takes it from there.
 */
export const IMPORTED_SCAN_TRIES = 4;

/**
 * A title imported that a media server matched wrongly, still to be put
 * right: for Lidarr, `externalId` is the artist and `albumId` the album.
 */
export interface MatchWait {
  kind: ImportedDownload['kind'];
  serverId: number;
  externalId: number;
  albumId?: number;
  mediaServer: string;
  title: string;
}

/** Stages from which leaving the queue means it was imported. */
const DONE_STAGES: DownloadStage[] = ['importing', 'finishing'];

/** A download that left the queue because it was imported, held a while. */
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

/** Servers that are one and the same: the same address. */
const sameServer = (a: DVRSettings, b: DVRSettings) =>
  a.hostname === b.hostname && a.port === b.port && a.baseUrl === b.baseUrl;

/**
 * Whether a download that left the queue was imported rather than removed:
 * it was being imported or readied for import, or had nothing left to
 * download and had not failed.
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
   * What to do with each import as soon as it is seen (the check of new
   * requests' matches). Set again, it replaces what was set.
   */
  public onEachImport(
    run: (imported: ImportedDownload[]) => Promise<void> | void
  ) {
    this.onImported = run;
  }

  /** Titles a media server has yet to match rightly (lib/matchWatch). */
  public setMatchWaits(waits: MatchWait[]) {
    this.matchWaits = waits;
  }

  /**
   * A title imported but matched wrongly, once its import is no longer
   * shown: still being added to the library, waiting for the server.
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
        // All in: what is left is the server's part.
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
    // The import itself is shown for as long as it is held; an album only
    // gives way to its own import, not to another album's.
    const waiting = this.waitingFor(kind, serverId, externalId).filter(
      (w) =>
        !imported.some((i) => kind !== 'music' || i.album?.id === w.album?.id)
    );
    return [...imported, ...waiting];
  }

  /**
   * What to do a minute after downloads are imported (the media server's
   * recently added scan), and again a minute later while the media server
   * has yet to list some of it. Set again, it replaces what was set.
   */
  public whenImported(run: () => Promise<void> | void) {
    this.onImport = run;
  }

  /**
   * Notes what left a server's queue having been imported, for every
   * server entry that shares that queue.
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

  /** Shows a download as being added to the library, until it is listed. */
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
      // The media server hadn't listed all of it yet: look again shortly.
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

  /** Whether an imported download is still shown, waiting to be listed. */
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

  /** Music downloads Lidarr imported, still shown: by Lidarr and album. */
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
   * An album Lidarr imported is here now: its downloads are no longer
   * shown. Those imported after the scan began stay until the next one.
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
   * The media server listed a title: its imported downloads are no longer
   * shown. Those imported after the scan began stay until the next one.
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
  /** What the download clients said last, by download id in lower case. */
  private live = new Map<string, LiveDownload>();

  /** Backfill's own downloads, as Backfill last told. */
  private backfill: BackfillDownload[] = [];

  /**
   * What Backfill is downloading, and what it has imported of late. What
   * was shown downloading and is now imported is shown as being added to
   * the library, as Radarr's and Sonarr's imports are, until the media
   * server lists it.
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
      held.push(this.hold(done.kind, done.serverId, done.item, now));
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
   * An artist's downloads in Lidarr, each saying which album it is for;
   * only one album's, given its Lidarr id.
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
        this.importedOrWaiting('music', serverId, artistId).filter(forAlbum)
      );
  }

  public async resetDownloadTracker() {
    this.radarrServers = {};
    this.sonarrServers = {};
    this.lidarrServers = {};
    this.live = new Map();
    this.backfill = [];
    this.imported = new Map();
    this.queueDown = new Set();
  }

  private updating?: Promise<void>;
  private lastUpdate = 0;

  /**
   * Asks every Radarr, Sonarr and Lidarr server for its queue, then the
   * download clients for the latest on what is in it; one pass at a time.
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
   * Asks each download client Seerr is linked to about the downloads in the
   * queues. A client that doesn't answer leaves its downloads as Radarr or
   * Sonarr last described them.
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
          // Said once, not on every pass while it stays down.
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
   * Someone is looking at something downloading: check again now if the
   * last check is more than a few seconds old, so progress moves while they
   * watch rather than on the scheduled job's pace. With download clients
   * linked, those are asked every few seconds and the queues less often,
   * since the clients are where progress changes. What is sent now is what
   * is known; the next look gets the fresher numbers.
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

  /** Servers whose queue could not be read last time, as "Sonarr:2". */
  private queueDown = new Set<string>();

  /**
   * A queue that could not be read. Said once, as a warning with the
   * reason, when the server stops answering; while it stays down it is
   * asked every pass all the same, and only mentioned at debug level, so
   * a server switched off for the day does not fill the logs.
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

  /** A queue read: if the server had stopped answering, say it is back. */
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

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.radarr, (radarrA, radarrB) => {
      return (
        radarrA.hostname === radarrB.hostname &&
        radarrA.port === radarrB.port &&
        radarrA.baseUrl === radarrB.baseUrl
      );
    });

    // Load downloads from Radarr servers
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
            this.noteImported(
              'movie',
              settings.radarr
                .filter(
                  (rs) =>
                    rs.id === server.id ||
                    (rs.syncEnabled &&
                      rs.hostname === server.hostname &&
                      rs.port === server.port &&
                      rs.baseUrl === server.baseUrl)
                )
                .map((rs) => rs.id),
              before,
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

          // Duplicate this data to matching servers
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

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.sonarr, (sonarrA, sonarrB) => {
      return (
        sonarrA.hostname === sonarrB.hostname &&
        sonarrA.port === sonarrB.port &&
        sonarrA.baseUrl === sonarrB.baseUrl
      );
    });

    // Load downloads from Sonarr servers
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
            this.sonarrServers[server.id] = queueItems.map((item) =>
              trackedItem(item, MediaType.TV, item.seriesId, item.episode)
            );
            this.noteImported(
              'series',
              settings.sonarr
                .filter(
                  (ss) =>
                    ss.id === server.id ||
                    (ss.syncEnabled &&
                      ss.hostname === server.hostname &&
                      ss.port === server.port &&
                      ss.baseUrl === server.baseUrl)
                )
                .map((ss) => ss.id),
              before,
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

          // Duplicate this data to matching servers
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
   * Every Lidarr's queue, while music is set up and on. Read whether or
   * not the Lidarr scans its library into Seerr: every music request goes
   * through one, and its progress is all there is to show for it. A
   * Lidarr listed twice (the same address) is asked once.
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
