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
  /** Optional features turned off for everyone. */
  disabledFeatures: string[];
  /**
   * Countries whose anime does not count as anime unless it is in Japanese
   * (utils/isAnime).
   */
  animeExcludedCountries: string[];
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  hideRequested: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  /** The connected media servers, the primary one first. */
  mediaServers: {
    kind: MediaServerKind;
    name: string;
    primary: boolean;
    signIn: boolean;
  }[];
  /**
   * The single sign-on providers people may sign in with: the switched-on
   * ones, once the Application URL is set.
   */
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
  /** Bazarr is set up, so title pages can show their subtitles. */
  subtitlesReady: boolean;
  /** A Trakt Client ID is set: Trakt links and watchlists can be read. */
  traktReady: boolean;
  /** Lidarr is set up and music is not turned off for everyone. */
  musicReady: boolean;
  /** Whether music comes below the films and series in All (Settings → Music). */
  musicSearch: { inAll: boolean };
  /** The look of everyone who has not chosen their own (Settings → Appearance). */
  themeDefault: ThemeDefaults;
  /** The seasonal themes that run, and their days (Settings → Appearance). */
  seasons: SeasonCalendar;
  /** The Server CSS's version (null for none), and whether people may add their own. */
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
  /** Each image cache; music's covers and artists' pictures as one. */
  imageCache: Record<
    'tmdb' | 'tvdb' | 'avatar' | 'music',
    { size: number; imageCount: number }
  >;
  /**
   * The whole image cache on disk (every source, and any left by older
   * versions) against its limit, in bytes, and whether pictures can be
   * converted to AVIF and WebP here.
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
