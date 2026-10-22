import type { PersonalApiKeyAccess } from '@server/constants/apiKeys';
import type { AiFeature } from '@server/constants/features';
import { DEFAULT_IMAGE_CACHE_MAX_MB } from '@server/constants/images';
import type { OidcClaimRule } from '@server/constants/oidc';
import { oidcApplicationUrl, requiredClaimsFrom } from '@server/constants/oidc';
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
import type { SeasonCalendar, SeasonsSettings } from '@server/lib/seasons';
import { seasonCalendar, seasonSettings } from '@server/lib/seasons';
import { runMigrations } from '@server/lib/settings/migrator';
import type { AvailableLocale } from '@server/types/languages';
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs/promises';
import { mergeWith } from 'lodash';
import path from 'path';
import webpush from 'web-push';

// Prevents stale array entries when incoming data has fewer elements
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
 * A music library: 'artist' is Plex's word for one, 'music' Jellyfin's and
 * Emby's. A type of its own, so code for film and series libraries cannot
 * be handed one.
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
  /**
   * Music libraries, kept apart from `libraries` so the scans, checks and
   * watch history for films and series never walk them.
   */
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
  /** Music libraries, kept apart as Plex's are. */
  musicLibraries: MusicLibrary[];
  serverId: string;
  apiKey: string;
  /** Seerr is connected to this server (see lib/mediaServers). */
  connected?: boolean;
  /** People may sign in with their account on this server. */
  signIn?: boolean;
  /**
   * The server's account Seerr reads libraries as; the owner's (user 1's)
   * linked account when not set.
   */
  adminUserId?: string;
}

/** Music before an admin changes anything. */
export const musicDefaults = (): MusicSettings => ({
  musicbrainzUrl: MUSICBRAINZ_URL,
  contactEmail: '',
  listenBrainz: true,
  theAudioDbApiKey: '',
  maxAlbumsPerRequest: 100,
  search: { inAll: false },
});

/** A Jellyfin or Emby server that has not been set up. */
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
 * The media servers Seerr is connected to, the primary one (the one chosen
 * at setup, main.mediaServerType) first. The primary one always counts as
 * connected. lib/mediaServers has the helpers built on this.
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

/**
 * One Maintainerr server. Seerr reads what it will delete, to warn people,
 * and lets them keep a title by postponing it. Each server carries its own
 * feature switches, so they can differ between servers.
 */
/**
 * A download client Seerr reads directly, for progress by the second rather
 * than at Radarr's and Sonarr's once-a-minute pace. Radarr and Sonarr still
 * send the downloads; Seerr only reads them, matched by the download id
 * Radarr and Sonarr record.
 */
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
   * The client's sign-in, empty when it lets this address in: qBittorrent's
   * Web UI, Transmission's RPC, NZBGet's and rTorrent's basic auth. Deluge
   * signs in with its Web UI password alone.
   */
  username: string;
  password: string;
}

