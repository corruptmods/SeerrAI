import type { MaintainerrSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios from 'axios';

/*
 * Shapes and semantics follow Maintainerr's source
 * (apps/server/src/modules/collections and packages/contracts):
 *
 * - A collection deletes its items only when it is active, has a deletion
 *   window (deleteAfterDays), and its action removes files.
 * - An item is due at addDate + deleteAfterDays days, as Maintainerr's own
 *   countdowns compute it.
 * - Postponing is Maintainerr's "keep": it restarts the countdown or extends
 *   it by some days.
 *
 * Maintainerr's API is unauthenticated; a key is sent only if set, for a
 * proxy in front of it.
 */

/** Maintainerr's ServarrAction; order matters. */
export enum MaintainerrAction {
  DELETE = 0,
  UNMONITOR_DELETE_ALL = 1,
  UNMONITOR_DELETE_EXISTING = 2,
  UNMONITOR = 3,
  DO_NOTHING = 4,
  DELETE_SHOW_IF_EMPTY = 5,
  UNMONITOR_SHOW_IF_EMPTY = 6,
  CHANGE_QUALITY_PROFILE = 7,
}

/**
 * Actions that remove files, matching Maintainerr's own handler. Unmonitor,
 * change quality profile and do nothing leave the title in place.
 */
export const DELETING_ACTIONS = new Set<number>([
  MaintainerrAction.DELETE,
  MaintainerrAction.UNMONITOR_DELETE_ALL,
  MaintainerrAction.UNMONITOR_DELETE_EXISTING,
  MaintainerrAction.DELETE_SHOW_IF_EMPTY,
]);

export interface MaintainerrCollection {
  id: number;
  title: string;
  isActive: boolean;
  arrAction: number;
  deleteAfterDays: number | null;
  /** 'movie' | 'show' | 'season' | 'episode' */
  type: string;
}

export interface MaintainerrCollectionMedia {
  id: number;
  collectionId: number;
  /** Media server item id; postponing needs it. */
  mediaServerId: string;
  tmdbId?: number | null;
  tvdbId?: number | null;
  addDate: string;
}

/** Long enough for a busy Maintainerr, short enough not to hang a page. */
const TIMEOUT_MS = 10_000;

export const maintainerrBaseUrl = (
  settings: Pick<
    MaintainerrSettings,
    'hostname' | 'port' | 'useSsl' | 'urlBase'
  >
): string => {
  const base = (settings.urlBase ?? '').replace(/^\/+|\/+$/g, '');
  return `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${
    settings.port
  }${base ? `/${base}` : ''}`;
};

class MaintainerrAPI {
  private axios: AxiosInstance;

  constructor(
    settings: Pick<
      MaintainerrSettings,
      'hostname' | 'port' | 'useSsl' | 'urlBase' | 'apiKey'
    >
  ) {
    this.axios = axios.create({
      baseURL: `${maintainerrBaseUrl(settings)}/api`,
      timeout: TIMEOUT_MS,
      headers: settings.apiKey ? { 'X-Api-Key': settings.apiKey } : {},
    });
  }

  /** Maintainerr's version; used to test the connection. */
  public async getVersion(): Promise<string> {
    const { data } = await this.axios.get<string | { version?: string }>(
      '/settings/version'
    );
    return typeof data === 'string' ? data : (data?.version ?? 'unknown');
  }

  public async getCollections(): Promise<MaintainerrCollection[]> {
    const { data } = await this.axios.get<MaintainerrCollection[] | undefined>(
      '/collections'
    );
    return Array.isArray(data) ? data : [];
  }

  public async getCollectionMedia(
    collectionId: number
  ): Promise<MaintainerrCollectionMedia[]> {
    const { data } = await this.axios.get<
      MaintainerrCollectionMedia[] | undefined
    >('/collections/media/', { params: { collectionId } });
    return Array.isArray(data) ? data : [];
  }

  /**
   * Postpones one item's deletion: without days, restarts the collection's
   * grace period; with days, extends the deadline by that many.
   */
  public async postpone(
    collectionId: number,
    mediaServerId: string,
    days?: number
  ): Promise<void> {
    await this.axios.post('/collections/media/postpone', {
      collectionId,
      mediaId: mediaServerId,
      ...(days && days > 0 ? { days } : {}),
    });
  }
}

export default MaintainerrAPI;
