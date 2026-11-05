import type { PersonalApiKeyAccess } from '@server/constants/apiKeys';
import type { MediaServerKind } from '@server/constants/server';
import type { ThemeDefaults } from '@server/constants/theme';
import type { SeasonCalendar } from '@server/lib/seasons';
import type { DnsEntries, DnsStats } from 'dns-caching';
import type { PaginatedResponse } from './common';

export type LogMessage = {
  timestamp: string;
  level: string;
  label?: string;
  message: string;
  data?: Record<string, unknown>;
};

export interface LogsResultsResponse extends PaginatedResponse {
  results: LogMessage[];
}

export interface SettingsAboutResponse {
  version: string;
  totalRequests: number;
  totalMediaItems: number;
  tz?: string;
  appDataPath: string;
}

export interface PublicSettingsResponse {
  jellyfinHost?: string;
  jellyfinExternalHost?: string;
  jellyfinServerName?: string;
  jellyfinForgotPasswordUrl?: string;
  embyExternalHost?: string;
  embyForgotPasswordUrl?: string;
  initialized: boolean;
  applicationTitle: string;
  applicationUrl: string;
  /** Optional features disabled for everyone. */
  disabledFeatures: string[];
  /** Countries whose anime counts as anime only in Japanese (utils/isAnime). */
  animeExcludedCountries: string[];
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  hideRequested: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  /** Who may create personal API keys (profile API Keys tab). */
  personalApiKeys: PersonalApiKeyAccess;
  /** Connected media servers, primary first. */
  mediaServers: {
    kind: MediaServerKind;
    name: string;
    primary: boolean;
    signIn: boolean;
  }[];
  /** Enabled SSO providers; empty until the Application URL is set. */
  oidcProviders: { id: string; name: string; logoUrl: string }[];
  movie4kEnabled: boolean;
  series4kEnabled: boolean;
  discoverRegion: string;
  streamingRegion: string;
  originalLanguage: string;
  mediaServerType: number;
  partialRequestsEnabled: boolean;
  enableSpecialEpisodes: boolean;
  cacheImages: boolean;
  vapidPublic: string;
  enablePushRegistration: boolean;
  locale: string;
  emailEnabled: boolean;
  newPlexLogin: boolean;
  youtubeUrl: string;
  versionCheck: boolean;
  plexClientIdentifier: string;
  aiReady: boolean;
  /** Bazarr is set up, so title pages can show subtitles. */
  subtitlesReady: boolean;
  /** A Trakt Client ID is set. */
  traktReady: boolean;
  /** Lidarr is set up and music is not disabled for everyone. */
  musicReady: boolean;
  /** All search lists music below movies and series (Settings → Music). */
  musicSearch: { inAll: boolean };
  /** Single songs can be requested (Settings → Music). */
  musicSongs: boolean;
  /** Default theme for users without their own (Settings → Appearance). */
  themeDefault: ThemeDefaults;
  /** Active seasonal themes and their dates (Settings → Appearance). */
  seasons: SeasonCalendar;
  /** Server CSS version (null for none); whether users may add their own. */
  customCss: { server: string | null; personal: boolean };
}

export interface CacheItem {
  id: string;
  name: string;
  stats: {
    hits: number;
    misses: number;
    keys: number;
    ksize: number;
    vsize: number;
  };
}

export interface CacheResponse {
  apiCaches: CacheItem[];
  /** Per image cache; music covers and artist pictures share one. */
  imageCache: Record<
    'tmdb' | 'tvdb' | 'avatar' | 'music',
    { size: number; imageCount: number }
  >;
  /**
   * Whole on-disk image cache (all sources, including older versions'
   * leftovers) and its limit in bytes, plus whether AVIF/WebP conversion is
   * available.
   */
  imageCacheTotal: { size: number; limit: number; conversion: boolean };
  dnsCache: {
    stats: DnsStats | undefined;
    entries: DnsEntries | undefined;
  };
}

export interface StatusResponse {
  version: string;
  commitTag: string;
  updateAvailable?: boolean;
  commitsBehind?: number;
  restartRequired: boolean;
}
