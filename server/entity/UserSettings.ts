import type { Appearance } from '@server/constants/theme';
import { cleanAppearance } from '@server/constants/theme';
import type { NotificationAgentTypes } from '@server/interfaces/api/userSettingsInterfaces';
import {
  hasNotificationType,
  Notification,
  WEB_PUSH_STARTING_TYPES,
} from '@server/lib/notifications';
import { NotificationAgentKey } from '@server/lib/settings';
import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './User';

export const ALL_NOTIFICATIONS = Object.values(Notification)
  .filter((v) => !isNaN(Number(v)))
  .reduce((a, v) => a + Number(v), 0);

// Converts between the DB's JSON string and a string array.
const jsonArrayTransformer = {
  from: (v: string | null): string[] => {
    try {
      return v ? JSON.parse(v) : [];
    } catch {
      return [];
    }
  },
  to: (v: string[] | null): string | null =>
    v?.length ? JSON.stringify(v) : null,
};

/** Likewise, for a number array. */
const jsonNumberArrayTransformer = {
  from: (v: string | null): number[] => {
    try {
      const parsed = v ? JSON.parse(v) : [];
      return Array.isArray(parsed)
        ? parsed.filter((n): n is number => Number.isInteger(n))
        : [];
    } catch {
      return [];
    }
  },
  to: (v: number[] | null): string | null =>
    v?.length ? JSON.stringify(v) : null,
};

/** A user's look as JSON; null (or anything unreadable) for none. */
const appearanceTransformer = {
  from: (v: string | null): Appearance | null => {
    try {
      return (v && cleanAppearance(JSON.parse(v))) || null;
    } catch {
      return null;
    }
  },
  to: (v: Appearance | null | undefined): string | null | undefined =>
    v === undefined ? undefined : v ? JSON.stringify(v) : null,
};

@Entity()
export class UserSettings {
  constructor(init?: Partial<UserSettings>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @OneToOne(() => User, (user) => user.settings, { onDelete: 'CASCADE' })
  @JoinColumn()
  public user: User;

  @Column({ default: '' })
  public locale?: string;

  @Column({ nullable: true })
  public discoverRegion?: string;

  @Column({ nullable: true })
  public streamingRegion?: string;

  @Column({ nullable: true })
  public originalLanguage?: string;

  @Column({ nullable: true })
  public pgpKey?: string;

  @Column({ type: 'text', nullable: true, transformer: jsonArrayTransformer })
  public discordIds: string[];

  @Column({ nullable: true })
  public pushbulletAccessToken?: string;

  @Column({ nullable: true })
  public pushoverApplicationToken?: string;

  @Column({ nullable: true })
  public pushoverUserKey?: string;

  @Column({ nullable: true })
  public pushoverSound?: string;

  @Column({ nullable: true })
  public telegramChatId?: string;

  @Column({ nullable: true })
  public telegramMessageThreadId?: string;

  @Column({ nullable: true })
  public telegramSendSilently?: boolean;

  /** Optional features (see constants/features) this user turned off. */
  @Column({ type: 'text', nullable: true, transformer: jsonArrayTransformer })
  public disabledFeatures: string[];

  /** Home page rows (discover slider ids) this user hid. */
  @Column({
    type: 'text',
    nullable: true,
    transformer: jsonNumberArrayTransformer,
  })
  public hiddenSliders: number[];

  /**
   * This user's Networks row list as JSON (see
   * server/constants/discoverNetworks.ts); null for the default.
   */
  @Column({ type: 'text', nullable: true })
  public discoverNetworks?: string | null;

  /**
   * This user's sidebar and phone menu order as item names (see
   * server/constants/navigation.ts); empty for the default.
   */
  @Column({ type: 'text', nullable: true, transformer: jsonArrayTransformer })
  public sidebarOrder: string[];

  /** Sidebar and phone menu items this user hid. */
  @Column({ type: 'text', nullable: true, transformer: jsonArrayTransformer })
  public sidebarHidden: string[];

  /**
   * This user's look (Profile → Settings → Appearance); null for the server
   * default.
   */
  @Column({ type: 'text', nullable: true, transformer: appearanceTransformer })
  public appearance?: Appearance | null;

  /**
   * Their answer to a seasonal theme's first-time note: '<season>-<start
   * year>:keep' or ':off' (server/lib/seasons).
   */
  @Column({ type: 'text', nullable: true })
  public seasonNote?: string | null;

  /**
   * This user's CSS (Profile → Settings → Appearance), used only while an admin
   * allows personal CSS; checked by checkPersonalCss before storing and again
   * when served.
   */
  @Column({ type: 'text', nullable: true })
  public customCss?: string | null;

  /**
   * Trakt username, for requesting their public Trakt watchlist (with
   * watchlistSyncMovies / watchlistSyncTv, as for Plex).
   */
  @Column({ type: 'text', nullable: true })
  public traktUsername?: string | null;

  @Column({ nullable: true })
  public watchlistSyncMovies?: boolean;

  @Column({ nullable: true })
  public watchlistSyncTv?: boolean;

  @Column({
    type: 'text',
    nullable: true,
    transformer: {
      from: (value: string | null): Partial<NotificationAgentTypes> => {
        const defaultTypes = {
          email: ALL_NOTIFICATIONS,
          discord: 0,
          pushbullet: 0,
          pushover: 0,
          slack: 0,
          telegram: 0,
          webhook: 0,
          webpush: WEB_PUSH_STARTING_TYPES,
        };
        if (!value) {
          return defaultTypes;
        }

        const values = JSON.parse(value) as Partial<NotificationAgentTypes>;

        // A past migration sometimes left a raw "2" here; fall back to the
        // default types.
        if (typeof values !== 'object') {
          return defaultTypes;
        }

        if (values.email == null) {
          values.email = ALL_NOTIFICATIONS;
        }

        if (values.webpush == null) {
          values.webpush = WEB_PUSH_STARTING_TYPES;
        }

        return values;
      },
      to: (value: Partial<NotificationAgentTypes>): string | null => {
        if (!value || typeof value !== 'object') {
          return null;
        }

        const allowedKeys = Object.values(NotificationAgentKey);

        // Drop unknown notification agent keys before saving.
        (Object.keys(value) as (keyof NotificationAgentTypes)[]).forEach(
          (key) => {
            if (!allowedKeys.includes(key)) {
              delete value[key];
            }
          }
        );

        return JSON.stringify(value);
      },
    },
  })
  public notificationTypes: Partial<NotificationAgentTypes>;

  public hasNotificationType(
    key: NotificationAgentKey,
    type: Notification
  ): boolean {
    return hasNotificationType(type, this.notificationTypes[key] ?? 0);
  }
}
