import type { DiscordBotStatus } from '@server/lib/notifications/discordBot';

/** Settings → Notifications → Discord Bot, as the page gets it: no token. */
export interface DiscordBotSettingsResponse {
  enabled: boolean;
  embedPoster: boolean;
  options: {
    botToken: '';
    applicationId: string;
    guildId: string;
    channelId: string;
  };
  hasBotToken: boolean;
  status: DiscordBotStatus;
}

export interface DiscordBotInfoResponse {
  bot: { id: string; name: string; avatarUrl: string };
  applicationId: string;
  applicationName: string;
  inviteUrl: string;
  requiresCodeGrant: boolean;
  /** Public Bot is on, so anyone could add it to their server. */
  isPublic: boolean;
}

export interface DiscordBotGuild {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface DiscordBotChannel {
  id: string;
  name: string;
  category: string | null;
  /** Null when the bot's permissions there couldn't be worked out. */
  canPost: boolean | null;
}

export interface DiscordBotApprover {
  id: number;
  displayName: string;
  avatar: string;
  linked: boolean;
  shared: boolean;
}

export type DiscordBotTroubleReason =
  | 'token'
  | 'unreachable'
  | 'access'
  | 'permissions'
  | 'other';

export interface DiscordBotTrouble {
  message: string;
  reason?: DiscordBotTroubleReason;
  detail?: string;
}
