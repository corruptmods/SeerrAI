import type { UserDefaultProfile } from '@server/constants/requestDefaults';
import type { NotificationAgentKey } from '@server/lib/settings';

export interface UserSettingsGeneralResponse {
  username?: string;
  email?: string;
  locale?: string;
  discoverRegion?: string;
  streamingRegion?: string;
  originalLanguage?: string;
  movieQuotaLimit?: number;
  movieQuotaDays?: number;
  tvQuotaLimit?: number;
  tvQuotaDays?: number;
  musicQuotaLimit?: number | null;
  musicQuotaDays?: number | null;
  globalMovieQuotaDays?: number;
  globalMovieQuotaLimit?: number;
  globalTvQuotaLimit?: number;
  globalTvQuotaDays?: number;
  globalMusicQuotaLimit?: number;
  globalMusicQuotaDays?: number;
  watchlistSyncMovies?: boolean;
  watchlistSyncTv?: boolean;
  traktUsername?: string | null;
  /** Quality profiles picked for one's own requests, per server. */
  defaultProfiles?: UserDefaultProfile[];
}

export type NotificationAgentTypes = Record<NotificationAgentKey, number>;
export interface UserSettingsNotificationsResponse {
  emailEnabled?: boolean;
  pgpKey?: string;
  discordEnabled?: boolean;
  discordEnabledTypes?: number;
  /** The Discord bot is on, so a manager's Discord user ID lets them approve. */
  discordBotApprovals?: boolean;
  discordIds?: string[];
  pushbulletAccessToken?: string;
  pushoverApplicationToken?: string;
  pushoverUserKey?: string;
  pushoverSound?: string;
  telegramEnabled?: boolean;
  telegramBotUsername?: string;
  telegramChatId?: string;
  telegramMessageThreadId?: string;
  telegramSendSilently?: boolean;
  webPushEnabled?: boolean;
  notificationTypes: Partial<NotificationAgentTypes>;
}
