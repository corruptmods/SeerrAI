import type { PersonalApiKeyAccess } from '@server/constants/apiKeys';
import type { AiFeature } from '@server/constants/features';
import { DEFAULT_IMAGE_CACHE_MAX_MB } from '@server/constants/images';
import type { OidcClaimRule } from '@server/constants/oidc';
import { oidcApplicationUrl, requiredClaimsFrom } from '@server/constants/oidc';
import type { ProfileFolder } from '@server/constants/requestDefaults';
import type { MediaServerKind } from '@server/constants/server';
import {
  MEDIA_SERVER_KINDS,
  MediaServerType,
  kindOfType,
} from '@server/constants/server';
import type { ThemeDefaults } from '@server/constants/theme';
import {
  SERVER_THEME_DEFAULTS,
  cleanThemeDefaults,
} from '@server/constants/theme';
import { cssVersion } from '@server/lib/customCss';
import { Permission } from '@server/lib/permissions';
import type { QualitySettings } from '@server/lib/quality/types';
import {
  ADJUSTMENT_DEFAULTS,
  QUALITY_DEFAULTS,
} from '@server/lib/quality/types';
import type { SeasonCalendar, SeasonsSettings } from '@server/lib/seasons';
import { seasonCalendar, seasonSettings } from '@server/lib/seasons';
import {
  runMigrations,
  writeSettingsFile,
} from '@server/lib/settings/migrator';
import type { AvailableLocale } from '@server/types/languages';
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs/promises';
import { mergeWith } from 'lodash';
import path from 'path';
import webpush from 'web-push';

// Replace arrays wholesale so shorter incoming arrays leave no stale entries.
const mergeSettings = <T>(current: T, incoming: Partial<T>): T =>
  mergeWith({}, current, incoming, (_objValue, srcValue) =>
    Array.isArray(srcValue) ? srcValue : undefined
  ) as T;

export interface Library {
  id: string;
  name: string;
  enabled: boolean;
  type: 'show' | 'movie';
  lastScan?: number;
}

/**
 * A music library ('artist' on Plex, 'music' on Jellyfin/Emby). A separate
 * type so film/series code can't be handed one.
 */
export interface MusicLibrary extends Omit<Library, 'type'> {
  type: 'artist' | 'music';
}

export interface Region {
  iso_3166_1: string;
  english_name: string;
  name?: string;
}

export interface Language {
  iso_639_1: string;
  english_name: string;
  name: string;
}

export interface PlexSettings {
  name: string;
  machineId?: string;
  ip: string;
  port: number;
  useSsl?: boolean;
  libraries: Library[];
  /** Kept apart from `libraries` so film/series scans and history skip them. */
  musicLibraries: MusicLibrary[];
  webAppUrl?: string;
  /** Seerr is connected to this server (see lib/mediaServers). */
  connected?: boolean;
  /** People may sign in with their account on this server. */
  signIn?: boolean;
}

/** A Jellyfin or an Emby server: both are set up the same way. */
export interface JellyfinSettings {
  name: string;
  ip: string;
  port: number;
  useSsl?: boolean;
  urlBase?: string;
  externalHostname?: string;
  jellyfinForgotPasswordUrl?: string;
  libraries: Library[];
  /** Kept apart from `libraries`, as on Plex. */
  musicLibraries: MusicLibrary[];
  serverId: string;
  apiKey: string;
  /** Seerr is connected to this server (see lib/mediaServers). */
  connected?: boolean;
  /** People may sign in with their account on this server. */
  signIn?: boolean;
  /** Account Seerr reads libraries as; defaults to user 1's linked account. */
  adminUserId?: string;
}

/** Default music settings. */
export const musicDefaults = (): MusicSettings => ({
  musicbrainzUrl: MUSICBRAINZ_URL,
  contactEmail: '',
  listenBrainz: true,
  deezer: true,
  theAudioDbApiKey: '',
  maxAlbumsPerRequest: 100,
  songRequests: true,
  songsFromAlbums: true,
  songQuota: { quotaLimit: 0, quotaDays: 7 },
  playlists: { overLimit: 'wait', approveOver: 25 },
  soulseek: { url: '', apiKey: '', downloadsPath: '' },
  search: {},
});

/** An unconfigured Jellyfin or Emby server. */
export const jellyfinDefaults = (): JellyfinSettings => ({
  name: '',
  ip: '',
  port: 8096,
  useSsl: false,
  urlBase: '',
  externalHostname: '',
  jellyfinForgotPasswordUrl: '',
  libraries: [],
  musicLibraries: [],
  serverId: '',
  apiKey: '',
  connected: false,
  signIn: true,
});

/**
 * Connected media servers, primary (main.mediaServerType) first; the primary
 * always counts as connected. Helpers live in lib/mediaServers.
 */
export const connectedKindsOf = (
  settings: Pick<AllSettings, 'main' | 'plex' | 'jellyfin' | 'emby'>
): MediaServerKind[] => {
  const primary = kindOfType(settings.main.mediaServerType);
  return [
    ...(primary ? [primary] : []),
    ...MEDIA_SERVER_KINDS.filter(
      (kind) => kind !== primary && !!settings[kind]?.connected
    ),
  ];
};

/** Usenet clients, then torrent clients. */
export const DOWNLOAD_CLIENT_TYPES = [
  'sabnzbd',
  'nzbget',
  'qbittorrent',
  'transmission',
  'deluge',
  'rtorrent',
] as const;
export type DownloadClientType = (typeof DOWNLOAD_CLIENT_TYPES)[number];

/**
 * A download client read directly for per-second progress (Radarr/Sonarr
 * poll once a minute). Read-only; matched by the download id the *arr records.
 */
export interface DownloadClientSettings {
  id: number;
  name: string;
  type: DownloadClientType;
  hostname: string;
  port: number;
  useSsl: boolean;
  urlBase: string;
  /** SABnzbd's API key. */
  apiKey: string;
  /**
   * Login (qBittorrent Web UI, Transmission RPC, NZBGet/rTorrent basic auth);
   * empty when the client allows this address. Deluge uses only a password.
   */
  username: string;
  password: string;
}

/**
 * Backfill: searches Prowlarr for titles the *arrs couldn't find, judges
 * packs by their files, and imports through Sonarr/Radarr once an admin
 * approves. Downloads use the clients above, under their own category.
 */
export type DownloadCheckMode = 'off' | 'report' | 'on';

