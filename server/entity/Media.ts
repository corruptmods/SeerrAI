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
  /** The server's kind, as people know it: Plex, Jellyfin, Emby. */
  name: string;
  url?: string;
  url4k?: string;
  /** Plex's app on iPhone and iPad. */
  iosUrl?: string;
  iosUrl4k?: string;
}

@Entity()
@Index(['tmdbId', 'mediaType'])
@Index(['mediaType', 'foreignId'], { unique: true })
class Media {
  /**
   * The media Seerr has for these titles. Throws when the database cannot
   * be read: for a caller that acts on what is missing, "none" is not the
   * same as "could not tell".
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

  /** As findRelatedMedia, for display: nothing when it cannot be read. */
  public static async getRelatedMedia(
    user: User | undefined,
    items: { tmdbId: number; mediaType: string }[],
    options: { includeActiveRequest?: boolean } = {}
  ): Promise<Media[]> {
    try {
      return await Media.findRelatedMedia(user, items, options);
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
   * A title's id outside TMDB: an artist's MusicBrainz id, for music (whose
   * tmdbId is 0). Null for films and series.
   */
  @Column({ type: 'varchar', nullable: true })
  public foreignId?: string | null;

  /**
   * The name of a title kept outside TMDB, as it was when last asked for:
   * an artist's name, for music. Request cards and notifications show it
   * without asking MusicBrainz again. Null for films and series.
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

  /** An artist's albums. Only loaded when asked for. */
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
   * The `lastSeasonChange` column stores the date and time when the media was added to the library.
   * It needs to be database-aware because SQLite supports `datetime` while PostgreSQL supports `timestamp with timezone (timestampz)`.
   */
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public lastSeasonChange: Date;

  /**
   * The `mediaAddedAt` column stores the date and time when the media was added to the library.
   * It needs to be database-aware because SQLite supports `datetime` while PostgreSQL supports `timestamp with timezone (timestampz)`.
   * This column is nullable because it can be null when the media is not yet synced to the library.
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
   * Whether the title is anime, as set on its page by an admin: true or
   * false stands over anime detection and override rules, and null leaves
   * it to them (lib/animePlacement).
   */
  @Column({ nullable: true, type: 'boolean' })
  public animeSetting?: boolean | null;

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

  /** A server's links to the title, from the ids it has for it. */
  private playLinkFor(kind: MediaServerKind): PlayLink {
    const [idColumn, idColumn4k] = MEDIA_ID[kind];
    const id = this[idColumn];
    const id4k = this[idColumn4k];
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
   * Play links for each connected server that has the title, and the
   * single links (mediaUrl, iOSPlexUrl, tautulliUrl) for the primary
   * server, which API readers have always had.
   */
  @AfterLoad()
  public setPlayLinks(): void {
    this.playLinks = connectedServers()
      .map((kind) => this.playLinkFor(kind))
      .filter((link) => link.url || link.url4k);

    const primary = primaryServer();

    if (primary === 'plex') {
      const { externalUrl: tautulliUrl } = getSettings().tautulli;
      const link = this.playLinkFor('plex');
      if (link.url) {
        this.mediaUrl = link.url;
        this.iOSPlexUrl = link.iosUrl;
      }
      if (link.url4k) {
        this.mediaUrl4k = link.url4k;
        this.iOSPlexUrl4k = link.iosUrl4k;
      }
      if (tautulliUrl && this.ratingKey) {
        this.tautulliUrl = `${tautulliUrl}/info?rating_key=${this.ratingKey}`;
      }
      if (tautulliUrl && this.ratingKey4k) {
        this.tautulliUrl4k = `${tautulliUrl}/info?rating_key=${this.ratingKey4k}`;
      }
    } else {
      const link = this.playLinkFor(primary === 'emby' ? 'emby' : 'jellyfin');
      if (link.url) {
        this.mediaUrl = link.url;
      }
      if (link.url4k) {
        this.mediaUrl4k = link.url4k;
      }
    }
  }

  @AfterLoad()
  public setServiceUrl(): void {
    // An artist: their page in Lidarr, by their MusicBrainz id.
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

    // An artist: everything of theirs Lidarr is downloading, each item
    // naming its album.
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

    if (this.downloadStatus?.length || this.downloadStatus4k?.length) {
      downloadTracker.keepFresh();
    }
  }
}

export default Media;
