// Personal API keys, shared by the server and pages. See lib/personalApiKeys
// for how they're checked.

/**
 * Who may create their own keys (Settings → Users): nobody, admins and user
 * managers, or everyone. Off on a new server.
 */
export const PERSONAL_API_KEY_ACCESS = ['off', 'managers', 'everyone'] as const;
export type PersonalApiKeyAccess = (typeof PERSONAL_API_KEY_ACCESS)[number];

/** A new key's lifetime in days; `null` is never. */
export const API_KEY_LIFETIMES = [30, 90, 365, null] as const;
export type ApiKeyLifetime = (typeof API_KEY_LIFETIMES)[number];
export const DEFAULT_API_KEY_LIFETIME: ApiKeyLifetime = 90;

/** Max keys per user, excluding expired ones. */
export const MAX_API_KEYS_PER_PERSON = 10;

export const MAX_API_KEY_NAME_LENGTH = 64;

/** Prefix of every personal key, so it can be recognised. */
export const API_KEY_PREFIX = 'sai_';

/**
 * Whether the page's user can use keys: `on`, `off` (disabled for everyone) or
 * `notAllowed` (only admins and user managers may).
 */
export type ApiKeyStatus = 'on' | 'off' | 'notAllowed';

/** A key as pages see it: never the key or its hash. */
export interface ApiKeySummary {
  id: number;
  name: string;
  /** The key's start (`sai_` and its visible id), to tell keys apart. */
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  expired: boolean;
}

export interface ApiKeyListResponse {
  keys: ApiKeySummary[];
  status: ApiKeyStatus;
  limit: number;
}

export interface ApiKeyCreatedResponse {
  key: ApiKeySummary;
  /** The full key. Shown once only. */
  secret: string;
}

/**
 * Restrictions on top of the owner's permissions: 'siri' keys may only report
 * problems with what's playing (/api/v1/now-playing).
 */
export const API_KEY_SCOPES = ['siri'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** A user's Siri page: their Siri key and what the shortcut needs. */
export interface SiriKeyResponse {
  /** Their Siri key's summary, if any: never the key itself. */
  key: ApiKeySummary | null;
  /** The iCloud link to the admin-shared shortcut; empty until shared. */
  shortcutUrl: string;
  /** The URL the shortcut reaches Seerr at, when set. */
  applicationUrl: string;
}
