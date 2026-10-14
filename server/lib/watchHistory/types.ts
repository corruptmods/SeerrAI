import type Media from '@server/entity/Media';
import type { User } from '@server/entity/User';

/*
 * What people have watched, whichever media server they watch on. Plex's
 * history comes from Tautulli; Jellyfin and Emby keep it themselves. The
 * features that use it (Suggested for You, Who Watched, Pick for the Room,
 * Catch Me Up, "up next" and watch sync on lists, and what AI Search knows
 * of someone's taste) ask through a WatchSource and never mind which.
 */

/** One play of a film or an episode. */
export interface Play {
  /**
   * When, in seconds since 1970. Tautulli keeps every play; Jellyfin and
   * Emby keep only the latest of each item, so a rewatch moves it forward.
   * 0 when the server kept no date (Emby, for an item marked watched by
   * hand).
   */
  at: number;
  kind: 'movie' | 'episode';
  /** The server's id for what was played: the film, or the episode. */
  itemId: string;
  /** The server's id for the title: the film, or the episode's series. */
  titleId: string;
  /** The film's name, or the series'. */
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** Watched to the end, as the server judges it. */
  finished: boolean;
  /** How far through, from 0 to 100. */
  percent: number;
  /** The server's id for who watched, and its name for them. */
  viewerId: string;
  viewerName: string;
}

export interface WatchSource {
  /** Where it comes from; 'multi' for several servers' history at once. */
  readonly kind: 'tautulli' | 'jellyfin' | 'emby' | 'multi';
  /** What people call where the history comes from, for messages. */
  readonly label: string;
  /** The id the server knows this person by; undefined when not linked. */
  viewerOf(user: User): string | undefined;
  /** The server's ids for a title: the regular copy and the 4K one. */
  titleIdsOf(media: Media): string[];
  /** Library titles by the server's ids for them. */
  mediaFor(titleIds: string[]): Promise<Map<string, Media>>;
  /** Seerr users by the server's ids for them. */
  usersFor(viewerIds: string[]): Promise<Map<string, User>>;
  /**
   * Someone's plays, newest first, up to `limit`. Throws when the server
   * cannot be asked: "could not ask" is not "watched nothing".
   */
  history(user: User, limit: number): Promise<Play[]>;
  /** Everyone's plays of one title: a film, or every episode of a series. */
  titleHistory(media: Media): Promise<Play[]>;
  /** One person's plays of one title since a moment. Throws on failure. */
  playsSince(user: User, media: Media, after: Date): Promise<Play[]>;
}

/** Below this, a play is someone checking what a title is. */
export const COMPLETE_PERCENT = 85;

/**
 * A play counts as finished when the server says so. Some Tautulli
 * records carry only a percentage, so that counts too.
 */
export const isCompletedPlay = (play: Play): boolean =>
  play.finished || play.percent >= COMPLETE_PERCENT;
