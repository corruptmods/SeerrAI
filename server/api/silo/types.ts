/*
 * The parts of Silo's native API (/api/v2) Seerr AI reads, written by hand
 * from Silo's published contract. Fields Silo may add later are ignored, and
 * enums are read as plain strings so a new value never breaks a scan.
 */

/** GET /system/info, public. */
export interface SiloSystemInfo {
  server_version: string;
  api_major: number;
  contract_digest: string;
  links?: { openapi?: string; capabilities?: string; identity?: string };
  request_origin?: string;
}

/** GET /system/identity, public: the deployment's stable id. */
export interface SiloIdentity {
  server_id: string;
}

/** GET /theme/branding, public. */
export interface SiloBranding {
  server_name?: string;
}

/** Cursor state of a page; absent on unpaginated collections. */
export interface SiloPageInfo {
  has_more: boolean;
  next_cursor?: string;
}

export interface SiloCollection<T> {
  items: T[];
  page?: SiloPageInfo;
}

/** One file of a catalog item. */
export interface SiloCatalogVersion {
  file_id: string;
  library_id: string;
  /** '480p', '720p', '1080p', '2160p', '4320p'; absent before probing. */
  resolution?: string;
  /** sdr, hdr10, hdr10_plus, hlg, dolby_vision, hdr_unknown; or absent. */
  dynamic_range?: string;
  codec_video?: string;
  bitrate_kbps?: number;
  edition?: string;
}

export type SiloItemType = 'movie' | 'series' | 'episode';

/** A row of GET /admin/catalog/items. */
export interface SiloCatalogItem {
  content_id: string;
  type: SiloItemType | string;
  title: string;
  year?: number;
  tmdb_id?: string;
  tvdb_id?: string;
  imdb_id?: string;
  library_ids: string[];
  added_at: string;
  /** An episode's series content_id. */
  series_id?: string;
  series_title?: string;
  season_number?: number;
  episode_number?: number;
  /** Each present file; empty for a series. */
  versions: SiloCatalogVersion[];
}

/** GET /admin/catalog/capabilities. */
export interface SiloCatalogCapabilities {
  item_listing?: boolean;
  item_listing_max_content_ids?: number;
  item_file_paths?: boolean;
  state?: string;
  allowed?: boolean;
}

/** A row of GET /user/libraries. `type` is free text in Silo. */
export interface SiloUserLibrary {
  id: string;
  name: string;
  type: string;
  sort_order?: number;
}

export interface SiloHealthComponent {
  configured?: boolean;
  ok?: boolean;
  latency_ms?: number;
}

/** GET /admin/server/status. */
export interface SiloServerStatus {
  started_at?: string;
  restart_required?: boolean;
  restart_required_reason?: string;
  health?: {
    postgres?: SiloHealthComponent;
    redis?: SiloHealthComponent;
    errors_24h?: number;
    warnings_24h?: number;
  };
}

/** A Silo account. */
export interface SiloAccount {
  id: string;
  username: string;
  email?: string;
  role: 'admin' | 'user' | string;
  password_change_required?: boolean;
}

/** A row of GET /admin/users, and GET /admin/users/{id}. */
export interface SiloAdminUser {
  id: string;
  username: string;
  /** Empty when none is set. */
  email?: string;
  role: 'admin' | 'user' | string;
  enabled: boolean;
  is_owner?: boolean;
  /** Explicit library allowlist; null inherits the group's. */
  library_ids?: string[] | null;
}

/** A row of GET /admin/users/{id}/profiles: one household profile. */
export interface SiloAccountProfile {
  id: string;
  name: string;
  /** Avatar reference; empty when none. Changes when the picture does. */
  avatar?: string;
  /**
   * Where to fetch the picture: a path on Silo, or a signed address that
   * expires. Absent when there is none.
   */
  avatar_url?: string;
  avatar_source?: string;
  has_pin?: boolean;
  /** The household parent. */
  is_primary: boolean;
  is_child?: boolean;
}

/** POST /auth/device/start. */
export interface SiloDeviceStart {
  /** Secret Seerr AI polls with; never shown. */
  device_code: string;
  /** Eight digits, e.g. 4821-7730. */
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_at: string;
  expires_in: number;
  /** Seconds between polls. */
  interval: number;
}

export type SiloDeviceStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'consumed'
  | 'canceled'
  | 'expired';

/** POST /auth/device/poll. */
export interface SiloDevicePoll {
  status: SiloDeviceStatus | string;
  /** An approver has looked the code up. */
  opened?: boolean;
  poll_after?: number;
  expires_at?: string;
  /** The profile the approver chose; empty for a full sign-in. */
  profile_id?: string;
  /** Only when approved, once. */
  tokens?: SiloTokenPair;
}

/** POST /auth/login. */
export interface SiloTokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: SiloAccount;
}

/** POST /admin/api-keys: the key is shown only in this answer. */
export interface SiloApiKeyCreated {
  id: string;
  user_id: string;
  label: string;
  key: string;
  scopes: string[];
}

/** An RFC 9457 problem, or the older {error, message} body. */
export interface SiloProblemBody {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  error?: string;
  message?: string;
}
