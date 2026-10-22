/*
 * Personal API keys, for the server and the pages alike. See
 * lib/personalApiKeys for how they are checked.
 */

/**
 * Who may make their own keys (Settings → Users): nobody, admins and people
 * who can manage users, or everyone. Off on a new server.
 */
export const PERSONAL_API_KEY_ACCESS = ['off', 'managers', 'everyone'] as const;
export type PersonalApiKeyAccess = (typeof PERSONAL_API_KEY_ACCESS)[number];

/** How long a new key lasts, in days; `null` is never. */
export const API_KEY_LIFETIMES = [30, 90, 365, null] as const;
export type ApiKeyLifetime = (typeof API_KEY_LIFETIMES)[number];
export const DEFAULT_API_KEY_LIFETIME: ApiKeyLifetime = 90;

/** How many keys one person may have, expired ones not counted. */
export const MAX_API_KEYS_PER_PERSON = 10;

/** The longest name a key may have. */
export const MAX_API_KEY_NAME_LENGTH = 64;

/** What every personal key starts with, so it can be recognised. */
export const API_KEY_PREFIX = 'sai_';

/**
 * Whether the person whose page it is can use keys: `on`, `off` (switched
 * off for everyone) or `notAllowed` (only admins and user managers may).
 */
export type ApiKeyStatus = 'on' | 'off' | 'notAllowed';

/** A key as the pages see it: never the key itself or its hash. */
export interface ApiKeySummary {
  id: number;
  name: string;
  /** The start of the key, `sai_` and its visible id, to tell keys apart. */
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
  /** The whole key. Shown this once and never again. */
  secret: string;
}

/**
 * What a key may do besides everything its owner may: 'siri' keys only
 * report problems with what is playing (/api/v1/now-playing).
 */
export const API_KEY_SCOPES = ['siri'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Someone's Siri page: their Siri key, and what the shortcut needs. */
export interface SiriKeyResponse {
  /** Their Siri key, if they have one: never the key itself. */
  key: ApiKeySummary | null;
  /** The iCloud link to the shortcut an admin shared; empty until then. */
  shortcutUrl: string;
  /** The address the shortcut reaches Seerr at, when one is set. */
  applicationUrl: string;
}
