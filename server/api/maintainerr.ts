import type { MaintainerrSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios from 'axios';

/*
 * The small part of Maintainerr's API that Seerr uses. Shapes and meanings
 * come from Maintainerr's own source (apps/server/src/modules/collections and
 * packages/contracts), not guesswork:
 *
 * - A collection deletes its items only when it is active, has a deletion
 *   window (deleteAfterDays), and its action removes files.
 * - An item is due at addDate + deleteAfterDays days, which is how
 *   Maintainerr computes it for its own countdowns.
 * - Postponing is Maintainerr's own "keep": it restarts the countdown, or
 *   pushes it out by a number of days.
 *
 * Maintainerr's API is unauthenticated. A key is sent only if one is set, for
 * a proxy in front of it.
 */

/** Maintainerr's ServarrAction, in its order. */
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
 * The actions that remove files. Unmonitor, change quality profile and do
 * nothing leave the title in place; Maintainerr's own handler treats exactly
 * these as the ones that free disk.
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
  /** The media server's id for the item, which postponing needs. */
  mediaServerId: string;
  tmdbId?: number | null;
  tvdbId?: number | null;
  addDate: string;
}

/** Long enough for a busy Maintainerr, short enough never to hang a page. */
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
   * Postpones one item's deletion. Without days, restarts the collection's
   * whole grace period; with days, pushes the deadline out by that many.
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