/**
 * Backfill: finds packs for series Sonarr, and movies Radarr, have searched
 * for and not found, by searching Prowlarr directly and judging each pack by
 * the files inside, and imports them through Sonarr or Radarr once an admin
 * approves. Downloads go to the download clients set up above, under their
 * own category.
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
  /** Movies Radarr cannot find are followed too, not only series. */
  includeMovies: boolean;
  /** Hours since Sonarr's or Radarr's last search before a title is stuck. */
  stuckAfterHours: number;
  /** Treat episodes below the profile's cutoff as gaps too. */
  includeCutoffUnmet: boolean;
  includeSpecials: boolean;
  /** Titles searched per scan, so indexers aren't hit all at once. */
  searchesPerScan: number;
  /** Days before a title with nothing found is searched again. */
  researchAfterDays: number;
  autoApprove: {
    enabled: boolean;
    minScore: number;
    maxSizeGb: number;
  };
  maxActiveJobs: number;
  /** New downloads wait while the title's disk has less free than this. */
  minFreeSpaceGb: number;
  /**
   * A torrent that gains nothing for this long is given up on and the next
   * pack offered. 0 waits forever.
   */
  stallHours: number;
  /**
   * A download that fails or stalls is replaced on its own by the next
   * good pack for the same episodes (auto-approve's score and size), until
   * none is left.
   */
  replaceFailed: boolean;
  /**
   * Days finished downloads, and the packs they and searches left, are
   * kept before the nightly database maintenance removes them. 0 keeps
   * them for good.
   */
  historyDays: number;
  /**
   * Release groups an admin blocked: Backfill and the agent pass over them,
   * and Radarr and Sonarr are given a custom format that rejects them (see
   * lib/blockedGroups.ts). Changed only through their own route, never by
   * saving the rest of these settings.
   */
  blockedGroups: string[];
  /**
   * Download Check (lib/downloadCheck): looks at what Radarr and Sonarr
   * grab, before it downloads and when its import gets stuck. Works without
   * the rest of Backfill. Changed only through its own route.
   */
  downloadCheck: {
    /** off; report: say what it would do; on: do it. */
    mode: DownloadCheckMode;
  };
  /**
   * The admin agent: an AI that looks further when Backfill finds nothing
   * for a requested title, and that admins can ask to find something.
   */
  agent: {
    /** Started on its own for requested titles Backfill found nothing for. */
    autoRun: boolean;
    /** Runs it starts on its own in a day. */
    maxAutoRunsPerDay: number;
    /** Downloads it may start in a day, asked or not. */
    maxGrabsPerDay: number;
    /** Tool calls in one run before it has to stop. */
    maxSteps: number;
    /**
     * Times it carries on by itself after a go's steps run out, while it
     * is still getting somewhere; then it stops and waits for a reply.
     */
    autoContinue: number;
    /** The largest download it may start, in GB. */
    maxSizeGb: number;
    /** What an admin wants it always to do, in their words. */
    instructions: string;
    /** Days a finished conversation is kept; 0 keeps them for good. */
    keepDays: number;
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
  stuckAfterHours: 24,
  includeCutoffUnmet: false,
  includeSpecials: false,
  searchesPerScan: 5,
  researchAfterDays: 7,
  autoApprove: { enabled: false, minScore: 700, maxSizeGb: 25 },
  maxActiveJobs: 2,
  minFreeSpaceGb: 200,
  stallHours: 12,
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
};

/**
 * Bazarr, which Seerr reads for the subtitles on disk and asks to search,
 * download, delete or transcribe them. One instance: Bazarr itself follows
 * one Radarr and one Sonarr.
 */
export interface BazarrSettings {
  /** Blank until Bazarr is set up. */
  hostname: string;
  port: number;
  useSsl: boolean;
  urlBase: string;
  apiKey: string;
}

/**
 * A provider people can sign in with (single sign-on through OpenID
 * Connect): Authentik, Authelia, Keycloak, Pocket ID, Google and the like.
 */
export interface OidcProviderSettings {
  /** Made from the name when added, and never changed: links refer to it. */
  id: string;
  /** Shown on the button: "Sign in with {name}". */
  name: string;
  issuerUrl: string;
  clientId: string;
  /** Never sent back to a browser. */
  clientSecret: string;
  /** A picture for the button; blank for none. */
  logoUrl: string;
  scopes: string;
  enabled: boolean;
  /** Someone new to Seerr gets an account on signing in. Off by default. */
  newUserSignUp: boolean;
  /**
   * Who may sign in: every rule must hold for the claims the provider
   * sends. Empty lets in anyone with an account there.
   */
  requiredClaims: OidcClaimRule[];
}

export interface OidcSettings {
  providers: OidcProviderSettings[];
}

export interface MaintainerrSettings {
  id: number;
  name: string;
  hostname: string;
  port: number;
  useSsl: boolean;
  urlBase: string;
  /** Maintainerr itself does not ask for one; for a proxy in front that does. */
  apiKey: string;
  /** A "Deleting soon" badge on posters and title pages. */
  showBadges: boolean;
  /** Include its titles in the home page's "Deleting Soon" row. */
  showDeletingSoon: boolean;
  /** A Keep button, for anyone signed in, that postpones the deletion. */
  allowKeep: boolean;
  /** Days a Keep adds. 0 restarts the rule's whole grace period. */
  keepDays: number;
  /** How close a deletion has to be to count as "soon". */
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
 * Trakt, for public lists and watchlists. Only the Client ID of the admin's
 * own Trakt app: Seerr AI reads public data and nobody signs in to Trakt.
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
  /** Where anime movies go, when set: see lib/radarrRouting. */
  activeAnimeProfileId?: number;
  activeAnimeProfileName?: string;
  activeAnimeDirectory?: string;
  animeTags?: number[];
}

