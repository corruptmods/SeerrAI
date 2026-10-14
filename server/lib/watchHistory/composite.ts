import type { MediaServerKind } from '@server/constants/server';
import type Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import type { Play, WatchSource } from '@server/lib/watchHistory/types';
import logger from '@server/logger';

/*
 * Watch history from several media servers at once: Tautulli for Plex, and
 * Jellyfin and Emby themselves. Each server's ids are told apart by the
 * server's name in front ("plex:123", "jellyfin:4f2a…"), so a title, an
 * episode or a person on one server is never taken for one on another.
 * Asked for history, it asks every server the person or title is on and
 * puts the answers together; one server failing gives the others' answers
 * (and a line in the log) rather than no answer at all.
 */

/** One server's watch history, and the server it is for. */
export interface ServerWatchSource {
  server: MediaServerKind;
  source: WatchSource;
}

const tag = (server: MediaServerKind, id: string) => `${server}:${id}`;

/** The server and its own id, from a tagged id; undefined when untagged. */
const untag = (
  id: string
): { server: MediaServerKind; id: string } | undefined => {
  const at = id.indexOf(':');
  if (at < 0) return undefined;
  return { server: id.slice(0, at) as MediaServerKind, id: id.slice(at + 1) };
};

const tagPlay = (server: MediaServerKind, play: Play): Play => ({
  ...play,
  itemId: tag(server, play.itemId),
  titleId: tag(server, play.titleId),
  viewerId: tag(server, play.viewerId),
});

const newestFirst = (a: Play, b: Play) => b.at - a.at;

/** "Tautulli", "Tautulli and Jellyfin", "Tautulli, Jellyfin and Emby". */
const listed = (names: string[]): string =>
  names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : (names[0] ?? '');

export class CompositeWatchSource implements WatchSource {
  public readonly kind = 'multi' as const;
  public readonly label: string;

  constructor(private readonly sources: ServerWatchSource[]) {
    this.label = listed(sources.map(({ source }) => source.label));
  }

  /**
   * Every account the person has on a server with history, tagged: one
   * string, so it also tells a person's linked accounts apart in caches.
   */
  public viewerOf(user: User): string | undefined {
    const ids = this.sources.flatMap(({ server, source }) => {
      const id = source.viewerOf(user);
      return id ? [tag(server, id)] : [];
    });
    return ids.length ? ids.join(',') : undefined;
  }

  public titleIdsOf(media: Media): string[] {
    return this.sources.flatMap(({ server, source }) =>
      source.titleIdsOf(media).map((id) => tag(server, id))
    );
  }

  /** Tagged ids, sorted out by the server they are for. */
  private byServer(
    ids: string[]
  ): Map<WatchSource, [MediaServerKind, string[]]> {
    const grouped = new Map<WatchSource, [MediaServerKind, string[]]>();
    for (const tagged of ids) {
      const parts = untag(tagged);
      const entry = this.sources.find(({ server }) => server === parts?.server);
      if (!parts || !entry) continue;
      const [, own] = grouped.get(entry.source) ?? [entry.server, []];
      own.push(parts.id);
      grouped.set(entry.source, [entry.server, own]);
    }
    return grouped;
  }

  public async mediaFor(titleIds: string[]): Promise<Map<string, Media>> {
    const found = new Map<string, Media>();
    for (const [source, [server, ids]] of this.byServer(titleIds)) {
      for (const [id, media] of await source.mediaFor(ids)) {
        found.set(tag(server, id), media);
      }
    }
    return found;
  }

  public async usersFor(viewerIds: string[]): Promise<Map<string, User>> {
    const found = new Map<string, User>();
    for (const [source, [server, ids]] of this.byServer(viewerIds)) {
      for (const [id, user] of await source.usersFor(ids)) {
        found.set(tag(server, id), user);
      }
    }
    return found;
  }

  /**
   * Asks each server given, and puts their plays together. A server that
   * fails is logged and left out; only when every one fails does it throw,
   * since "could not ask" is not "watched nothing".
   */
  private async gather(
    asked: ServerWatchSource[],
    ask: (source: WatchSource) => Promise<Play[]>
  ): Promise<Play[]> {
    const answers = await Promise.allSettled(
      asked.map(({ source }) => ask(source))
    );
    const plays: Play[] = [];
    const failures: unknown[] = [];
    answers.forEach((answer, index) => {
      const { server, source } = asked[index];
      if (answer.status === 'fulfilled') {
        plays.push(...answer.value.map((play) => tagPlay(server, play)));
        return;
      }
      failures.push(answer.reason);
      logger.warn(
        `Could not read watch history from ${source.label}; going by the other servers`,
        {
          label: 'Watch History',
          errorMessage:
            answer.reason instanceof Error
              ? answer.reason.message
              : String(answer.reason),
        }
      );
    });
    if (asked.length && failures.length === asked.length) {
      throw failures[0];
    }
    return plays;
  }

  /** The servers this person has an account on. */
  private linked(user: User): ServerWatchSource[] {
    return this.sources.filter(({ source }) => !!source.viewerOf(user));
  }

  /** The servers this title is on. */
  private holding(media: Media): ServerWatchSource[] {
    return this.sources.filter(
      ({ source }) => source.titleIdsOf(media).length > 0
    );
  }

  public async history(user: User, limit: number): Promise<Play[]> {
    const plays = await this.gather(this.linked(user), (source) =>
      source.history(user, limit)
    );
    return plays.sort(newestFirst).slice(0, limit);
  }

  public async titleHistory(media: Media): Promise<Play[]> {
    return this.gather(this.holding(media), (source) =>
      source.titleHistory(media)
    );
  }

  public async playsSince(
    user: User,
    media: Media,
    after: Date
  ): Promise<Play[]> {
    const holding = this.holding(media);
    return this.gather(
      this.linked(user).filter((entry) => holding.includes(entry)),
      (source) => source.playsSince(user, media, after)
    );
  }
}
