import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { MEDIA_SERVER_KINDS, USER_ID } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { Watchlist } from '@server/entity/Watchlist';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import PreparedEmail, { emailLogoUrl } from '@server/lib/email';
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

let throwawayHash: Promise<string> | undefined;

/**
 * Always false, after the same bcrypt work as checking a real password, so an
 * account without one (or no account) answers as slowly as a wrong password.
 */
export const noPasswordMatches = async (password: string): Promise<false> => {
  throwawayHash ??= bcrypt.hash(randomUUID(), 12);
  await bcrypt.compare(password, await throwawayHash);
  return false;
};

/**
 * Start of a quota window of `days`; requests after it count. Undefined when
 * there's no window, so every request counts.
 */
export const quotaWindowStart = (days?: number | null): Date | undefined => {
  if (!days) {
    return undefined;
  }
  const start = new Date();
  start.setDate(start.getDate() - days);
  return start;
};

/**
 * Whether something asked for at `createdAt` (a movie request, a season or
 * an album) counts towards a quota of `days`.
 */
export const countsTowardsQuota = (
  createdAt: Date,
  days?: number | null
): boolean => {
  const start = quotaWindowStart(days);
  return !start || createdAt > start;
};

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
    'emailVerified',
    'jellyfinDeviceId',
    'jellyfinAuthToken',
    'embyDeviceId',
    'embyAuthToken',
    'plexToken',
    'settings',
    // Whether someone's Plex sign-in lapsed is only for them and admins.
    'plexTokenExpiredAt',
  ];

  public displayName: string;

  /** Media servers this user has a linked account from. */
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

  /**
   * False while the email is one the user set on themselves and hasn't
   * confirmed from it. Such an email gives way to an account a media server
   * or sign-in provider brings with it.
   */
  @Column({ type: 'boolean', default: true })
  public emailVerified: boolean;

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
   * A bigint: Auto-Approve Music is 2^31, beyond an integer column. Postgres
   * returns bigints as text, so the transformer converts them to numbers.
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
   * A rejected token silently stops their watchlist sync. Set on the first
   * rejection so they're notified once, and cleared once a fresh token is
   * stored or Plex accepts the old one again.
   */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public plexTokenExpiredAt?: Date | null;

  /**
   * Request count, filled by `attachRequestCounts` where shown. Not
   * @RelationCount: see MediaRequest.seasonCount.
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

  /** Albums, counted like seasons for series. */
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

  /**
   * Excluded whenever a user is embedded in something else (a request's
   * requester or approver, an issue's reporter, a comment's author, a
   * watchlist's owner).
   *
   * `settings` holds notification credentials (Pushbullet and Pushover tokens,
   * Telegram chat, PGP key) and is loaded with every user, so it's never sent
   * as part of a user; routes that need some of it send it explicitly (upstream
   * GHSA-8j73-j6rc-q8xh).
   *
   * Email, Plex id and Plex sign-in state require Manage Users (User.filter);
   * /auth/me adds back the signed-in user's own.
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

  public async passwordMatch(password: string): Promise<boolean> {
    if (!this.password) {
      return noPasswordMatches(password);
    }
    return bcrypt.compare(password, this.password);
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
          logoUrl: emailLogoUrl(),
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
   * Creates a password reset link valid for a day. The caller stores it, then
   * calls sendResetPasswordEmail.
   */
  public newResetPasswordLink(): void {
    this.resetPasswordGuid = randomUUID();

    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 1);
    this.recoveryLinkExpirationDate = targetDate;
  }

  /** Emails the reset link; never throws, failures are logged. */
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
          logoUrl: emailLogoUrl(),
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

  // The name shown for this user everywhere, to anyone. Never their email:
  // that's only for themselves and user managers.
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

    const movieDate = quotaWindowStart(movieQuotaDays);

    const movieQuotaUsed = movieQuotaLimit
      ? await requestRepository.count({
          where: {
            requestedBy: {
              id: this.id,
            },
            ...(movieDate ? { createdAt: AfterDate(movieDate) } : {}),
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

    const tvDate = quotaWindowStart(tvQuotaDays);
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

    // Each season counts from when it was asked for, so one added to an
    // older request by editing counts too. Pass a Date so the driver writes
    // it in its stored date format. As ISO text, SQLite compared it as a
    // string against 'YYYY-MM-DD HH:MM:SS' and dropped the window's first day.
    const tvQuotaUsed = tvQuotaLimit
      ? Number(
          (
            await tvQuotaUsedQuery
              .andWhere('request.ignoreQuota = :ignoreQuota', {
                ignoreQuota: false,
              })
              .leftJoin(
                'request.seasons',
                'quotaSeason',
                tvDate ? 'quotaSeason.createdAt > :date' : undefined,
                tvDate ? { date: tvDate } : undefined
              )
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

    // Songs count as music, one each, unless Settings → Music gives them their
    // own limit.
    const songQuota = getSettings().music.songQuota;
    const songsApart = !!songQuota?.quotaLimit;
    const songQuotaLimit = songsApart && !canBypass ? songQuota.quotaLimit : 0;
    const songQuotaDays = songsApart ? songQuota.quotaDays : undefined;

    // Albums or songs in music requests within the quota window, counted like
    // seasons for series.
    const countMusic = async (
      kind: 'albums' | 'songs',
      days: number | undefined
    ): Promise<number> => {
      const date = quotaWindowStart(days);
      const query = requestRepository
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
      const counted = await query
        .leftJoin(
          `request.${kind}`,
          'quotaItem',
          date ? 'quotaItem.createdAt > :date' : undefined,
          date ? { date } : undefined
        )
        .select('COUNT(quotaItem.id)', 'itemCount')
        .getRawOne<{ itemCount: string | null }>();
      return Number(counted?.itemCount ?? 0);
    };

    const musicQuotaUsed = musicQuotaLimit
      ? (await countMusic('albums', musicQuotaDays)) +
        (songsApart ? 0 : await countMusic('songs', musicQuotaDays))
      : 0;
    const songQuotaUsed = songQuotaLimit
      ? await countMusic('songs', songQuotaDays)
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
      ...(songsApart
        ? {
            song: {
              days: songQuotaDays,
              limit: songQuotaLimit || undefined,
              used: songQuotaUsed,
              remaining: songQuotaLimit
                ? Math.max(0, songQuotaLimit - songQuotaUsed)
                : undefined,
              restricted: !!(
                songQuotaLimit && songQuotaLimit - songQuotaUsed <= 0
              ),
            },
          }
        : {}),
    };
  }
}