/**
 * A Lidarr server, for music. There is no 4K Lidarr: is4k is always false.
 * The metadata profile decides which kinds of release (albums, EPs, live
 * albums) Lidarr lists for an artist it adds.
 */
export interface LidarrSettings extends DVRSettings {
  activeMetadataProfileId: number;
  activeMetadataProfileName: string;
}

/**
 * How Seerr AI looks (Settings → Appearance). The default is what everyone
 * sees who has not chosen their own look, and the sign-in page.
 */
export interface AppearanceSettings {
  default: ThemeDefaults;
  /**
   * The seasonal themes this server runs, and when. Left out until an
   * admin saves them: Halloween, Holidays and New Year run by default.
   */
  seasons?: SeasonsSettings;
  /**
   * Styles for everyone, the sign-in page included; may @import a
   * stylesheet from elsewhere (server/constants/customCss.ts). '' for none.
   */
  serverCss?: string;
  /** Whether people may add their own CSS, for their own screens. */
  personalCss?: boolean;
}

/** Where music's details come from, and limits on requesting it. */
export interface MusicSettings {
  /**
   * MusicBrainz, or a mirror of it. The public one allows a request a
   * second; a mirror has no limit.
   */
  musicbrainzUrl: string;
  /**
   * Added to how Seerr names itself to MusicBrainz, so MusicBrainz can reach
   * whoever runs this server rather than slowing every Seerr AI down.
   */
  contactEmail: string;
  /** New releases and what is popular, for Discover, from ListenBrainz. */
  listenBrainz: boolean;
  /** TheAudioDB, for artist pictures Lidarr has none of. Never sent back. */
  theAudioDbApiKey: string;
  /** The most albums one request may ask for. */
  maxAlbumsPerRequest: number;
  /** How music is searched (Settings → Music). */
  search: MusicSearchSettings;
}

/**
 * How music is searched. While music is on for someone, the search page's
 * Music and the Music page's own search box are always there for them;
 * music off for everyone, or for themselves, wins over this too.
 */
export interface MusicSearchSettings {
  /** Artists and albums below the films and series in All. */
  inAll: boolean;
}

export const MUSICBRAINZ_URL = 'https://musicbrainz.org';

