import type Media from '@server/entity/Media';
import type { User } from '@server/entity/User';

/*
 * Server-agnostic watch history: Tautulli for Plex, native for Jellyfin and
 * Emby. Features using it go through WatchSource only.
 */

/** One play of a film or an episode. */
export interface Play {
  /**
   * Unix seconds. Jellyfin and Emby keep only each item's latest play.
   * 0 when undated (Emby, for an item marked watched by hand).
   */
  at: number;
  kind: 'movie' | 'episode';
  /** Server id of the film or episode played. */
  itemId: string;
  /** Server id of the film or the episode's series. */
  titleId: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** Finished, as the server judges it. */
  finished: boolean;
  /** 0–100. */
  percent: number;
  /** Server id and name of the viewer. */
  viewerId: string;
  viewerName: string;
}

export interface WatchSource {
  /** 'multi' when merging several servers. */
  readonly kind: 'tautulli' | 'jellyfin' | 'emby' | 'multi';
  /** Display name for messages. */
  readonly label: string;
  /** The user's server id; undefined when not linked. */
  viewerOf(user: User): string | undefined;
  /** Server ids for a title (regular and 4K). */
  titleIdsOf(media: Media): string[];
  /** Library media keyed by server title id. */
  mediaFor(titleIds: string[]): Promise<Map<string, Media>>;
  /** Seerr users keyed by server viewer id. */
  usersFor(viewerIds: string[]): Promise<Map<string, User>>;
  /**
   * A user's plays, newest first. Throws if the server can't be reached:
   * "could not ask" is not "watched nothing".
   */
  history(user: User, limit: number): Promise<Play[]>;
  /** Everyone's plays of a film or every episode of a series. */
  titleHistory(media: Media): Promise<Play[]>;
  /** One user's plays of a title after `after`. Throws on failure. */
  playsSince(user: User, media: Media, after: Date): Promise<Play[]>;
}

/** Below this, a play is just sampling the title. */
export const COMPLETE_PERCENT = 85;

/**
 * Finished per the server, or by percentage (some Tautulli records have only
 * that).
 */
export const isCompletedPlay = (play: Play): boolean =>
  play.finished || play.percent >= COMPLETE_PERCENT;