export interface BackfillSettings {
  enabled: boolean;
  prowlarr: {
    hostname: string;
    port: number;
    useSsl: boolean;
    urlBase: string;
    apiKey: string;
  };
  /** Ids from `downloadClients`; null leaves that protocol out. */
  torrentClientId: number | null;
  usenetClientId: number | null;
  category: string;
  /** Also handle movies Radarr can't find. */
  includeMovies: boolean;
  /** Also handle albums Lidarr can't find. */
  includeMusic: boolean;
  /** Hours after the *arr's last search before a title counts as stuck. */
  stuckAfterHours: number;
  /**
   * Hours a new episode is left to Sonarr after it airs before Backfill may
   * fetch it, even for a show just requested. 0 doesn't wait.
   */
  newEpisodeWaitHours: number;
  /**
   * Search new requests as soon as the *arr finds nothing, not after Stuck
   * After.
   */
  searchAfterArr: boolean;
  /** Treat episodes below the profile cutoff as gaps. */
  includeCutoffUnmet: boolean;
  includeSpecials: boolean;
  /** Titles searched per scan, to spare indexers. */
  searchesPerScan: number;
  /** Days before re-searching a title with no results. */
  researchAfterDays: number;
  autoApprove: {
    enabled: boolean;
    minScore: number;
    maxSizeGb: number;
  };
  /** Concurrent series downloads per client. */
  maxActiveJobs: number;
  /** Concurrent movie downloads per client. */
  maxMovieJobs: number;
  /** Concurrent music downloads per client. */
  maxMusicJobs: number;
  /** New downloads wait while the title's disk has less free than this. */
  minFreeSpaceGb: number;
  /** Give up on a torrent stalled this long; offer the next pack. 0 never. */
  stallHours: number;
  /**
   * Abandon a torrent whose pace (two consecutive 2-hour windows) projects a
   * finish beyond this, and offer the next pack. 0 never.
   */
  slowHours: number;
  /**
   * Replace a failed or stalled download with the next good pack for the same
   * episodes (auto-approve's score and size) until none remain.
   */
  replaceFailed: boolean;
  /**
   * Days nightly maintenance keeps finished downloads and leftover packs. 0
   * forever.
   */
  historyDays: number;
  /**
   * Blocked release groups: skipped by Backfill and the agent, rejected in
   * Radarr/Sonarr via a custom format (lib/blockedGroups.ts). Changed only
   * through their own route, never by saving these settings.
   */
  blockedGroups: string[];
  /**
   * Download Check (lib/downloadCheck): inspects Radarr/Sonarr grabs before
   * download and on stuck imports. Independent of Backfill; own route only.
   */
  downloadCheck: {
    /** report: log what it would do; on: do it. */
    mode: DownloadCheckMode;
  };
  /** Admin agent: AI that digs further when Backfill finds nothing, or on ask. */
  agent: {
    /** Auto-start for requested titles Backfill found nothing for. */
    autoRun: boolean;
    /** Max auto-started runs per day. */
    maxAutoRunsPerDay: number;
    /** Max downloads per day, auto or asked. */
    maxGrabsPerDay: number;
    /** Max tool calls per run. */
    maxSteps: number;
    /**
     * Auto-continuations after a turn's step budget, while progressing, before
     * waiting for a reply.
     */
    autoContinue: number;
    /** Max download size, GB. */
    maxSizeGb: number;
    /** Standing admin instructions. */
    instructions: string;
    /** Days to keep finished conversations; 0 forever. */
    keepDays: number;
  };
  /**
   * A title on a quality preset with no grab in `days` moves to the next
   * looser preset, and back once something is grabbed (lib/quality/stepDown).
   * Off by default.
   */
  stepDown: {
    enabled: boolean;
    days: number;
  };
}

export const BACKFILL_DEFAULTS: BackfillSettings = {
  enabled: false,
  prowlarr: {
    hostname: '',
    port: 9696,
    useSsl: false,
    urlBase: '',
    apiKey: '',
  },
  torrentClientId: null,
  usenetClientId: null,
  category: 'backfill',
  includeMovies: true,
  includeMusic: true,
  stuckAfterHours: 24,
  newEpisodeWaitHours: 12,
  searchAfterArr: false,
  includeCutoffUnmet: false,
  includeSpecials: false,
  searchesPerScan: 5,
  researchAfterDays: 7,
  autoApprove: { enabled: false, minScore: 700, maxSizeGb: 25 },
  maxActiveJobs: 2,
  maxMovieJobs: 2,
  maxMusicJobs: 2,
  minFreeSpaceGb: 200,
  stallHours: 12,
  slowHours: 72,
  replaceFailed: true,
  historyDays: 90,
  blockedGroups: [],
  downloadCheck: { mode: 'off' },
  agent: {
    autoRun: true,
    maxAutoRunsPerDay: 12,
    maxGrabsPerDay: 10,
    maxSteps: 30,
    autoContinue: 3,
    maxSizeGb: 40,
    instructions: '',
    keepDays: 30,
  },
  stepDown: { enabled: false, days: 30 },
};

/**
 * Bazarr, for on-disk subtitles and subtitle search/download/delete/transcribe.
 * One instance: Bazarr itself follows one Radarr and one Sonarr.
 */
export interface BazarrSettings {
  hostname: string;
  port: number;
  useSsl: boolean;
  urlBase: string;
  apiKey: string;
}

/**
 * An OpenID Connect sign-in provider (Authentik, Authelia, Keycloak, Pocket ID,
 * Google…).
 */
export interface OidcProviderSettings {
  /** Derived from the name on creation and never changed: links refer to it. */
  id: string;
  /** Button text: "Sign in with {name}". */
  name: string;
  issuerUrl: string;
  clientId: string;
  /** Never sent back to a browser. */
  clientSecret: string;
  /** Button image; blank for none. */
  logoUrl: string;
  scopes: string;
  enabled: boolean;
  /** Create an account on first sign-in. Off by default. */
  newUserSignUp: boolean;
  /**
   * All rules must match the provider's claims. Empty allows anyone with an
   * account there.
   */
  requiredClaims: OidcClaimRule[];
}

export interface OidcSettings {
  providers: OidcProviderSettings[];
}

/**
 * A Maintainerr server: Seerr reads pending deletions to warn users and can
 * postpone one. Feature switches are per server.
 */
export interface MaintainerrSettings {
  id: number;
  name: string;
  hostname: string;
  port: number;
  useSsl: boolean;
  urlBase: string;
  /** For a proxy in front; Maintainerr itself needs none. */
  apiKey: string;
  /** "Deleting soon" badge on posters and title pages. */
  showBadges: boolean;
  /** Include its titles in the home "Deleting Soon" row. */
  showDeletingSoon: boolean;
  /** Keep button for any signed-in user, postponing deletion. */
  allowKeep: boolean;
  /** Days a Keep adds. 0 restarts the rule's whole grace period. */
  keepDays: number;
  /** Days ahead a deletion counts as "soon". */
  soonDays: number;
}

export interface TautulliSettings {
  hostname?: string;
  port?: number;
  useSsl?: boolean;
  urlBase?: string;
  apiKey?: string;
  externalUrl?: string;
}

/**
 * Trakt public lists and watchlists, via the admin's app Client ID only; no
 * Trakt sign-in.
 */
export interface TraktSettings {
  clientId?: string;
}

export interface DVRSettings {
  id: number;
  name: string;
  hostname: string;
  port: number;
  apiKey: string;
  useSsl: boolean;
  baseUrl?: string;
  activeProfileId: number;
  activeProfileName: string;
  activeDirectory: string;
  tags: number[];
  is4k: boolean;
  isDefault: boolean;
  externalUrl?: string;
  syncEnabled: boolean;
  preventSearch: boolean;
  tagRequests: boolean;
  overrideRule: number[];
}

export interface RadarrSettings extends DVRSettings {
  minimumAvailability: string;
  /** Root folders some quality profiles always go to, unless a request manager picks another. */
  profileFolders?: ProfileFolder[];
  /** Anime movie destination, when set (lib/radarrRouting). */
  activeAnimeProfileId?: number;
  activeAnimeProfileName?: string;
  activeAnimeDirectory?: string;
  animeTags?: number[];
}

/**
 * A Lidarr server. is4k is always false. The metadata profile picks which
 * release kinds (albums, EPs, live) Lidarr lists for an added artist.
 */
export interface LidarrSettings extends DVRSettings {
  activeMetadataProfileId: number;
  activeMetadataProfileName: string;
}

/**
 * Settings → Appearance. The default applies to the sign-in page and users
 * without their own look.
 */
export interface AppearanceSettings {
  default: ThemeDefaults;
  /**
   * Seasonal themes and dates. Unset until saved; Halloween, Holidays and New
   * Year run by default.
   */
  seasons?: SeasonsSettings;
  /**
   * Server CSS for all pages, sign-in included; may @import
   * (server/constants/customCss.ts). '' for none.
   */
  serverCss?: string;
  /** Whether users may add personal CSS. */
  personalCss?: boolean;
}

