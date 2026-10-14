import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { MEDIA_SERVER_KINDS, USER_ID } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { Watchlist } from '@server/entity/Watchlist';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import PreparedEmail from '@server/lib/email';
import type { PermissionCheckOptions } from '@server/lib/permissions';
import { Permission, hasPermission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  DbAwareColumn,
  bigNumber,
  resolveDbType,
} from '@server/utils/DbColumnHelper';
import { AfterDate } from '@server/utils/dateHelpers';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import path from 'path';
import {
  AfterLoad,
  Column,
  Entity,
  Not,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import Issue from './Issue';
import { MediaRequest } from './MediaRequest';
import { UserPushSubscription } from './UserPushSubscription';
import { UserSettings } from './UserSettings';

@Entity()
export class User {
  public static filterMany(
    users: User[],
    showFiltered?: boolean
  ): Partial<User>[] {
    return users.map((u) => u.filter(showFiltered));
  }

  static readonly filteredFields: string[] = [
    'email',
    'plexId',
    'password',
    'resetPasswordGuid',
    'jellyfinDeviceId',
    'jellyfinAuthToken',
    'embyDeviceId',
    'embyAuthToken',
    'plexToken',
    'settings',
    // Whether someone's Plex sign-in lapsed is their business (and admins').
    'plexTokenExpiredAt',
  ];

  public displayName: string;

  /** The media servers this person has an account linked from. */
  public linkedServers?: MediaServerKind[];

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({
    unique: true,
    transformer: {
      from: (value: string): string => (value ?? '').toLowerCase(),
      to: (value: string): string => (value ?? '').toLowerCase(),
    },
  })
  public email: string;

  @Column({ type: 'varchar', nullable: true })
  public plexUsername?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public jellyfinUsername?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public embyUsername?: string | null;

  @Column({ nullable: true })
  public username?: string;

  @Column({ nullable: true, select: false })
  public password?: string;

  @Column({ nullable: true, select: false })
  public resetPasswordGuid?: string;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public recoveryLinkExpirationDate?: Date | null;

  @Column({ type: 'integer', default: UserType.PLEX })
  public userType: UserType;

  @Column({ type: 'integer', nullable: true, select: true })
  public plexId?: number | null;

  @Column({ type: 'varchar', nullable: true })
  public jellyfinUserId?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  public jellyfinDeviceId?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  public jellyfinAuthToken?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public embyUserId?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  public embyDeviceId?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  public embyAuthToken?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  public plexToken?: string | null;

  /**
   * A bigint: Auto-Approve Music is 2^31, past what an integer column
   * holds. Postgres hands bigints back as text, so they are read back as
   * numbers.
   */
  @Column({ type: 'bigint', default: 0, transformer: bigNumber })
  public permissions = 0;

  @Column()
  public avatar: string;

  @Column({ type: 'varchar', nullable: true })
  public avatarETag?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public avatarVersion?: string | null;

  /**
   * When Plex last rejected this user's token during watchlist sync.
   *
   * A rejected token silently stops the user's watchlist from syncing, and
   * nothing told them. This latches on the first rejection so they are
   * notified once, not every sync, and clears as soon as a fresh token is
   * stored or Plex accepts the old one again.
   */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public plexTokenExpiredAt?: Date | null;

  /**
   * Request count, filled in by `attachRequestCounts` where it is displayed.
   * See the note on MediaRequest.seasonCount for why not @RelationCount.
   */
  public requestCount = 0;

  @OneToMany(() => MediaRequest, (request) => request.requestedBy)
  public requests: MediaRequest[];

  @OneToMany(() => Watchlist, (watchlist) => watchlist.requestedBy)
  public watchlists: Watchlist[];

  @Column({ nullable: true })
  public movieQuotaLimit?: number;

  @Column({ nullable: true })
  public movieQuotaDays?: number;

  @Column({ nullable: true })
  public tvQuotaLimit?: number;

  @Column({ nullable: true })
  public tvQuotaDays?: number;

  /** Albums, counted as seasons are for series. */
  @Column({ type: 'int', nullable: true })
  public musicQuotaLimit?: number | null;

  @Column({ type: 'int', nullable: true })
  public musicQuotaDays?: number | null;

  @OneToOne(() => UserSettings, (settings) => settings.user, {
    cascade: true,
    eager: true,
    onDelete: 'CASCADE',
  })
  public settings?: UserSettings;

  @OneToMany(() => UserPushSubscription, (pushSub) => pushSub.user)
  public pushSubscriptions: UserPushSubscription[];

  @OneToMany(() => Issue, (issue) => issue.createdBy, { cascade: true })
  public createdIssues: Issue[];

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  public warnings: string[] = [];

  constructor(init?: Partial<User>) {
    Object.assign(this, init);
  }

  /*
   * Someone's own settings hold their notification credentials (Pushbullet
   * and Pushover tokens, Telegram chat, PGP key). The relation is loaded
   * with every user, so it rode along wherever a user is embedded: a
   * request's requester, an issue comment's author, a watchlist's owner.
   * Never sent as part of a user; a route that needs some of them sends
   * those explicitly. (Upstream GHSA-8j73-j6rc-q8xh.)
   */
  /**
   * Left out whenever a user is sent as part of something else: the
   * requester or approver on a request, an issue's reporter, a comment's
   * author. Seeing someone's email, Plex id or Plex sign-in state takes
   * Manage Users (User.filter); /auth/me adds back the signed-in user's own.
   */
  static readonly serializationExcludedFields: string[] = [
    'settings',
    'email',
    'plexId',
    'plexTokenExpiredAt',
  ];

  public toJSON(): Partial<User> {
    return Object.assign(
      {},
      ...(Object.keys(this) as (keyof User)[])
        .filter((k) => !User.serializationExcludedFields.includes(k))
        .map((k) => ({ [k]: this[k] }))
    );
  }

  public filter(showFiltered?: boolean): Partial<User> {
    const filtered: Partial<User> = Object.assign(
      {},
      ...(Object.keys(this) as (keyof User)[])
        .filter((k) => showFiltered || !User.filteredFields.includes(k))
        .map((k) => ({ [k]: this[k] }))
    );

    return filtered;
  }

  public hasPermission(
    permissions: Permission | Permission[],
    options?: PermissionCheckOptions
  ): boolean {
    return !!hasPermission(permissions, this.permissions, options);
  }

  public passwordMatch(password: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.password) {
        resolve(bcrypt.compare(password, this.password));
      } else {
        return resolve(false);
      }
    });
  }

  public async setPassword(password: string): Promise<void> {
    const hashedPassword = await bcrypt.hash(password, 12);
    this.password = hashedPassword;
  }

  public async generatePassword(): Promise<void> {
    const password = nanoid(16);
    await this.setPassword(password);

    const { applicationTitle, applicationUrl } = getSettings().main;
    try {
      logger.info(`Sending generated password email for ${this.email}`, {
        label: 'User Management',
      });

      const email = new PreparedEmail(getSettings().notifications.agents.email);
      await email.send({
        template: path.join(__dirname, '../templates/email/generatedpassword'),
        message: {
          to: this.email,
        },
        locals: {
          password: password,
          applicationUrl,
          applicationTitle,
          recipientName: this.username,
        },
      });
    } catch (e) {
      logger.error('Failed to send out generated password email', {
        label: 'User Management',
        message: e.message,
      });
    }
  }

  /**
   * A new password reset link, good for a day. Stored by the caller, then
   * sent with sendResetPasswordEmail.
   */
  public newResetPasswordLink(): void {
    this.resetPasswordGuid = randomUUID();

    // 24 hours into the future
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 1);
    this.recoveryLinkExpirationDate = targetDate;
  }

  /** Emails the reset link; never fails, a failure is logged. */
  public async sendResetPasswordEmail(): Promise<void> {
    const { applicationTitle, applicationUrl } = getSettings().main;
    const resetPasswordLink = `${applicationUrl}/resetpassword/${this.resetPasswordGuid}`;

    try {
      logger.info(`Sending reset password email for ${this.email}`, {
        label: 'User Management',
      });
      const email = new PreparedEmail(getSettings().notifications.agents.email);
      await email.send({
        template: path.join(__dirname, '../templates/email/resetpassword'),
        message: {
          to: this.email,
        },
        locals: {
          resetPasswordLink,
          applicationUrl,
          applicationTitle,
          recipientName: this.displayName,
          recipientEmail: this.email,
        },
      });
    } catch (e) {
      logger.error('Failed to send out reset password email', {
        label: 'User Management',
        message: e.message,
      });
    }
  }

  /*
   * The name shown for someone wherever they appear, to anyone. Never their
   * email: that is only for themselves and whoever manages users.
   */
  @AfterLoad()
  public setDisplayName(): void {
    this.displayName =
      this.username ||
      this.plexUsername ||
      this.jellyfinUsername ||
      this.embyUsername ||
      `User #${this.id}`;
  }

  @AfterLoad()
  public setLinkedServers(): void {
    this.linkedServers = MEDIA_SERVER_KINDS.filter(
      (kind) => !!this[USER_ID[kind]]
    );
  }

  public async getQuota(): Promise<QuotaResponse> {
    const {
      main: { defaultQuotas },
    } = getSettings();
    const requestRepository = getRepository(MediaRequest);
    const canBypass = this.hasPermission([Permission.MANAGE_USERS], {
      type: 'or',
    });

    const movieQuotaLimit = !canBypass
      ? (this.movieQuotaLimit ?? defaultQuotas.movie.quotaLimit)
      : 0;
    const movieQuotaDays = this.movieQuotaDays ?? defaultQuotas.movie.quotaDays;

    // Count movie requests made during quota period
    const movieDate = new Date();
    if (movieQuotaDays) {
      movieDate.setDate(movieDate.getDate() - movieQuotaDays);
    }

    const movieQuotaUsed = movieQuotaLimit
      ? await requestRepository.count({
          where: {
            requestedBy: {
              id: this.id,
            },
            ...(movieQuotaDays ? { createdAt: AfterDate(movieDate) } : {}),
            type: MediaType.MOVIE,
            status: Not(MediaRequestStatus.DECLINED),
            ignoreQuota: false,
          },
        })
      : 0;

    const tvQuotaLimit = !canBypass
      ? (this.tvQuotaLimit ?? defaultQuotas.tv.quotaLimit)
      : 0;
    const tvQuotaDays = this.tvQuotaDays ?? defaultQuotas.tv.quotaDays;

    // Count tv season requests made during quota period
    const tvDate = new Date();
    if (tvQuotaDays) {
      tvDate.setDate(tvDate.getDate() - tvQuotaDays);
    }
    const tvQuotaStartDate = tvDate.toJSON();
    const tvQuotaUsedQuery = requestRepository
      .createQueryBuilder('request')
      .leftJoin('request.requestedBy', 'requestedBy')
      .where('request.type = :requestType', {
        requestType: MediaType.TV,
      })
      .andWhere('requestedBy.id = :userId', {
        userId: this.id,
      })
      .andWhere('request.status != :declinedStatus', {
        declinedStatus: MediaRequestStatus.DECLINED,
      });

    if (tvQuotaDays) {
      tvQuotaUsedQuery.andWhere('request.createdAt > :date', {
        date: tvQuotaStartDate,
      });
    }

    const tvQuotaUsed = tvQuotaLimit
      ? Number(
          (
            await tvQuotaUsedQuery
              .andWhere('request.ignoreQuota = :ignoreQuota', {
                ignoreQuota: false,
              })
              .leftJoin('request.seasons', 'quotaSeason')
              .select('COUNT(quotaSeason.id)', 'seasonCount')
              .getRawOne<{ seasonCount: string | null }>()
          )?.seasonCount ?? 0
        )
      : 0;

    const musicQuotaLimit = !canBypass
      ? (this.musicQuotaLimit ?? defaultQuotas.music?.quotaLimit)
      : 0;
    const musicQuotaDays =
      this.musicQuotaDays ?? defaultQuotas.music?.quotaDays;

    // Count the albums in music requests made during the quota period, as
    // seasons are counted for series.
    const musicDate = new Date();
    if (musicQuotaDays) {
      musicDate.setDate(musicDate.getDate() - musicQuotaDays);
    }
    const musicQuotaUsedQuery = requestRepository
      .createQueryBuilder('request')
      .leftJoin('request.requestedBy', 'requestedBy')
      .where('request.type = :requestType', {
        requestType: MediaType.MUSIC,
      })
      .andWhere('requestedBy.id = :userId', { userId: this.id })
      .andWhere('request.status != :declinedStatus', {
        declinedStatus: MediaRequestStatus.DECLINED,
      })
      .andWhere('request.ignoreQuota = :ignoreQuota', { ignoreQuota: false });

    if (musicQuotaDays) {
      musicQuotaUsedQuery.andWhere('request.createdAt > :date', {
        date: musicDate.toJSON(),
      });
    }

    const musicQuotaUsed = musicQuotaLimit
      ? Number(
          (
            await musicQuotaUsedQuery
              .leftJoin('request.albums', 'quotaAlbum')
              .select('COUNT(quotaAlbum.id)', 'albumCount')
              .getRawOne<{ albumCount: string | null }>()
          )?.albumCount ?? 0
        )
      : 0;

    return {
      movie: {
        days: movieQuotaDays,
        limit: movieQuotaLimit,
        used: movieQuotaUsed,
        remaining: movieQuotaLimit
          ? Math.max(0, movieQuotaLimit - movieQuotaUsed)
          : undefined,
        restricted: !!(
          movieQuotaLimit && movieQuotaLimit - movieQuotaUsed <= 0
        ),
      },
      tv: {
        days: tvQuotaDays,
        limit: tvQuotaLimit,
        used: tvQuotaUsed,
        remaining: tvQuotaLimit
          ? Math.max(0, tvQuotaLimit - tvQuotaUsed)
          : undefined,
        restricted: !!(tvQuotaLimit && tvQuotaLimit - tvQuotaUsed <= 0),
      },
      music: {
        days: musicQuotaDays,
        limit: musicQuotaLimit ?? undefined,
        used: musicQuotaUsed,
        remaining: musicQuotaLimit
          ? Math.max(0, musicQuotaLimit - musicQuotaUsed)
          : undefined,
        restricted: !!(
          musicQuotaLimit && musicQuotaLimit - musicQuotaUsed <= 0
        ),
      },
    };
  }
}
