import ExternalAPI from '@server/api/externalapi';
import { assertCompatible } from '@server/api/silo/compat';
import type {
  SiloAccount,
  SiloAccountProfile,
  SiloAdminUser,
  SiloAdminUserChange,
  SiloApiKeyCreated,
  SiloBranding,
  SiloCatalogCapabilities,
  SiloCatalogItem,
  SiloCollection,
  SiloDevicePoll,
  SiloDeviceStart,
  SiloIdentity,
  SiloItemType,
  SiloPlaybackHistoryEntry,
  SiloPlaybackSession,
  SiloProblemBody,
  SiloServerStatus,
  SiloSystemInfo,
  SiloTokenPair,
  SiloUserLibrary,
} from '@server/api/silo/types';
import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';

/*
 * Silo's native API (/api/v2), reached with an administrator's API key
 * (Bearer sa_…). The only place that builds Silo URLs or reads Silo's JSON.
 */

/** Silo's largest page. */
export const SILO_PAGE_LIMIT = 200;

/** Most content_ids one catalog request takes, unless Silo says otherwise. */
export const SILO_MAX_CONTENT_IDS = 200;

/**
 * Content ids Seerr AI asks for at once. Each is its own content_ids
 * parameter, so a batch stays well under a proxy's 8k request line.
 */
export const SILO_CONTENT_ID_BATCH = 100;

/** The scopes Seerr AI needs on its key. */
export const SILO_REQUIRED_SCOPES = [
  'admin:monitor:read',
  'libraries:read',
] as const;

/** Scopes that turn on more, when the key has them. */
export const SILO_OPTIONAL_SCOPES = [
  'admin:users',
  'admin:catalog:paths',
] as const;

export type SiloOptionalScopeName = (typeof SILO_OPTIONAL_SCOPES)[number];

/** Times a page is retried after Silo asks to slow down. */
const RATE_LIMIT_RETRIES = 2;
/** Longest wait Seerr AI honours from Retry-After, in seconds. */
const MAX_RETRY_AFTER = 30;

/** A refused or failed Silo request, with a message people can act on. */
export class SiloError extends Error {
  constructor(
    /** HTTP status; 0 when Silo couldn't be reached. */
    public readonly status: number,
    /** Silo's problem identifier (e.g. permission_denied), when it sent one. */
    public readonly code: string | undefined,
    message: string,
    /** Seconds Silo asked to wait, on a 429. */
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'SiloError';
  }
}

const problemCode = (body: SiloProblemBody | undefined): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  if (typeof body.type === 'string' && body.type) {
    return body.type.split('/').filter(Boolean).pop();
  }
  return typeof body.error === 'string' ? body.error : undefined;
};

const messageFor = (status: number, code?: string): string => {
  if (status === 0) {
    return "Seerr AI couldn't reach Silo at that address.";
  }
  if (code === 'password_change_required') {
    return 'This Silo account has a temporary password. Sign in to Silo and change it first.';
  }
  switch (status) {
    case 401:
      return "Silo didn't accept these credentials.";
    case 403:
      return "Silo didn't allow this request.";
    case 404:
      return 'Silo has nothing at this address. Check the address and URL base.';
    case 412:
    case 428:
      return 'The account changed in Silo meanwhile. Try again.';
    case 429:
      return 'Silo is limiting requests. Try again in a moment.';
    default:
      return status >= 500
        ? `Silo had a problem answering (error ${status}).`
        : `Silo refused the request (error ${status}).`;
  }
};

/** Turns any request failure into a SiloError. */
export const toSiloError = (e: unknown): SiloError => {
  if (e instanceof SiloError) return e;
  if (axios.isAxiosError(e)) {
    const error = e as AxiosError<SiloProblemBody>;
    const status = error.response?.status ?? 0;
    const code = problemCode(error.response?.data);
    const retryHeader = Number(error.response?.headers?.['retry-after']);
    return new SiloError(
      status,
      code,
      messageFor(status, code),
      Number.isFinite(retryHeader) ? retryHeader : undefined
    );
  }
  return new SiloError(0, undefined, messageFor(0));
};