/** Music metadata sources and request limits. */
export interface MusicSettings {
  /**
   * MusicBrainz or a mirror. The public one allows 1 request/s; mirrors are
   * unlimited.
   */
  musicbrainzUrl: string;
  /**
   * Appended to the MusicBrainz user agent so MusicBrainz can contact this
   * server's admin rather than throttle every Seerr AI.
   */
  contactEmail: string;
  /** ListenBrainz new and popular releases for Discover. */
  listenBrainz: boolean;
  /**
   * Deezer, for playlist ISRCs (MusicBrainz matching) and albums MusicBrainz
   * lacks. On unless disabled.
   */
  deezer?: boolean;
  /** TheAudioDB key, for artist images Lidarr lacks. Never sent to clients. */
  theAudioDbApiKey: string;
  /** Max albums per request. */
  maxAlbumsPerRequest: number;
  /** Allow single-song requests. */
  songRequests: boolean;
  /**
   * Take a non-single song from its album: Backfill fetches the album, Lidarr
   * imports only the song.
   */
  songsFromAlbums: boolean;
  /**
   * Per-user song limit per period. 0 counts each song against the music limit
   * instead.
   */
  songQuota: { quotaLimit: number; quotaDays: number };
  /** Song intake for linked playlists (Lists). */
  playlists: PlaylistImportSettings;
  /**
   * Soulseek via slskd, for album-sourced songs missing from indexers
   * (Settings → Services).
   */
  soulseek?: SoulseekSettings;
  /** Settings → Music search options. */
  search: MusicSearchSettings;
}

/** slskd connection; unused until all three are set. */
export interface SoulseekSettings {
  /** e.g. "http://192.168.1.5:5030"; blank for none. */
  url: string;
  /** API key with the ReadWrite role. Never sent to clients. */
  apiKey: string;
  /** slskd's finished-downloads folder, as Lidarr sees it. */
  downloadsPath: string;
}

export const soulseekOf = (
  music: Pick<MusicSettings, 'soulseek'>
): SoulseekSettings | undefined =>
  music.soulseek?.url && music.soulseek.apiKey && music.soulseek.downloadsPath
    ? music.soulseek
    : undefined;

/**
 * Playlist songs over the user's limit: `wait` for the limit to free up, or
 * past `approveOver` at once, `approve` (admin approval, not counted
 * against the limit).
 */
export interface PlaylistImportSettings {
  overLimit: 'wait' | 'approve';
  approveOver: number;
}

/**
 * Music search options. The search page's Music tab and the Music page search
 * always show while music is on for the user; music off (global or theirs)
 * wins.
 */
export interface MusicSearchSettings {
  /**
   * Show artists/albums in All search. Unset follows musicInAllSearch; an
   * explicit choice wins.
   */
  inAll?: boolean;
}

/**
 * Whether All search includes music: the admin's choice, else whether a default
 * Lidarr exists.
 */
export const musicInAllSearch = (
  search: MusicSearchSettings,
  lidarrReady: boolean
): boolean => search.inAll ?? lidarrReady;

export const MUSICBRAINZ_URL = 'https://musicbrainz.org';

export interface SonarrSettings extends DVRSettings {
  seriesType: 'standard' | 'daily' | 'anime';
  /** Root folders some quality profiles always go to, unless a request manager picks another. */
  profileFolders?: ProfileFolder[];
  animeSeriesType: 'standard' | 'daily' | 'anime';
  activeAnimeProfileId?: number;
  activeAnimeProfileName?: string;
  activeAnimeDirectory?: string;
  activeAnimeLanguageProfileId?: number;
  activeLanguageProfileId?: number;
  animeTags?: number[];
  enableSeasonFolders: boolean;
  monitorNewItems: 'all' | 'none';
}

interface Quota {
  quotaLimit?: number;
  quotaDays?: number;
}

export enum MetadataProviderType {
  TMDB = 'tmdb',
  TVDB = 'tvdb',
}

export interface MetadataSettings {
  tv: MetadataProviderType;
  anime: MetadataProviderType;
}

/**
 * `anthropic` is Claude's API; `openai` is any OpenAI-compatible chat API
 * (OpenAI, or a service/local server such as Ollama or LM Studio at `baseUrl`).
 */
export type AiProvider = 'anthropic' | 'openai';

/** Whether AI features have a usable model. */
export const aiReady = (ai?: AiSettings): boolean =>
  !!ai?.enabled &&
  !!ai.model.trim() &&
  // OpenAI needs a key; a local server may not.
  (ai.provider === 'anthropic' || !ai.baseUrl.trim() ? !!ai.apiKey : true);

export interface AiSettings {
  enabled: boolean;
  provider: AiProvider;
  /** Never sent to the browser once saved. */
  apiKey: string;
  /** OpenAI-compatible only; empty means OpenAI. */
  baseUrl: string;
  /** Default for features without an override below. */
  model: string;
  /** Per-feature model overrides. */
  featureModels: Partial<Record<AiFeature, string>>;
  /** Daily AI uses per user; 0 unlimited. Admins are exempt. */
  dailyLimit: number;
}

/** Estimated AI account balance; neither provider exposes it via API. */
export interface AiCreditSettings {
  /**
   * Admin key for the provider's usage report. Never sent to the browser; only
   * used with its provider.
   */
  adminKey: string;
  /** USD balance as last entered by an admin, and when. */
  balance: number | null;
  balanceAt: string | null;
  /** USD per million tokens by model, for estimates without an admin key. */
  prices: Record<string, { input: number; output: number }>;
  /** When the provider last reported no credit. */
  outOfCreditAt: string | null;
}

export interface ProxySettings {
  enabled: boolean;
  hostname: string;
  port: number;
  useSsl: boolean;
  user: string;
  password: string;
  bypassFilter: string;
  bypassLocalAddresses: boolean;
}

export interface MainSettings {
  apiKey: string;
  applicationTitle: string;
  applicationUrl: string;
  cacheImages: boolean;
  /**
   * Image cache size limit in MB before LRU eviction (lib/imageproxy). Unset
   * uses the default.
   */
  imageCacheMaxMb?: number;
  defaultPermissions: number;
  /**
   * Default watchlist auto-request for new accounts; existing accounts keep
   * theirs.
   */
  defaultWatchlistSyncMovies: boolean;
  defaultWatchlistSyncTv: boolean;
  defaultQuotas: {
    movie: Quota;
    tv: Quota;
    /** Albums. */
    music: Quota;
  };
  /**
   * Requests over someone's quota wait for an admin (never auto-approved)
   * instead of being refused. Off unless turned on.
   */
  overQuotaRequests: boolean;
  /** Globally disabled features (constants/features). */
  disabledFeatures: string[];
  /**
   * ISO 3166-1 countries whose anime counts only if Japanese (utils/isAnime).
   * Empty on new servers; migration 0011 sets US on older ones.
   */
  animeExcludedCountries: string[];
  /** Create accounts for everyone the owner shares the Plex server with. */
  autoImportPlexUsers: boolean;
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  hideRequested: boolean;
  /**
   * Show people only what their media server libraries hold: Recently Added,
   * availability and play links (lib/libraryVisibility). Off by default.
   */
  limitToLibraries: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  newPlexLogin: boolean;
  /** Who may create personal API keys (lib/personalApiKeys). Off by default. */
  personalApiKeys: PersonalApiKeyAccess;
  /**
   * iCloud link to the admin's "Fix this show" shortcut, shown on the Siri
   * page.
   */
  siriShortcutUrl: string;
  discoverRegion: string;
  streamingRegion: string;
  originalLanguage: string;
  blocklistRegion: string;
  blocklistLanguage: string;
  blocklistedTags: string;
  blocklistedTagsLimit: number;
  mediaServerType: number;
  partialRequestsEnabled: boolean;
  enableSpecialEpisodes: boolean;
  locale: string;
  youtubeUrl: string;
  versionCheck: boolean;
  /**
   * Check for wrong matches minutes after a requested import (lib/matchWatch),
   * plus nightly.
   */
  matchCheckOnImport: boolean;
  /** Fix button on fixable wrong Plex matches. */
  matchFix?: boolean;
  /** Auto-fix them as found and nightly. */
  matchFixAuto?: boolean;
}