export interface SonarrSettings extends DVRSettings {
  seriesType: 'standard' | 'daily' | 'anime';
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
 * The model behind the AI features. `anthropic` is Claude's own API;
 * `openai` is anything that speaks OpenAI's chat format: OpenAI itself, or
 * another service or a local server (Ollama, LM Studio) at `baseUrl`.
 */
export type AiProvider = 'anthropic' | 'openai';

/** Whether the AI features have a model they can use. */
export const aiReady = (ai?: AiSettings): boolean =>
  !!ai?.enabled &&
  !!ai.model.trim() &&
  // OpenAI itself needs a key; a local server may not.
  (ai.provider === 'anthropic' || !ai.baseUrl.trim() ? !!ai.apiKey : true);

export interface AiSettings {
  enabled: boolean;
  provider: AiProvider;
  /** Never sent back to the browser once saved. */
  apiKey: string;
  /** OpenAI-compatible only; empty means OpenAI itself. */
  baseUrl: string;
  /** Used by every feature without a model of its own below. */
  model: string;
  /** A cheaper or stronger model for one feature, by feature name. */
  featureModels: Partial<Record<AiFeature, string>>;
  /** AI uses per person per day; 0 is no limit. Admins are not limited. */
  dailyLimit: number;
}

/**
 * What the AI account has left, as far as Seerr can tell: neither provider
 * lets a program read the balance itself.
 */
export interface AiCreditSettings {
  /**
   * An admin key for the provider's own spending report. Never sent back to
   * a browser; only used with the provider it was saved for.
   */
  adminKey: string;
  /** The balance in US dollars when an admin last entered it, and when. */
  balance: number | null;
  balanceAt: string | null;
  /**
   * US dollars per million tokens, by model, for estimating spending without
   * an admin key.
   */
  prices: Record<string, { input: number; output: number }>;
  /** When the provider last said the account is out of credit. */
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
   * How big the image cache may grow, in MB, before the least recently used
   * images are removed (lib/imageproxy). Unset means the default.
   */
  imageCacheMaxMb?: number;
  defaultPermissions: number;
  /**
   * Whether people get watchlist sync (requesting what is on their Plex or
   * Trakt watchlist) turned on for movies and for series when their account
   * is made. Existing accounts keep their own choice.
   */
  defaultWatchlistSyncMovies: boolean;
  defaultWatchlistSyncTv: boolean;
  defaultQuotas: {
    movie: Quota;
    tv: Quota;
    /** Albums. */
    music: Quota;
  };
  /** Optional features (see constants/features) turned off for everyone. */
  disabledFeatures: string[];
  /**
   * Countries whose anime does not count as anime unless it is in Japanese
   * (utils/isAnime), as ISO 3166-1 codes. Empty on a new server; servers
   * from before the setting start with the United States (settings
   * migration 0011), the rule they had until then.
   */
  animeExcludedCountries: string[];
  /** Give everyone the owner shares the Plex server with an account. */
  autoImportPlexUsers: boolean;
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  hideRequested: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  newPlexLogin: boolean;
  /**
   * Who may make their own API keys (lib/personalApiKeys): nobody,
   * admins and people who manage users, or everyone. Off unless an admin
   * turns it on.
   */
  personalApiKeys: PersonalApiKeyAccess;
  /**
   * The iCloud link to the "Fix this show" shortcut an admin made and
   * shared (Settings → Features), offered on everyone's Siri page.
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
   * Look for a wrong match on each media server a few minutes after a
   * requested title is imported (lib/matchWatch), as well as nightly.
   */
  matchCheckOnImport: boolean;
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
  /** With trustProxy on, also trust Cloudflare's proxy (the orange cloud). */
  trustCloudflare: boolean;
  /**
   * With trustProxy on, also trust these addresses or ranges, such as a
   * reverse proxy on a rented server. See utils/trustedProxies.
   */
  trustedProxies: string[];
  proxy: ProxySettings;
  dnsCache: DnsCacheSettings;
  apiRequestTimeout: number;
}

interface PublicSettings {
  initialized: boolean;
}

/** A connected media server, as anyone may see it. */
export interface PublicMediaServer {
  kind: MediaServerKind;
  /** The server's own name. */
  name: string;
  primary: boolean;
  signIn: boolean;
}

/** A provider people may sign in with, as the sign-in page sees it. */
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
  /** Who may make their own API keys, for the profile's API Keys tab. */
  personalApiKeys: PersonalApiKeyAccess;
  /** The connected media servers, the primary one first. */
  mediaServers: PublicMediaServer[];
  /**
   * The single sign-on providers people may sign in with: the switched-on
   * ones, once the Application URL is set.
   */
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
  /** Bazarr is set up, so title pages can show their subtitles. */
  subtitlesReady: boolean;
  /** A Trakt Client ID is set: Trakt links and watchlists can be read. */
  traktReady: boolean;
  /**
   * A default Lidarr is set up and music is not turned off for everyone:
   * music can be searched, browsed and requested.
   */
  musicReady: boolean;
  /** Whether music comes below the films and series in All. */
  musicSearch: MusicSearchSettings;
  /** The look of everyone who has not chosen their own. */
  themeDefault: ThemeDefaults;
  /** The seasonal themes that run, and their days. */
  seasons: SeasonCalendar;
  /**
   * Custom CSS: the Server CSS's version (null for none), which pages load
   * it by, and whether people may add their own.
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

/** A new Gotify setup's priority: a notification with a sound. */
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
  /** The next id for each list of servers; see `newId`. */
  nextIds?: Partial<Record<ServerList, number>>;
  /**
   * An Emby server's ids still sit in the Jellyfin columns, from before
   * Emby had its own; they are moved once at startup (lib/embySplit).
   */
  pendingEmbySplit?: boolean;
  migrations: string[];
}

/** The lists of servers and clients whose ids are kept elsewhere. */
export type ServerList =
  | 'radarr'
  | 'sonarr'
  | 'lidarr'
  | 'maintainerr'
  | 'downloadClients';