/**
 * A collection's items. Anything that isn't a collection (a proxy's sign-in
 * page answering 200, say) is an error, never "nothing there".
 */
const itemsOf = <T>(collection: SiloCollection<T> | undefined): T[] => {
  if (
    !collection ||
    typeof collection !== 'object' ||
    !Array.isArray(collection.items)
  ) {
    throw new SiloError(
      502,
      'bad_page',
      'Silo sent something that is not a list. Check the address and URL base.'
    );
  }
  return collection.items;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ListParams = Record<
  string,
  string | number | boolean | string[] | undefined
>;

export interface PlaybackHistoryQuery {
  userId?: string;
  profileId?: string;
  /** Plays that ended at or after this time. */
  endedAfter?: Date;
  /** Plays that ended before this time. */
  endedBefore?: Date;
}

export interface CatalogQuery {
  libraryId?: string;
  type?: SiloItemType;
  /** Only items Silo first saw at or after this time. */
  addedAfter?: Date;
  /** Each file's path too; needs the admin:catalog:paths scope. */
  includeFilePaths?: boolean;
}

/** What connecting with a key found it may do. */
export interface SiloScopeProbe {
  /** Required scopes the key lacks; empty when it has both. */
  missing: string[];
  /** Optional scopes it holds. */
  optional: SiloOptionalScopeName[];
}

/** A catalog query as Silo's parameters. */
const catalogParams = (query: CatalogQuery): ListParams => ({
  library_id: query.libraryId,
  type: query.type,
  added_after: query.addedAfter?.toISOString(),
  include_file_paths: query.includeFilePaths || undefined,
});

/** How Seerr AI names itself on the sign-in sessions Silo records. */
const DEVICE_NAME = 'Seerr AI';
const DEVICE_PLATFORM = 'server';

const deviceHeaders = (deviceId: string) => ({
  'X-Silo-Device-Id': deviceId,
  'X-Silo-Device-Name': DEVICE_NAME,
  'X-Silo-Device-Platform': DEVICE_PLATFORM,
});

class SiloAPI extends ExternalAPI {
  private readonly siloBase: string;

  /**
   * @param hostname Silo's address, scheme to URL base (no /api/v2).
   * @param apiKey An API key; leave out for public calls and sign-in.
   */
  constructor(
    hostname: string,
    apiKey?: string,
    { timeout = 30_000 }: { timeout?: number } = {}
  ) {
    super(
      `${hostname.replace(/\/+$/, '')}/api/v2`,
      {},
      {
        timeout,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      }
    );
    this.siloBase = hostname.replace(/\/+$/, '');
  }

  private async call<T>(
    endpoint: string,
    config?: AxiosRequestConfig
  ): Promise<T> {
    try {
      return await this.get<T>(endpoint, config, 0);
    } catch (e) {
      throw toSiloError(e);
    }
  }

  /** A GET that waits out Silo's rate limit a couple of times. */
  private patient<T>(
    endpoint: string,
    config?: AxiosRequestConfig
  ): Promise<T> {
    return this.waitingOutRateLimit(() => this.call<T>(endpoint, config));
  }

  /**
   * Runs a request (which throws SiloError), again after Silo's
   * Retry-After when Silo answers 429, a couple of times. Only for requests
   * safe to repeat: a 429 means Silo did nothing.
   */
  private async waitingOutRateLimit<T>(request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request();
      } catch (e) {
        const error = e as SiloError;
        if (error.status !== 429 || attempt >= RATE_LIMIT_RETRIES) throw e;
        const wait = Math.min(error.retryAfter ?? 2, MAX_RETRY_AFTER);
        await sleep(Math.max(wait, 0) * 1000);
      }
    }
  }

  private async send<T>(
    endpoint: string,
    data?: Record<string, unknown>,
    config?: AxiosRequestConfig
  ): Promise<T> {
    try {
      return await this.post<T>(endpoint, data, config);
    } catch (e) {
      throw toSiloError(e);
    }
  }

  /**
   * Every page of a cursor-paged collection. A list value is sent as one
   * parameter per entry (content_ids=a&content_ids=b), as Silo reads them. A
   * page that isn't a collection, or says there is more without a cursor, is
   * an error: it must never read as "nothing there".
   */
  public async listAll<T>(
    endpoint: string,
    params: ListParams = {}
  ): Promise<T[]> {
    const items: T[] = [];
    for await (const page of this.pages<T>(endpoint, params)) {
      items.push(...page);
    }
    return items;
  }

  /** The pages of a cursor-paged collection one by one, as listAll reads them. */
  public async *pages<T>(
    endpoint: string,
    params: ListParams = {}
  ): AsyncGenerator<T[]> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.patient<SiloCollection<T>>(endpoint, {
        params: { ...params, limit: SILO_PAGE_LIMIT, cursor },
        paramsSerializer: { indexes: null },
      });
      itemsOf(page);
      if (page.page?.has_more && !page.page.next_cursor) {
        throw new SiloError(
          502,
          'bad_page',
          'Silo said there was more to read but gave no way to read it.'
        );
      }
      yield page.items;
      cursor = page.page?.has_more ? page.page.next_cursor : undefined;
      if (!cursor) return;
    }
  }

  /**
   * Finished plays, newest ended first, a page at a time. endedAfter is
   * inclusive, endedBefore exclusive, as Silo reads them.
   */
  public playbackHistoryPages(
    query: PlaybackHistoryQuery = {}
  ): AsyncGenerator<SiloPlaybackHistoryEntry[]> {
    return this.pages<SiloPlaybackHistoryEntry>('/admin/playback-history', {
      user_id: query.userId,
      profile_id: query.profileId,
      ended_after: query.endedAfter?.toISOString(),
      ended_before: query.endedBefore?.toISOString(),
    });
  }

  /** What is playing now; one account's sessions when userId is given. */
  public listSessions(userId?: string): Promise<SiloPlaybackSession[]> {
    return this.listAll<SiloPlaybackSession>('/admin/sessions', {
      user_id: userId,
    });
  }

  public getSystemInfo(): Promise<SiloSystemInfo> {
    return this.call<SiloSystemInfo>('/system/info');
  }

  /** System info, after checking Silo speaks the supported API major. */
  public async getCompatibleInfo(): Promise<SiloSystemInfo> {
    const info = await this.getSystemInfo();
    assertCompatible(info);
    return info;
  }

  public getIdentity(): Promise<SiloIdentity> {
    return this.call<SiloIdentity>('/system/identity');
  }

  /** The server's display name; empty when Silo doesn't say. */
  public async getServerName(): Promise<string> {
    try {
      const branding = await this.call<SiloBranding>('/theme/branding');
      return branding.server_name?.trim() ?? '';
    } catch {
      return '';
    }
  }

  public getServerStatus(): Promise<SiloServerStatus> {
    return this.call<SiloServerStatus>('/admin/server/status');
  }

  public getCatalogCapabilities(): Promise<SiloCatalogCapabilities> {
    return this.call<SiloCatalogCapabilities>('/admin/catalog/capabilities');
  }

  /** Libraries the key's account may see (all enabled ones for an admin). */
  public async getUserLibraries(): Promise<SiloUserLibrary[]> {
    // One unpaged collection; the route takes no paging parameters.
    const libraries =
      await this.patient<SiloCollection<SiloUserLibrary>>('/user/libraries');
    return itemsOf(libraries);
  }

  /** Every catalog item matching the query. */
  public listCatalogItems(
    query: CatalogQuery = {}
  ): Promise<SiloCatalogItem[]> {
    return this.listAll<SiloCatalogItem>(
      '/admin/catalog/items',
      catalogParams(query)
    );
  }

  /**
   * The catalog items matching the query a page at a time, for reading a
   * large library without holding all of it.
   */
  public catalogItemPages(
    query: CatalogQuery = {}
  ): AsyncGenerator<SiloCatalogItem[]> {
    return this.pages<SiloCatalogItem>(
      '/admin/catalog/items',
      catalogParams(query)
    );
  }

  /**
   * The items Silo still has among these content ids, in batches it accepts.
   * An id missing from the answer is gone from Silo.
   */
  public async getCatalogItems(
    contentIds: string[],
    batchSize = SILO_CONTENT_ID_BATCH
  ): Promise<SiloCatalogItem[]> {
    const ids = [...new Set(contentIds.filter(Boolean))];
    const size = Math.max(1, Math.min(batchSize, SILO_MAX_CONTENT_IDS));
    const found: SiloCatalogItem[] = [];
    for (let start = 0; start < ids.length; start += size) {
      found.push(
        ...(await this.listAll<SiloCatalogItem>('/admin/catalog/items', {
          content_ids: ids.slice(start, start + size),
        }))
      );
    }
    return found;
  }

  /**
   * Whether a GET is allowed: true on success, false on 403. Anything else
   * (a wrong key, an unreachable server) is thrown.
   */
  private async allows(
    endpoint: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<boolean> {
    try {
      await this.call(endpoint, { params: { limit: 1, ...params } });
      return true;
    } catch (e) {
      if ((e as SiloError).status === 403) return false;
      throw e;
    }
  }

  /**
   * Finds which scopes the key holds by trying one small read each. Scopes
   * never bypass Silo's roles, so a success on an admin route also shows the
   * key belongs to an administrator.
   */
  public async probeScopes(): Promise<SiloScopeProbe> {
    const monitorRoutes = [
      '/admin/catalog/items',
      '/admin/playback-history',
      '/admin/users',
      '/admin/sessions',
    ];
    const missing: string[] = [];
    for (const route of monitorRoutes) {
      if (!(await this.allows(route))) {
        missing.push('admin:monitor:read');
        break;
      }
    }
    // Has no limit parameter.
    try {
      await this.call('/admin/server/status');
    } catch (e) {
      if ((e as SiloError).status !== 403) throw e;
      if (!missing.includes('admin:monitor:read')) {
        missing.push('admin:monitor:read');
      }
    }
    try {
      await this.call('/user/libraries');
    } catch (e) {
      if ((e as SiloError).status !== 403) throw e;
      missing.push('libraries:read');
    }
    const optional: SiloOptionalScopeName[] = [];
    if (!missing.length) {
      try {
        await this.call('/admin/users/policy-defaults');
        optional.push('admin:users');
      } catch (e) {
        const status = (e as SiloError).status;
        if (status !== 403 && status !== 404) throw e;
      }
      if (
        await this.allows('/admin/catalog/items', { include_file_paths: true })
      ) {
        optional.push('admin:catalog:paths');
      }
    }
    return { missing, optional };
  }

  /**
   * Signs in with a Silo account. Without a provider Silo routes the name
   * itself: a local password, else its directory (LDAP) provider.
   */
  public login(
    username: string,
    password: string,
    deviceId: string,
    provider?: string
  ): Promise<SiloTokenPair> {
    return this.send<SiloTokenPair>(
      '/auth/login',
      { username, password, ...(provider ? { provider } : {}) },
      { headers: deviceHeaders(deviceId) }
    );
  }

  /** Starts a device sign-in: a code someone approves in Silo. */
  public startDeviceLogin(): Promise<SiloDeviceStart> {
    return this.send<SiloDeviceStart>('/auth/device/start', {
      device_name: DEVICE_NAME,
      device_platform: DEVICE_PLATFORM,
    });
  }

  /** Asks whether a device sign-in was approved; tokens come once. */
  public pollDeviceLogin(
    deviceCode: string,
    deviceId: string
  ): Promise<SiloDevicePoll> {
    return this.send<SiloDevicePoll>(
      '/auth/device/poll',
      { device_code: deviceCode },
      { headers: deviceHeaders(deviceId) }
    );
  }

  /** Withdraws a device sign-in; failures are ignored. */
  public async cancelDeviceLogin(deviceCode: string): Promise<void> {
    try {
      await this.send('/auth/device/cancel', { device_code: deviceCode });
    } catch {
      // It expires on its own.
    }
  }

  /** One account; a SiloError with status 404 when Silo has no such one. */
  public getAdminUser(accountId: string): Promise<SiloAdminUser> {
    return this.patient<SiloAdminUser>(
      `/admin/users/${encodeURIComponent(accountId)}`
    );
  }

  /**
   * One account with the tag a change to it must send back; a SiloError
   * with status 404 when Silo has no such one.
   */
  public async getAdminUserForChange(
    accountId: string
  ): Promise<{ account: SiloAdminUser; tag: string }> {
    const response = await this.waitingOutRateLimit(() =>
      this.axios
        .get<SiloAdminUser>(`/admin/users/${encodeURIComponent(accountId)}`)
        .catch((e) => {
          throw toSiloError(e);
        })
    );
    const tag = response.headers?.etag;
    if (!response.data?.id || typeof tag !== 'string' || !tag) {
      throw new SiloError(
        502,
        'bad_account',
        'Silo sent an account Seerr AI could not change.'
      );
    }
    return { account: response.data, tag };
  }

  /**
   * Changes an account (admin:users). `tag` is from the read just before:
   * Silo refuses the change if the account changed since.
   */
  public async updateAdminUser(
    accountId: string,
    tag: string,
    change: SiloAdminUserChange
  ): Promise<void> {
    // Repeated with the same tag after a 429: Silo changed nothing, and a
    // change made meanwhile still refuses it.
    await this.waitingOutRateLimit(() =>
      this.axios
        .put(`/admin/users/${encodeURIComponent(accountId)}`, change, {
          headers: { 'If-Match': tag },
        })
        .catch((e) => {
          throw toSiloError(e);
        })
    );
  }

  /** Every account on Silo. */
  public listAdminUsers(): Promise<SiloAdminUser[]> {
    return this.listAll<SiloAdminUser>('/admin/users');
  }

  /**
   * An account's household profiles. `wait: false` answers a rate limit at
   * once with an error instead of waiting it out.
   */
  public async getAccountProfiles(
    accountId: string,
    { wait = true }: { wait?: boolean } = {}
  ): Promise<SiloAccountProfile[]> {
    // A complete, unpaged collection.
    const endpoint = `/admin/users/${encodeURIComponent(accountId)}/profiles`;
    const profiles = await (wait
      ? this.patient<SiloCollection<SiloAccountProfile>>(endpoint)
      : this.call<SiloCollection<SiloAccountProfile>>(endpoint));
    return itemsOf(profiles);
  }

  /**
   * Where a picture Silo names lives: a path on Silo becomes a full address
   * on it (fetched with the key); anything else is another host's, such as
   * a signed storage address (fetched without it). Undefined for anything
   * that isn't http(s).
   */
  public pictureAddress(
    reference: string
  ): { url: string; onSilo: boolean } | undefined {
    let base: URL;
    try {
      base = new URL(`${this.siloBase}/`);
    } catch {
      return undefined;
    }
    let path = reference.trim();
    // A path from the server root, under the URL base Silo is reached at.
    const urlBase = base.pathname.replace(/\/+$/, '');
    if (path.startsWith('/') && !path.startsWith('//') && urlBase) {
      if (!path.startsWith(`${urlBase}/`)) path = `${urlBase}${path}`;
    }
    let url: URL;
    try {
      url = new URL(path, base);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return { url: url.toString(), onSilo: url.origin === base.origin };
  }

  /** Ends a sign-in session; failures are ignored. */
  public async logout(accessToken: string): Promise<void> {
    try {
      await this.send('/auth/logout', undefined, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // The session expires on its own.
    }
  }

  /** Deletes a key with an administrator's sign-in; failures are ignored. */
  public async deleteApiKey(accessToken: string, keyId: string): Promise<void> {
    try {
      // Silo deletes only on a precondition; "*" is any current version.
      await this.axios.delete(`/admin/api-keys/${encodeURIComponent(keyId)}`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'If-Match': '*' },
      });
    } catch {
      // Left for the administrator to remove in Silo.
    }
  }

  /** Creates an API key for the signed-in administrator. */
  public createApiKey(
    accessToken: string,
    { label, scopes }: { label: string; scopes: string[] }
  ): Promise<SiloApiKeyCreated> {
    return this.send<SiloApiKeyCreated>(
      '/admin/api-keys',
      { label, scopes },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  }
}

export type { SiloAccount };
export default SiloAPI;