export interface ProxySettings {
  enabled: boolean;
  hostname: string;
  port: number;
  useSsl: boolean;
  user: string;
  password: string;
  bypassFilter: string;
  bypassLocalAddresses: boolean;
}

export interface DnsCacheSettings {
  enabled: boolean;
  forceMinTtl?: number;
  forceMaxTtl?: number;
}

export interface NetworkSettings {
  csrfProtection: boolean;
  forceIpv4First: boolean;
  trustProxy: boolean;
  /** With trustProxy, also trust Cloudflare's proxy. */
  trustCloudflare: boolean;
  /**
   * With trustProxy, also trust these addresses or ranges
   * (utils/trustedProxies).
   */
  trustedProxies: string[];
  proxy: ProxySettings;
  dnsCache: DnsCacheSettings;
  apiRequestTimeout: number;
}

interface PublicSettings {
  initialized: boolean;
}

/** A connected media server, as exposed publicly. */
export interface PublicMediaServer {
  kind: MediaServerKind;
  name: string;
  primary: boolean;
  signIn: boolean;
}

/** An OIDC provider as the sign-in page sees it. */
export interface PublicOidcProvider {
  id: string;
  name: string;
  logoUrl: string;
}

interface FullPublicSettings extends PublicSettings {
  applicationTitle: string;
  applicationUrl: string;
  disabledFeatures: string[];
  animeExcludedCountries: string[];
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  hideRequested: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  /** Who may create personal API keys (profile API Keys tab). */
  personalApiKeys: PersonalApiKeyAccess;
  /** Connected media servers, primary first. */
  mediaServers: PublicMediaServer[];
  /** Enabled OIDC providers; empty until the Application URL is set. */
  oidcProviders: PublicOidcProvider[];
  movie4kEnabled: boolean;
  series4kEnabled: boolean;
  discoverRegion: string;
  streamingRegion: string;
  originalLanguage: string;
  mediaServerType: number;
  jellyfinExternalHost?: string;
  jellyfinForgotPasswordUrl?: string;
  jellyfinServerName?: string;
  embyExternalHost?: string;
  embyForgotPasswordUrl?: string;
  partialRequestsEnabled: boolean;
  enableSpecialEpisodes: boolean;
  cacheImages: boolean;
  vapidPublic: string;
  enablePushRegistration: boolean;
  locale: string;
  emailEnabled: boolean;
  userEmailRequired: boolean;
  newPlexLogin: boolean;
  youtubeUrl: string;
  versionCheck: boolean;
  plexClientIdentifier: string;
  aiReady: boolean;
  /** Bazarr is configured, so title pages can show subtitles. */
  subtitlesReady: boolean;
  /** A Trakt Client ID is set. */
  traktReady: boolean;
  /** A default Lidarr exists and music isn't globally off. */
  musicReady: boolean;
  /** Whether All search includes music. */
  musicSearch: MusicSearchSettings;
  /** Single-song requests allowed (Settings → Music). */
  musicSongs: boolean;
  /** Default look for users who haven't chosen one. */
  themeDefault: ThemeDefaults;
  /** Active seasonal themes and their dates. */
  seasons: SeasonCalendar;
  /**
   * Server CSS version for cache-busting (null for none), and whether personal
   * CSS is allowed.
   */
  customCss: { server: string | null; personal: boolean };
}

export interface NotificationAgentConfig {
  enabled: boolean;
  embedPoster: boolean;
  types?: number;
  options: Record<string, unknown>;
}
export interface NotificationAgentDiscord extends NotificationAgentConfig {
  options: {
    botUsername?: string;
    botAvatarUrl?: string;
    webhookUrl: string;
    webhookRoleId?: string;
    webhookThreadId?: string;
    enableMentions: boolean;
    locale: AvailableLocale;
    useUserLocale: boolean;
  };
}

export interface NotificationAgentSlack extends NotificationAgentConfig {
  options: {
    webhookUrl: string;
    locale: AvailableLocale;
  };
}

export interface NotificationAgentEmail extends NotificationAgentConfig {
  options: {
    userEmailRequired: boolean;
    emailFrom: string;
    smtpHost: string;
    smtpPort: number;
    secure: boolean;
    ignoreTls: boolean;
    requireTls: boolean;
    authUser?: string;
    authPass?: string;
    allowSelfSigned: boolean;
    senderName: string;
    usePublicLogo: boolean;
    pgpPrivateKey?: string;
    pgpPassword?: string;
  };
}

export interface NotificationAgentTelegram extends NotificationAgentConfig {
  options: {
    botUsername?: string;
    botAPI: string;
    chatId: string;
    messageThreadId: string;
    sendSilently: boolean;
  };
}

export interface NotificationAgentPushbullet extends NotificationAgentConfig {
  options: {
    accessToken: string;
    channelTag?: string;
  };
}

export interface NotificationAgentPushover extends NotificationAgentConfig {
  options: {
    accessToken: string;
    userToken: string;
    sound: string;
  };
}

export interface NotificationAgentWebhook extends NotificationAgentConfig {
  options: {
    webhookUrl: string;
    jsonPayload: string;
    authHeader?: string;
    customHeaders?: { key: string; value: string }[];
    supportVariables?: boolean;
  };
}

/**
 * Default Gotify priority: 5 plays a sound in the Android app; 0 shows nothing.
 */
export const GOTIFY_DEFAULT_PRIORITY = 5;

export interface NotificationAgentGotify extends NotificationAgentConfig {
  options: {
    url: string;
    token: string;
    priority: number;
    locale: AvailableLocale;
  };
}

export interface NotificationAgentNtfy extends NotificationAgentConfig {
  options: {
    url: string;
    topic: string;
    tags?: string;
    authMethodUsernamePassword?: boolean;
    username?: string;
    password?: string;
    authMethodToken?: boolean;
    token?: string;
    priority?: number;
    locale: AvailableLocale;
  };
}

export enum NotificationAgentKey {
  DISCORD = 'discord',
  EMAIL = 'email',
  GOTIFY = 'gotify',
  NTFY = 'ntfy',
  PUSHBULLET = 'pushbullet',
  PUSHOVER = 'pushover',
  SLACK = 'slack',
  TELEGRAM = 'telegram',
  WEBHOOK = 'webhook',
  WEBPUSH = 'webpush',
}

interface NotificationAgents {
  discord: NotificationAgentDiscord;
  email: NotificationAgentEmail;
  gotify: NotificationAgentGotify;
  ntfy: NotificationAgentNtfy;
  pushbullet: NotificationAgentPushbullet;
  pushover: NotificationAgentPushover;
  slack: NotificationAgentSlack;
  telegram: NotificationAgentTelegram;
  webhook: NotificationAgentWebhook;
  webpush: NotificationAgentConfig;
}

interface NotificationSettings {
  agents: NotificationAgents;
}

interface JobSettings {
  schedule: string;
}

