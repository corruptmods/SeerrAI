import LidarrAPI from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import type { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import downloadTracker from '@server/lib/downloadtracker';
import { limitToLibraries } from '@server/lib/libraryVisibility';
import type { AvailableQuality, StoredQuality } from '@server/lib/mediaQuality';
import { availableQuality } from '@server/lib/mediaQuality';
import {
  MEDIA_ID,
  connectedServers,
  primaryServer,
  serverItemLinks,
  serverName,
} from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  AfterLoad,
  Column,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import Issue from './Issue';
import { MediaRequest } from './MediaRequest';
import MusicAlbum from './MusicAlbum';
import Season from './Season';

/** Where a title can be played on one media server. */
export interface PlayLink {
  server: MediaServerKind;
  /** Display name of the server kind: Plex, Jellyfin, Emby. */
  name: string;
  url?: string;
  url4k?: string;
  /** Plex's iPhone and iPad app. */
  iosUrl?: string;
  iosUrl4k?: string;
}

/**
 * Item ids to build a server's play links from instead of the title's own: a
 * string links that item, null links nothing, undefined keeps the title's.
 */
export type PlayLinkIds = Partial<
  Record<MediaServerKind, { id?: string | null; id4k?: string | null }>
>;

@Entity()
@Index(['tmdbId', 'mediaType'])
@Index(['mediaType', 'foreignId'], { unique: true })
class Media {
  /**
   * The media Seerr has for these titles. Throws when the database can't be
   * read: for callers acting on what's missing, "none" differs from "unknown".
   */
  public static async findRelatedMedia(
    user: User | undefined,
    items: { tmdbId: number; mediaType: string }[],
    { includeActiveRequest = false }: { includeActiveRequest?: boolean } = {}
  ): Promise<Media[]> {
    const mediaRepository = getRepository(Media);
    if (items.length === 0) {
      return [];
    }

    const finalIds = [...new Set(items.map((i) => i.tmdbId))];

    const media = await mediaRepository
      .createQueryBuilder('media')
      .leftJoinAndSelect(
        'media.watchlists',
        'watchlist',
        'media.id= watchlist.media and watchlist.requestedBy = :userId',
        { userId: user?.id }
      )
      .where(' media.tmdbId in (:...finalIds)', { finalIds })
      .getMany();

    const relatedMedia = media.filter((m) =>
      items.some((i) => i.tmdbId === m.tmdbId && i.mediaType === m.mediaType)
    );

    if (
      includeActiveRequest &&
      getSettings().main.hideRequested &&
      relatedMedia.length > 0
    ) {
      const activeRequestMediaIds = await mediaRepository
        .createQueryBuilder('media')
        .select('media.id', 'id')
        .distinct(true)
        .innerJoin('media.requests', 'request')
        .where('media.id IN (:...mediaIds)', {
          mediaIds: relatedMedia.map((m) => m.id),
        })
        .andWhere('request.status IN (:...statuses)', {
          statuses: [MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED],
        })
        .getRawMany<{ id: number }>();

      const activeIds = new Set(activeRequestMediaIds.map((row) => row.id));

      relatedMedia.forEach((m) => {
        m.hasActiveRequest = activeIds.has(m.id);
      });
    }

    return relatedMedia;
  }

  /**
   * Like findRelatedMedia, for display: empty when the database can't be
   * read, and shown as the user's libraries allow (lib/libraryVisibility).
   */
  public static async getRelatedMedia(
    user: User | undefined,
    items: { tmdbId: number; mediaType: string }[],
    options: { includeActiveRequest?: boolean } = {}
  ): Promise<Media[]> {
    try {
      const media = await Media.findRelatedMedia(user, items, options);
      await limitToLibraries(media, user);
      return media;
    } catch (e) {
      logger.error(e.message);
      return [];
    }
  }

  public static async getMedia(
    id: number,
    mediaType: MediaType
  ): Promise<Media | undefined> {
    const mediaRepository = getRepository(Media);

    try {
      const media = await mediaRepository.findOne({
        where: { tmdbId: id, mediaType: mediaType },
        relations: { requests: true, issues: true },
      });

      return media ?? undefined;
    } catch (e) {
      logger.error(e.message);
      return undefined;
    }
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column()
  @Index()
  public tmdbId: number;

  @Column({ unique: true, nullable: true })
  @Index()
  public tvdbId?: number;

  /**
   * A non-TMDB id: an artist's MusicBrainz id for music (whose tmdbId is 0).
   * Null for films and series.
   */
  @Column({ type: 'varchar', nullable: true })
  public foreignId?: string | null;

  /**
   * The name of a non-TMDB title as last requested (an artist's name, for
   * music), so request cards and notifications don't query MusicBrainz again.
   * Null for films and series.
   */
  @Column({ type: 'varchar', nullable: true })
  public foreignTitle?: string | null;

  @Column({ nullable: true })
  @Index()
  public imdbId?: string;

  @Column({ type: 'int', default: MediaStatus.UNKNOWN })
  @Index()
  public status: MediaStatus;

  @Column({ type: 'int', default: MediaStatus.UNKNOWN })
  @Index()
  public status4k: MediaStatus;

  @OneToMany(() => MediaRequest, (request) => request.media, {
    cascade: ['insert', 'remove'],
  })
  public requests: MediaRequest[];

  @OneToMany(() => Watchlist, (watchlist) => watchlist.media)
  public watchlists: null | Watchlist[];

  @OneToMany(() => Season, (season) => season.media, {
    cascade: true,
    eager: true,
  })
  public seasons: Season[];

  @OneToMany(() => Issue, (issue) => issue.media, { cascade: true })
  public issues: Issue[];

  /** An artist's albums. Only loaded when requested. */
  @OneToMany(() => MusicAlbum, (album) => album.media)
  public musicAlbums?: MusicAlbum[];

  @OneToOne(() => Blocklist, (blocklist) => blocklist.media)
  public blocklist: Promise<Blocklist>;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  /**
   * When the title's seasons last changed. Database-aware: SQLite uses
   * `datetime`, Postgres `timestamptz`.
   */
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public lastSeasonChange: Date;

  /**
   * When the title was added to the library; null until synced. Database-aware:
   * SQLite uses `datetime`, Postgres `timestamptz`.
   */
  @DbAwareColumn({
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    nullable: true,
  })
  public mediaAddedAt: Date;

  @Column({ nullable: true, type: 'int' })
  public serviceId?: number | null;

  @Column({ nullable: true, type: 'int' })
  public serviceId4k?: number | null;

  @Column({ nullable: true, type: 'int' })
  public externalServiceId?: number | null;

  @Column({ nullable: true, type: 'int' })
  public externalServiceId4k?: number | null;

  @Column({ nullable: true, type: 'varchar' })
  public externalServiceSlug?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public externalServiceSlug4k?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public ratingKey?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public ratingKey4k?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public jellyfinMediaId?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public jellyfinMediaId4k?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public embyMediaId?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public embyMediaId4k?: string | null;

  /**
   * An admin's anime setting on the title page: true or false overrides
   * detection and override rules; null defers to them (lib/animePlacement).
   */
  @Column({ nullable: true, type: 'boolean' })
  public animeSetting?: boolean | null;

  /**
   * Resolutions and HDR formats each media server and Radarr saw at its last
   * scan (lib/mediaQuality); shown as availableQuality.
   */
  @Column({ type: 'simple-json', nullable: true })
  public quality?: StoredQuality | null;

  /** What the title is here in, standard and 4K, when it's available. */
  public availableQuality?: AvailableQuality;
  public availableQuality4k?: AvailableQuality;

  public serviceUrl?: string;
  public serviceUrl4k?: string;
  public hasActiveRequest?: boolean;
  public downloadStatus?: DownloadingItem[] = [];
  public downloadStatus4k?: DownloadingItem[] = [];

  public mediaUrl?: string;
  public mediaUrl4k?: string;

  public iOSPlexUrl?: string;
  public iOSPlexUrl4k?: string;

  public tautulliUrl?: string;
  public tautulliUrl4k?: string;

  /** Where to play the title: one entry per connected server that has it. */
  public playLinks?: PlayLink[];

  /**
   * The viewer's libraries don't hold the title (or its 4K copy) though a
   * media server has it; it is shown as not available to them
   * (lib/libraryVisibility). Never stored.
   */
  public outsideLibraries?: boolean;
  public outsideLibraries4k?: boolean;

  constructor(init?: Partial<Media>) {
    Object.assign(this, init);
  }

  public resetServiceData(is4k?: boolean): void {
    if (is4k === undefined || !is4k) {
      this.serviceId = null;
      this.externalServiceId = null;
      this.externalServiceSlug = null;
      this.ratingKey = null;
      this.jellyfinMediaId = null;
      this.embyMediaId = null;
    }
    if (is4k === undefined || is4k) {
      this.serviceId4k = null;
      this.externalServiceId4k = null;
      this.externalServiceSlug4k = null;
      this.ratingKey4k = null;
      this.jellyfinMediaId4k = null;
      this.embyMediaId4k = null;
    }
  }

  /** A server's links to the title, from its ids for it. */
  private playLinkFor(kind: MediaServerKind, ids?: PlayLinkIds): PlayLink {
    const [idColumn, idColumn4k] = MEDIA_ID[kind];
    const given = ids?.[kind];
    const id = given?.id !== undefined ? given.id : this[idColumn];
    const id4k = given?.id4k !== undefined ? given.id4k : this[idColumn4k];
    const link: PlayLink = { server: kind, name: serverName(kind) };
    if (id) {
      const { url, iosUrl } = serverItemLinks(kind, id);
      link.url = url;
      if (iosUrl) link.iosUrl = iosUrl;
    }
    if (id4k) {
      const { url, iosUrl } = serverItemLinks(kind, id4k);
      link.url4k = url;
      if (iosUrl) link.iosUrl4k = iosUrl;
    }
    return link;
  }

  /**
   * Play links for each connected server with the title, plus the legacy single
   * links (mediaUrl, iOSPlexUrl, tautulliUrl) for the primary server. `ids`
   * builds them from other items, replacing the links set before.
   */
  @AfterLoad()
  public setPlayLinks(ids?: PlayLinkIds): void {
    if (ids) {
      this.mediaUrl = this.mediaUrl4k = undefined;
      this.iOSPlexUrl = this.iOSPlexUrl4k = undefined;
      this.tautulliUrl = this.tautulliUrl4k = undefined;
    }
    this.playLinks = connectedServers()
      .map((kind) => this.playLinkFor(kind, ids))
      .filter((link) => link.url || link.url4k);

    const primary = primaryServer();

    if (primary === 'plex') {
      const { externalUrl: tautulliUrl } = getSettings().tautulli;
      const link = this.playLinkFor('plex', ids);
      const ratingKey =
        ids?.plex?.id !== undefined ? ids.plex.id : this.ratingKey;
      const ratingKey4k =
        ids?.plex?.id4k !== undefined ? ids.plex.id4k : this.ratingKey4k;
      if (link.url) {
        this.mediaUrl = link.url;
        this.iOSPlexUrl = link.iosUrl;
      }
      if (link.url4k) {
        this.mediaUrl4k = link.url4k;
        this.iOSPlexUrl4k = link.iosUrl4k;
      }
      if (tautulliUrl && ratingKey) {
        this.tautulliUrl = `${tautulliUrl}/info?rating_key=${ratingKey}`;
      }
      if (tautulliUrl && ratingKey4k) {
        this.tautulliUrl4k = `${tautulliUrl}/info?rating_key=${ratingKey4k}`;
      }
    } else {
      const link = this.playLinkFor(
        primary === 'emby' ? 'emby' : 'jellyfin',
        ids
      );
      if (link.url) {
        this.mediaUrl = link.url;
      }
      if (link.url4k) {
        this.mediaUrl4k = link.url4k;
      }
    }
  }

  /**
   * Left out of what pages are sent: they show availableQuality, and the raw
   * column would say which server holds a title someone may not see.
   */
  public toJSON(): Partial<Media> {
    const shown: Partial<Media> = { ...this };
    delete shown.quality;
    return shown;
  }

  @AfterLoad()
  public setAvailableQuality(): void {
    const shown = (status: MediaStatus) =>
      status === MediaStatus.AVAILABLE ||
      status === MediaStatus.PARTIALLY_AVAILABLE;
    if (shown(this.status)) {
      this.availableQuality = availableQuality(this, 'standard');
    }
    if (shown(this.status4k)) {
      this.availableQuality4k = availableQuality(this, '4k');
    }
  }

  @AfterLoad()
  public setServiceUrl(): void {
    // An artist: their Lidarr page, by MusicBrainz id.
    if (this.mediaType === MediaType.MUSIC) {
      if (this.serviceId !== null && this.externalServiceSlug) {
        const server = getSettings().lidarr.find(
          (lidarr) => lidarr.id === this.serviceId
        );
        if (server) {
          this.serviceUrl = server.externalUrl
            ? `${server.externalUrl}/artist/${this.externalServiceSlug}`
            : LidarrAPI.buildUrl(server, `/artist/${this.externalServiceSlug}`);
        }
      }
      return;
    }

    if (this.mediaType === MediaType.MOVIE) {
      if (this.serviceId !== null && this.externalServiceSlug !== null) {
        const settings = getSettings();
        const server = settings.radarr.find(
          (radarr) => radarr.id === this.serviceId
        );

        if (server) {
          this.serviceUrl = server.externalUrl
            ? `${server.externalUrl}/movie/${this.externalServiceSlug}`
            : RadarrAPI.buildUrl(server, `/movie/${this.externalServiceSlug}`);
        }
      }

      if (this.serviceId4k !== null && this.externalServiceSlug4k !== null) {
        const settings = getSettings();
        const server = settings.radarr.find(
          (radarr) => radarr.id === this.serviceId4k
        );

        if (server) {
          this.serviceUrl4k = server.externalUrl
            ? `${server.externalUrl}/movie/${this.externalServiceSlug4k}`
            : RadarrAPI.buildUrl(
                server,
                `/movie/${this.externalServiceSlug4k}`
              );
        }
      }
    }

    if (this.mediaType === MediaType.TV) {
      if (this.serviceId !== null && this.externalServiceSlug !== null) {
        const settings = getSettings();
        const server = settings.sonarr.find(
          (sonarr) => sonarr.id === this.serviceId
        );

        if (server) {
          this.serviceUrl = server.externalUrl
            ? `${server.externalUrl}/series/${this.externalServiceSlug}`
            : SonarrAPI.buildUrl(server, `/series/${this.externalServiceSlug}`);
        }
      }

      if (this.serviceId4k !== null && this.externalServiceSlug4k !== null) {
        const settings = getSettings();
        const server = settings.sonarr.find(
          (sonarr) => sonarr.id === this.serviceId4k
        );

        if (server) {
          this.serviceUrl4k = server.externalUrl
            ? `${server.externalUrl}/series/${this.externalServiceSlug4k}`
            : SonarrAPI.buildUrl(
                server,
                `/series/${this.externalServiceSlug4k}`
              );
        }
      }
    }
  }

  @AfterLoad()
  public getDownloadingItem(): void {
    if (this.mediaType === MediaType.MOVIE) {
      if (
        this.externalServiceId !== undefined &&
        this.externalServiceId !== null &&
        this.serviceId !== undefined &&
        this.serviceId !== null
      ) {
        this.downloadStatus = downloadTracker.getMovieProgress(
          this.serviceId,
          this.externalServiceId
        );
      }

      if (
        this.externalServiceId4k !== undefined &&
        this.externalServiceId4k !== null &&
        this.serviceId4k !== undefined &&
        this.serviceId4k !== null
      ) {
        this.downloadStatus4k = downloadTracker.getMovieProgress(
          this.serviceId4k,
          this.externalServiceId4k
        );
      }
    }

    if (this.mediaType === MediaType.TV) {
      if (
        this.externalServiceId !== undefined &&
        this.externalServiceId !== null &&
        this.serviceId !== undefined &&
        this.serviceId !== null
      ) {
        this.downloadStatus = downloadTracker.getSeriesProgress(
          this.serviceId,
          this.externalServiceId
        );
      }

      if (
        this.externalServiceId4k !== undefined &&
        this.externalServiceId4k !== null &&
        this.serviceId4k !== undefined &&
        this.serviceId4k !== null
      ) {
        this.downloadStatus4k = downloadTracker.getSeriesProgress(
          this.serviceId4k,
          this.externalServiceId4k
        );
      }
    }

    // An artist: everything of theirs Lidarr is downloading, each item naming
    // its album.
    if (
      this.mediaType === MediaType.MUSIC &&
      this.externalServiceId != null &&
      this.serviceId != null
    ) {
      this.downloadStatus = downloadTracker.getMusicProgress(
        this.serviceId,
        this.externalServiceId
      );
    }

    // A title only waiting on its server's match has no queue item to track.
    if (
      [...(this.downloadStatus ?? []), ...(this.downloadStatus4k ?? [])].some(
        (item) => !item.matching
      )
    ) {
      downloadTracker.keepFresh();
    }
  }
}

export default Media;