const SETTINGS_PATH = process.env.CONFIG_DIRECTORY
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
        disabledFeatures: [],
        animeExcludedCountries: [],
        autoImportPlexUsers: false,
        hideAvailable: false,
        hideBlocklisted: false,
        hideRequested: false,
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
              // 5 makes a sound in Gotify's Android app; 0 shows nothing.
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
          // Offset from the minute boundary so it does not land alongside
          // the scans that run on the hour and half-hour.
          schedule: '20 */2 * * * *',
        },
        'episode-sync': {
          schedule: '40 */5 * * * *',
        },
        // Seasons premiere on a date, not a minute: a few checks a day is
        // plenty, and off the hour to stay clear of the scans.
        'future-seasons': {
          schedule: '0 50 */6 * * *',
        },
        // Only does anything with Auto-Import Plex Users turned on.
        'plex-user-import': {
          schedule: '0 25 */1 * * *',
        },
        'jellyfin-recently-added-scan': {
          schedule: '0 */5 * * * *',
        },
        'jellyfin-full-scan': {
          schedule: '0 0 3 * * *',
        },
        // A couple of minutes after Jellyfin's, so the two servers' scans
        // do not start together.
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
        // Report only: which series and movies disagree with Seerr about anime.
        'anime-check': {
          schedule: '0 15 4 * * *',
        },
        // Finds stuck series and searches a few of them each time.
        'backfill-scan': {
          schedule: '0 40 */6 * * *',
        },
        // Moves approved Backfill downloads along: picks files, imports
        // once they are in, cleans up after.
        'backfill-monitor': {
          schedule: '30 * * * * *',
        },
        // Looks at what Radarr and Sonarr grabbed, twice a minute: off the
        // minute, where Download Sync reads the same queues.
        'download-check': {
          schedule: '15,45 * * * * *',
        },
        // Checks the connected services and tells admins what newly went
        // wrong (Settings → Health).
        'health-watch': {
          schedule: '15 */10 * * * *',
        },
        // Report only: folders Plex matched to another title than Sonarr
        // or Radarr has in them. After the night's full scan.
        'plex-match-check': {
          schedule: '0 20 4 * * *',
        },
        // Lidarr's progress on music requests, and each media server's newly
        // added music. Off the five-minute marks the video scans run on.
        'music-sync': {
          schedule: '0 3-59/5 * * * *',
        },
        // Every music library and Lidarr, and what has gone from them.
        'music-full-scan': {
          schedule: '0 40 3 * * *',
        },
        // Clears out rows nothing reads any more, then vacuums.
        'database-maintenance': {
          schedule: '0 45 3 * * *',
        },
      },
      network: {
        csrfProtection: false,
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
      // A new install starts with each server's connection set up the way
      // migration 0010 would leave it, so it is not run on it later (where
      // it would disconnect a server connected since setup). Its channels
      // are chosen knowing of Wrong Match, so 0014 is not run on them.
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
    // Rules are read in either form, so a provider pasted from upstream's
    // settings.json (claim names in one string) works as it did there.
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

  // Settings saved before music have neither until they are next loaded
  // (which fills in defaults); made here so changes to them are kept.
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
      // For the pages that know one Jellyfin or Emby server: Emby's when
      // Emby is the one connected.
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
      musicSearch: { inAll: this.music.search.inAll },
      // Checked again here: settings.json can be edited by hand.
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
   * The Jellyfin-family server the single-server pages show: Jellyfin
   * unless Emby is connected and Jellyfin is not.
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
   * An id for a new server or download client in one of the lists. It is
   * past the highest id that list has ever had, so a removed one's id is
   * never given to another: titles, Backfill and its downloads keep the id
   * they were sent to, and must not end up pointing at a different server.
   * The caller saves the settings.
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
   * Settings Load
   *
   * This will load settings from file unless an optional argument of the object structure
   * is passed in.
   * @param overrideSettings If passed in, will override all existing settings with these
   * @param raw If true, will load the settings without running migrations or generating missing
   * values
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

    // generate keys and ids if it's missing
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
      await fs.writeFile(tmp, JSON.stringify(this.data, undefined, ' '));
      await fs.rename(tmp, SETTINGS_PATH);
    });

    this.saveLock = savePromise.catch(() => {
      // Keep the chain alive so future saves aren't blocked by past failures
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