export type JobId =
  | 'plex-recently-added-scan'
  | 'plex-full-scan'
  | 'plex-watchlist-sync'
  | 'plex-refresh-token'
  | 'radarr-scan'
  | 'sonarr-scan'
  | 'download-sync'
  | 'download-sync-reset'
  | 'notification-reconcile'
  | 'episode-sync'
  | 'future-seasons'
  | 'plex-user-import'
  | 'jellyfin-recently-added-scan'
  | 'jellyfin-full-scan'
  | 'emby-recently-added-scan'
  | 'emby-full-scan'
  | 'image-cache-cleanup'
  | 'availability-sync'
  | 'process-blocklisted-tags'
  | 'anime-check'
  | 'backfill-scan'
  | 'backfill-monitor'
  | 'download-check'
  | 'health-watch'
  | 'plex-match-check'
  | 'music-sync'
  | 'music-full-scan'
  | 'playlist-sync'
  | 'quality-check'
  | 'database-maintenance';

export interface AllSettings {
  clientId: string;
  sessionSecret?: string;
  vapidPublic: string;
  vapidPrivate: string;
  main: MainSettings;
  plex: PlexSettings;
  jellyfin: JellyfinSettings;
  emby: JellyfinSettings;
  tautulli: TautulliSettings;
  trakt: TraktSettings;
  maintainerr: MaintainerrSettings[];
  downloadClients: DownloadClientSettings[];
  bazarr: BazarrSettings;
  backfill: BackfillSettings;
  /** Seerr AI-managed quality profiles (lib/quality). */
  quality?: QualitySettings;
  oidc: OidcSettings;
  radarr: RadarrSettings[];
  sonarr: SonarrSettings[];
  lidarr: LidarrSettings[];
  music: MusicSettings;
  appearance: AppearanceSettings;
  public: PublicSettings;
  notifications: NotificationSettings;
  jobs: Record<JobId, JobSettings>;
  network: NetworkSettings;
  metadataSettings: MetadataSettings;
  ai: AiSettings;
  aiCredit: AiCreditSettings;
  /** Next id per server list; see `newId`. */
  nextIds?: Partial<Record<ServerList, number>>;
  /**
   * Emby ids are still in the Jellyfin columns; moved once at startup
   * (lib/embySplit).
   */
  pendingEmbySplit?: boolean;
  migrations: string[];
}

/** Server/client lists whose ids are referenced elsewhere. */
export type ServerList =
  | 'radarr'
  | 'sonarr'
  | 'lidarr'
  | 'maintainerr'
  | 'downloadClients';

/** Where settings.json is: in CONFIG_DIRECTORY when set, else ./config. */
export const SETTINGS_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/settings.json`
  : path.join(__dirname, '../../../config/settings.json');

class Settings {
  private data: AllSettings;
  private saveLock: Promise<void> = Promise.resolve();

  constructor(initialSettings?: AllSettings) {
    this.data = {
      clientId: randomUUID(),
      sessionSecret: '',
      vapidPrivate: '',
      vapidPublic: '',
      main: {
        apiKey: '',
        applicationTitle: 'Seerr AI',
        applicationUrl: '',
        cacheImages: false,
        imageCacheMaxMb: DEFAULT_IMAGE_CACHE_MAX_MB,
        defaultPermissions: Permission.REQUEST,
        defaultWatchlistSyncMovies: false,
        defaultWatchlistSyncTv: false,
        defaultQuotas: {
          movie: {},
          tv: {},
          music: {},
        },
        overQuotaRequests: false,
        disabledFeatures: [],
        animeExcludedCountries: [],
        autoImportPlexUsers: false,
        hideAvailable: false,
        hideBlocklisted: false,
        hideRequested: false,
        limitToLibraries: false,
        localLogin: true,
        mediaServerLogin: true,
        newPlexLogin: true,
        personalApiKeys: 'off',
        siriShortcutUrl: '',
        discoverRegion: '',
        streamingRegion: '',
        originalLanguage: '',
        blocklistRegion: '',
        blocklistLanguage: '',
        blocklistedTags: '',
        blocklistedTagsLimit: 50,
        mediaServerType: MediaServerType.NOT_CONFIGURED,
        partialRequestsEnabled: true,
        enableSpecialEpisodes: false,
        locale: 'en',
        youtubeUrl: '',
        versionCheck: true,
        matchCheckOnImport: true,
        matchFix: true,
        matchFixAuto: false,
      },
      plex: {
        name: '',
        ip: '',
        port: 32400,
        useSsl: false,
        libraries: [],
        musicLibraries: [],
        connected: false,
        signIn: true,
      },
      jellyfin: jellyfinDefaults(),
      emby: jellyfinDefaults(),
      tautulli: {},
      trakt: {},
      maintainerr: [],
      downloadClients: [],
      oidc: { providers: [] },
      bazarr: {
        hostname: '',
        port: 6767,
        useSsl: false,
        urlBase: '',
        apiKey: '',
      },
      backfill: BACKFILL_DEFAULTS,
      metadataSettings: {
        tv: MetadataProviderType.TMDB,
        anime: MetadataProviderType.TMDB,
      },
      ai: {
        enabled: false,
        provider: 'anthropic',
        apiKey: '',
        baseUrl: '',
        model: '',
        featureModels: {},
        dailyLimit: 20,
      },
      aiCredit: {
        adminKey: '',
        balance: null,
        balanceAt: null,
        prices: {},
        outOfCreditAt: null,
      },
      radarr: [],
      sonarr: [],
      lidarr: [],
      music: musicDefaults(),
      appearance: { default: { ...SERVER_THEME_DEFAULTS } },
      public: {
        initialized: false,
      },
      notifications: {
        agents: {
          email: {
            enabled: false,
            embedPoster: true,
            options: {
              userEmailRequired: false,
              emailFrom: '',
              smtpHost: '',
              smtpPort: 587,
              secure: false,
              ignoreTls: false,
              requireTls: false,
              allowSelfSigned: false,
              senderName: 'Seerr AI',
              usePublicLogo: false,
            },
          },
          discord: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              webhookUrl: '',
              webhookRoleId: '',
              enableMentions: true,
              locale: 'en',
              useUserLocale: true,
            },
          },
          slack: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              webhookUrl: '',
              locale: 'en',
            },
          },
          telegram: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              botAPI: '',
              chatId: '',
              messageThreadId: '',
              sendSilently: false,
            },
          },
          pushbullet: {
            enabled: false,
            embedPoster: false,
            types: 0,
            options: {
              accessToken: '',
            },
          },
          pushover: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              accessToken: '',
              userToken: '',
              sound: '',
            },
          },
          webhook: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              webhookUrl: '',
              jsonPayload:
                'IntcbiAgXCJub3RpZmljYXRpb25fdHlwZVwiOiBcInt7bm90aWZpY2F0aW9uX3R5cGV9fVwiLFxuICBcImV2ZW50XCI6IFwie3tldmVudH19XCIsXG4gIFwic3ViamVjdFwiOiBcInt7c3ViamVjdH19XCIsXG4gIFwibWVzc2FnZVwiOiBcInt7bWVzc2FnZX19XCIsXG4gIFwiaW1hZ2VcIjogXCJ7e2ltYWdlfX1cIixcbiAgXCJ7e21lZGlhfX1cIjoge1xuICAgIFwibWVkaWFfdHlwZVwiOiBcInt7bWVkaWFfdHlwZX19XCIsXG4gICAgXCJ0bWRiSWRcIjogXCJ7e21lZGlhX3RtZGJpZH19XCIsXG4gICAgXCJ0dmRiSWRcIjogXCJ7e21lZGlhX3R2ZGJpZH19XCIsXG4gICAgXCJzdGF0dXNcIjogXCJ7e21lZGlhX3N0YXR1c319XCIsXG4gICAgXCJzdGF0dXM0a1wiOiBcInt7bWVkaWFfc3RhdHVzNGt9fVwiXG4gIH0sXG4gIFwie3tyZXF1ZXN0fX1cIjoge1xuICAgIFwicmVxdWVzdF9pZFwiOiBcInt7cmVxdWVzdF9pZH19XCIsXG4gICAgXCJyZXF1ZXN0ZWRCeV9lbWFpbFwiOiBcInt7cmVxdWVzdGVkQnlfZW1haWx9fVwiLFxuICAgIFwicmVxdWVzdGVkQnlfdXNlcm5hbWVcIjogXCJ7e3JlcXVlc3RlZEJ5X3VzZXJuYW1lfX1cIixcbiAgICBcInJlcXVlc3RlZEJ5X2F2YXRhclwiOiBcInt7cmVxdWVzdGVkQnlfYXZhdGFyfX1cIixcbiAgICBcInJlcXVlc3RlZEJ5X3NldHRpbmdzX2Rpc2NvcmRJZFwiOiBcInt7cmVxdWVzdGVkQnlfc2V0dGluZ3NfZGlzY29yZElkfX1cIixcbiAgICBcInJlcXVlc3RlZEJ5X3NldHRpbmdzX3RlbGVncmFtQ2hhdElkXCI6IFwie3tyZXF1ZXN0ZWRCeV9zZXR0aW5nc190ZWxlZ3JhbUNoYXRJZH19XCJcbiAgfSxcbiAgXCJ7e2lzc3VlfX1cIjoge1xuICAgIFwiaXNzdWVfaWRcIjogXCJ7e2lzc3VlX2lkfX1cIixcbiAgICBcImlzc3VlX3R5cGVcIjogXCJ7e2lzc3VlX3R5cGV9fVwiLFxuICAgIFwiaXNzdWVfc3RhdHVzXCI6IFwie3tpc3N1ZV9zdGF0dXN9fVwiLFxuICAgIFwicmVwb3J0ZWRCeV9lbWFpbFwiOiBcInt7cmVwb3J0ZWRCeV9lbWFpbH19XCIsXG4gICAgXCJyZXBvcnRlZEJ5X3VzZXJuYW1lXCI6IFwie3tyZXBvcnRlZEJ5X3VzZXJuYW1lfX1cIixcbiAgICBcInJlcG9ydGVkQnlfYXZhdGFyXCI6IFwie3tyZXBvcnRlZEJ5X2F2YXRhcn19XCIsXG4gICAgXCJyZXBvcnRlZEJ5X3NldHRpbmdzX2Rpc2NvcmRJZFwiOiBcInt7cmVwb3J0ZWRCeV9zZXR0aW5nc19kaXNjb3JkSWR9fVwiLFxuICAgIFwicmVwb3J0ZWRCeV9zZXR0aW5nc190ZWxlZ3JhbUNoYXRJZFwiOiBcInt7cmVwb3J0ZWRCeV9zZXR0aW5nc190ZWxlZ3JhbUNoYXRJZH19XCJcbiAgfSxcbiAgXCJ7e2NvbW1lbnR9fVwiOiB7XG4gICAgXCJjb21tZW50X21lc3NhZ2VcIjogXCJ7e2NvbW1lbnRfbWVzc2FnZX19XCIsXG4gICAgXCJjb21tZW50ZWRCeV9lbWFpbFwiOiBcInt7Y29tbWVudGVkQnlfZW1haWx9fVwiLFxuICAgIFwiY29tbWVudGVkQnlfdXNlcm5hbWVcIjogXCJ7e2NvbW1lbnRlZEJ5X3VzZXJuYW1lfX1cIixcbiAgICBcImNvbW1lbnRlZEJ5X2F2YXRhclwiOiBcInt7Y29tbWVudGVkQnlfYXZhdGFyfX1cIixcbiAgICBcImNvbW1lbnRlZEJ5X3NldHRpbmdzX2Rpc2NvcmRJZFwiOiBcInt7Y29tbWVudGVkQnlfc2V0dGluZ3NfZGlzY29yZElkfX1cIixcbiAgICBcImNvbW1lbnRlZEJ5X3NldHRpbmdzX3RlbGVncmFtQ2hhdElkXCI6IFwie3tjb21tZW50ZWRCeV9zZXR0aW5nc190ZWxlZ3JhbUNoYXRJZH19XCJcbiAgfSxcbiAgXCJ7e2V4dHJhfX1cIjogW11cbn0i',
            },
          },
          webpush: {
            enabled: false,
            embedPoster: true,
            options: {},
          },
          gotify: {
            enabled: false,
            embedPoster: false,
            types: 0,
            options: {
              url: '',
              token: '',
              priority: GOTIFY_DEFAULT_PRIORITY,
              locale: 'en',
            },
          },
          ntfy: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              url: '',
              topic: '',
              tags: '',
              priority: 3,
              locale: 'en',
            },
          },
        },
      },
      jobs: {
        'plex-recently-added-scan': {
          schedule: '0 */5 * * * *',
        },
        'plex-full-scan': {
          schedule: '0 0 3 * * *',
        },
        'plex-watchlist-sync': {
          schedule: '0 */3 * * * *',
        },
        'plex-refresh-token': {
          schedule: '0 0 5 * * *',
        },
        'radarr-scan': {
          schedule: '0 0 4 * * *',
        },
        'sonarr-scan': {
          schedule: '0 30 4 * * *',
        },
        'availability-sync': {
          schedule: '0 0 5 * * *',
        },
        'download-sync': {
          schedule: '0 * * * * *',
        },
        'download-sync-reset': {
          schedule: '0 0 1 * * *',
        },
        'notification-reconcile': {
          // Offset off the minute to avoid the hourly and half-hourly scans.
          schedule: '20 */2 * * * *',
        },
        'episode-sync': {
          schedule: '40 */5 * * * *',
        },
        // Premieres are by date: a few checks a day, off the hour.
        'future-seasons': {
          schedule: '0 50 */6 * * *',
        },
        // No-op unless Auto-Import Plex Users is on.
        'plex-user-import': {
          schedule: '0 25 */1 * * *',
        },
        'jellyfin-recently-added-scan': {
          schedule: '0 */5 * * * *',
        },
        'jellyfin-full-scan': {
          schedule: '0 0 3 * * *',
        },
        // Offset from Jellyfin's so the scans don't start together.
        'emby-recently-added-scan': {
          schedule: '0 2-59/5 * * * *',
        },
        'emby-full-scan': {
          schedule: '0 10 3 * * *',
        },
        'image-cache-cleanup': {
          schedule: '0 0 5 * * *',
        },
        'process-blocklisted-tags': {
          schedule: '0 30 1 */7 * *',
        },
        // Report only: titles whose anime status disagrees with Seerr.
        'anime-check': {
          schedule: '0 15 4 * * *',
        },
        // Searches a few stuck titles per run.
        'backfill-scan': {
          schedule: '0 40 */6 * * *',
        },
        // Advances approved Backfill downloads: pick files, import, clean up.
        'backfill-monitor': {
          schedule: '30 * * * * *',
        },
        // Avoids the minute mark, where Download Sync reads the same queues.
        'download-check': {
          schedule: '15,45 * * * * *',
        },
        // Alerts admins to new service problems (Settings → Health).
        'health-watch': {
          schedule: '15 */10 * * * *',
        },
        // Report only: Plex matches that disagree with Sonarr/Radarr. After the
        // nightly full scan.
        'plex-match-check': {
          schedule: '0 20 4 * * *',
        },
        // Lidarr request progress and newly added music; off the video scans'
        // 5-minute marks.
        'music-sync': {
          schedule: '0 3-59/5 * * * *',
        },
        // All music libraries and Lidarr, including removals.
        'music-full-scan': {
          schedule: '0 40 3 * * *',
        },
        // Re-reads linked playlists daily; requests waiting songs hourly as
        // limits free.
        'playlist-sync': {
          schedule: '0 25 * * * *',
        },
        // Settings → Quality: daily TRaSH Guides, profile drift, step-down.
        'quality-check': {
          schedule: '0 20 * * * *',
        },
        // Deletes unused rows, then vacuums.
        'database-maintenance': {
          schedule: '0 45 3 * * *',
        },
      },
      network: {
        csrfProtection: true,
        forceIpv4First: false,
        trustProxy: false,
        trustCloudflare: false,
        trustedProxies: [],
        proxy: {
          enabled: false,
          hostname: '',
          port: 8080,
          useSsl: false,
          user: '',
          password: '',
          bypassFilter: '',
          bypassLocalAddresses: true,
        },
        dnsCache: {
          enabled: false,
          forceMinTtl: 0,
          forceMaxTtl: -1,
        },
        apiRequestTimeout: 10000,
      },
      // New installs already match 0010's result (running it later would
      // disconnect servers connected at setup) and know Wrong Match (0014).
      migrations: ['0010_media_servers', '0014_wrong_match_notifications'],
    };
    if (initialSettings) {
      this.data = mergeSettings(this.data, initialSettings);
    }
  }

  get main(): MainSettings {
    return this.data.main;
  }

  set main(data: MainSettings) {
    this.data.main = mergeSettings(this.data.main, data);
  }

  get plex(): PlexSettings {
    return this.data.plex;
  }

  set plex(data: PlexSettings) {
    this.data.plex = mergeSettings(this.data.plex, data);
  }

  get jellyfin(): JellyfinSettings {
    return this.data.jellyfin;
  }

  set jellyfin(data: JellyfinSettings) {
    this.data.jellyfin = mergeSettings(this.data.jellyfin, data);
  }

  get emby(): JellyfinSettings {
    return this.data.emby;
  }

  set emby(data: JellyfinSettings) {
    this.data.emby = mergeSettings(this.data.emby, data);
  }

  get pendingEmbySplit(): boolean {
    return !!this.data.pendingEmbySplit;
  }

  set pendingEmbySplit(pending: boolean) {
    if (pending) {
      this.data.pendingEmbySplit = true;
    } else {
      delete this.data.pendingEmbySplit;
    }
  }

  get maintainerr(): MaintainerrSettings[] {
    return this.data.maintainerr;
  }

  set maintainerr(data: MaintainerrSettings[]) {
    this.data.maintainerr = data;
  }

  get downloadClients(): DownloadClientSettings[] {
    return this.data.downloadClients ?? [];
  }

  set downloadClients(data: DownloadClientSettings[]) {
    this.data.downloadClients = data;
  }

  get oidc(): OidcSettings {
    // Accept upstream's single-string claim format too.
    return {
      providers: (this.data.oidc?.providers ?? []).map((provider) => ({
        ...provider,
        requiredClaims: requiredClaimsFrom(provider.requiredClaims),
      })),
    };
  }

  set oidc(data: OidcSettings) {
    this.data.oidc = data;
  }

  get bazarr(): BazarrSettings {
    return (
      this.data.bazarr ?? {
        hostname: '',
        port: 6767,
        useSsl: false,
        urlBase: '',
        apiKey: '',
      }
    );
  }

  set bazarr(data: BazarrSettings) {
    this.data.bazarr = data;
  }

  get backfill(): BackfillSettings {
    return mergeSettings(
      structuredClone(BACKFILL_DEFAULTS),
      this.data.backfill ?? {}
    );
  }

  set backfill(data: BackfillSettings) {
    this.data.backfill = data;
  }

  get quality(): QualitySettings {
    const quality = mergeSettings(
      structuredClone(QUALITY_DEFAULTS),
      this.data.quality ?? {}
    );
    // Fill in adjustments newer than the saved server.
    quality.servers = quality.servers.map((server) => ({
      ...server,
      adjustments: { ...ADJUSTMENT_DEFAULTS, ...server.adjustments },
    }));
    return quality;
  }

  set quality(data: QualitySettings) {
    this.data.quality = data;
  }

  get tautulli(): TautulliSettings {
    return this.data.tautulli;
  }

  set tautulli(data: TautulliSettings) {
    this.data.tautulli = mergeSettings(this.data.tautulli, data);
  }

  get trakt(): TraktSettings {
    return this.data.trakt;
  }

  set trakt(data: TraktSettings) {
    this.data.trakt = data;
  }

  get ai(): AiSettings {
    return this.data.ai;
  }

  set ai(data: AiSettings) {
    this.data.ai = data;
  }

  get aiCredit(): AiCreditSettings {
    return this.data.aiCredit;
  }

  set aiCredit(data: AiCreditSettings) {
    this.data.aiCredit = data;
  }

  get metadataSettings(): MetadataSettings {
    return this.data.metadataSettings;
  }

  set metadataSettings(data: MetadataSettings) {
    this.data.metadataSettings = mergeSettings(
      this.data.metadataSettings,
      data
    );
  }

  // Older settings may lack lidarr/music until reloaded; create them here so
  // changes persist.
  get lidarr(): LidarrSettings[] {
    if (!this.data.lidarr) {
      this.data.lidarr = [];
    }
    return this.data.lidarr;
  }

  set lidarr(data: LidarrSettings[]) {
    this.data.lidarr = data;
  }

  get music(): MusicSettings {
    if (!this.data.music) {
      this.data.music = musicDefaults();
    }
    if (!this.data.music.search) {
      this.data.music.search = musicDefaults().search;
    }
    if (!this.data.music.songQuota) {
      this.data.music.songQuota = musicDefaults().songQuota;
    }
    if (!this.data.music.playlists) {
      this.data.music.playlists = musicDefaults().playlists;
    }
    // Older settings lack these; use defaults.
    if (this.data.music.songRequests === undefined) {
      this.data.music.songRequests = musicDefaults().songRequests;
    }
    if (this.data.music.songsFromAlbums === undefined) {
      this.data.music.songsFromAlbums = musicDefaults().songsFromAlbums;
    }
    return this.data.music;
  }

  set music(data: MusicSettings) {
    this.data.music = data;
  }

  get appearance(): AppearanceSettings {
    if (!this.data.appearance) {
      this.data.appearance = { default: { ...SERVER_THEME_DEFAULTS } };
    }
    return this.data.appearance;
  }

  set appearance(data: AppearanceSettings) {
    this.data.appearance = data;
  }

  get radarr(): RadarrSettings[] {
    return this.data.radarr;
  }

  set radarr(data: RadarrSettings[]) {
    this.data.radarr = data;
  }

  get sonarr(): SonarrSettings[] {
    return this.data.sonarr;
  }

  set sonarr(data: SonarrSettings[]) {
    this.data.sonarr = data;
  }

  get public(): PublicSettings {
    return this.data.public;
  }

  set public(data: PublicSettings) {
    this.data.public = mergeSettings(this.data.public, data);
  }

  get fullPublicSettings(): FullPublicSettings {
    return {
      ...this.data.public,
      applicationTitle: this.data.main.applicationTitle,
      applicationUrl: this.data.main.applicationUrl,
      disabledFeatures: this.data.main.disabledFeatures ?? [],
      animeExcludedCountries: this.data.main.animeExcludedCountries ?? [],
      hideAvailable: this.data.main.hideAvailable,
      hideBlocklisted: this.data.main.hideBlocklisted,
      hideRequested: this.data.main.hideRequested,
      localLogin: this.data.main.localLogin,
      mediaServerLogin: this.data.main.mediaServerLogin,
      personalApiKeys: this.data.main.personalApiKeys ?? 'off',
      mediaServers: connectedKindsOf(this.data).map((kind, index) => ({
        kind,
        name: this.data[kind]?.name ?? '',
        primary: index === 0 && kind === kindOfType(this.main.mediaServerType),
        signIn: this.data[kind]?.signIn !== false,
      })),
      oidcProviders: oidcApplicationUrl(this.data.main.applicationUrl)
        ? this.oidc.providers
            .filter((provider) => provider.enabled)
            .map(({ id, name, logoUrl }) => ({ id, name, logoUrl }))
        : [],
      // Single-server pages: Emby's when only Emby is connected.
      jellyfinExternalHost: this.jellyfinFamilyPublic().externalHostname,
      jellyfinForgotPasswordUrl:
        this.jellyfinFamilyPublic().jellyfinForgotPasswordUrl,
      embyExternalHost: this.data.emby?.externalHostname,
      embyForgotPasswordUrl: this.data.emby?.jellyfinForgotPasswordUrl,
      movie4kEnabled: this.data.radarr.some(
        (radarr) => radarr.is4k && radarr.isDefault
      ),
      series4kEnabled: this.data.sonarr.some(
        (sonarr) => sonarr.is4k && sonarr.isDefault
      ),
      discoverRegion: this.data.main.discoverRegion,
      streamingRegion: this.data.main.streamingRegion,
      originalLanguage: this.data.main.originalLanguage,
      mediaServerType: this.main.mediaServerType,
      partialRequestsEnabled: this.data.main.partialRequestsEnabled,
      enableSpecialEpisodes: this.data.main.enableSpecialEpisodes,
      cacheImages: this.data.main.cacheImages,
      vapidPublic: this.vapidPublic,
      enablePushRegistration: this.data.notifications.agents.webpush.enabled,
      locale: this.data.main.locale,
      emailEnabled: this.data.notifications.agents.email.enabled,
      userEmailRequired:
        this.data.notifications.agents.email.options.userEmailRequired,
      newPlexLogin: this.data.main.newPlexLogin,
      youtubeUrl: this.data.main.youtubeUrl,
      versionCheck: this.data.main.versionCheck,
      plexClientIdentifier: this.data.clientId,
      aiReady: aiReady(this.data.ai),
      subtitlesReady: !!(
        this.data.bazarr?.hostname && this.data.bazarr?.apiKey
      ),
      traktReady: !!this.data.trakt?.clientId,
      musicReady:
        (this.data.lidarr ?? []).some((lidarr) => lidarr.isDefault) &&
        !(this.data.main.disabledFeatures ?? []).includes('music'),
      musicSearch: {
        inAll: musicInAllSearch(
          this.music.search,
          (this.data.lidarr ?? []).some((lidarr) => lidarr.isDefault)
        ),
      },
      musicSongs: !!this.music.songRequests,
      // Re-validated: settings.json can be hand-edited.
      themeDefault:
        cleanThemeDefaults(this.appearance.default) ?? SERVER_THEME_DEFAULTS,
      seasons: seasonCalendar(seasonSettings(this.appearance.seasons)),
      customCss: {
        server: cssVersion(this.appearance.serverCss),
        personal: this.appearance.personalCss === true,
      },
    };
  }

  /**
   * The Jellyfin-family server for single-server pages: Jellyfin, unless only
   * Emby is connected.
   */
  private jellyfinFamilyPublic(): JellyfinSettings {
    const kinds = connectedKindsOf(this.data);
    const kind = kinds.find((k) => k === 'jellyfin' || k === 'emby');
    return kind === 'emby' && this.data.emby
      ? this.data.emby
      : this.data.jellyfin;
  }

  get notifications(): NotificationSettings {
    return this.data.notifications;
  }

  set notifications(data: NotificationSettings) {
    this.data.notifications = mergeSettings(this.data.notifications, data);
  }

  get jobs(): Record<JobId, JobSettings> {
    return this.data.jobs;
  }

  set jobs(data: Record<JobId, JobSettings>) {
    this.data.jobs = mergeSettings(this.data.jobs, data);
  }

  get network(): NetworkSettings {
    return this.data.network;
  }

  set network(data: NetworkSettings) {
    this.data.network = mergeSettings(this.data.network, data);
  }

  /**
   * A new id for a server list, above any it has ever used, so a removed
   * server's id is never reused: titles and Backfill downloads keep their
   * server id. The caller saves the settings.
   */
  public newId(list: ServerList): number {
    const saved: { id: number }[] = this.data[list] ?? [];
    const highest = Math.max(-1, ...saved.map((s) => s.id));
    const id = Math.max(highest + 1, this.data.nextIds?.[list] ?? 0);
    this.data.nextIds = { ...this.data.nextIds, [list]: id + 1 };
    return id;
  }

  get migrations(): string[] {
    return this.data.migrations;
  }

  set migrations(data: string[]) {
    this.data.migrations = data;
  }

  get clientId(): string {
    return this.data.clientId;
  }

  get sessionSecret(): string {
    return this.data.sessionSecret!;
  }

  get vapidPublic(): string {
    return this.data.vapidPublic;
  }

  get vapidPrivate(): string {
    return this.data.vapidPrivate;
  }

  public async regenerateApiKey(): Promise<MainSettings> {
    this.main.apiKey = this.generateApiKey();
    await this.save();
    return this.main;
  }

  private generateApiKey(): string {
    if (process.env.API_KEY) {
      return process.env.API_KEY;
    } else {
      return Buffer.from(`${Date.now()}${randomUUID()}`).toString('base64');
    }
  }

  /**
   * Loads settings from file.
   * @param overrideSettings Replaces all settings instead of reading the file.
   * @param raw Skip migrations and merging in defaults.
   */
  public async load(
    overrideSettings?: AllSettings,
    raw = false
  ): Promise<Settings> {
    if (overrideSettings) {
      this.data = overrideSettings;
      return this;
    }

    let data;
    try {
      data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    } catch {
      await this.save();
    }

    let change = false;
    if (data && !raw) {
      const parsedJson = JSON.parse(data);
      const migratedData = await runMigrations(parsedJson, SETTINGS_PATH);
      const merged = mergeSettings(this.data, migratedData);

      if (JSON.stringify(merged) !== JSON.stringify(migratedData)) {
        change = true;
      }

      this.data = merged;
    } else if (data) {
      this.data = JSON.parse(data);
    }

    if (!this.data.main.apiKey) {
      this.data.main.apiKey = this.generateApiKey();
      change = true;
    } else if (process.env.API_KEY) {
      if (this.main.apiKey != process.env.API_KEY) {
        this.main.apiKey = process.env.API_KEY;
      }
    }
    if (!this.data.clientId) {
      this.data.clientId = randomUUID();
      change = true;
    }
    if (!this.data.sessionSecret) {
      this.data.sessionSecret = randomBytes(32).toString('hex');
      change = true;
    }
    if (!this.data.vapidPublic || !this.data.vapidPrivate) {
      const vapidKeys = webpush.generateVAPIDKeys();
      this.data.vapidPrivate = vapidKeys.privateKey;
      this.data.vapidPublic = vapidKeys.publicKey;
      change = true;
    }
    if (change) {
      await this.save();
    }

    return this;
  }

  public async save(): Promise<void> {
    const savePromise = this.saveLock.then(async () => {
      const tmp = SETTINGS_PATH + '.tmp';
      await writeSettingsFile(tmp, JSON.stringify(this.data, undefined, ' '));
      await fs.rename(tmp, SETTINGS_PATH);
    });

    this.saveLock = savePromise.catch(() => {
      // Keep the chain alive so a failed save doesn't block later ones.
    });

    return savePromise;
  }
}

let settings: Settings | undefined;

export const getSettings = (initialSettings?: AllSettings): Settings => {
  if (!settings) {
    settings = new Settings(initialSettings);
  }

  return settings;
};

export default Settings;
