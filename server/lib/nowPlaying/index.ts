import type { JellyfinSession } from '@server/api/jellyfin';
import type { PlexSession } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { MediaType, VIDEO_MEDIA_TYPES } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { MEDIA_ID, USER_ID } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import {
  connectedServers,
  isJellyfinFamily,
  jellyfinClient,
} from '@server/lib/mediaServers';
import { watchSource } from '@server/lib/watchHistory';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * What someone is watching right now, for "Fix this show" from Siri: what
 * each connected server is playing for them, or failing that what they
 * stopped watching in the last half hour (they may have stopped it to
 * report it). Only titles in Seerr's library count, as only those can be
 * reported.
 */

/** How long after a play stops it still counts as what they were watching. */
export const RECENT_MS = 30 * 60 * 1000;
/** The most titles offered when several are playing or were just played. */
const MOST = 3;

export interface NowPlaying {
  media: Media;
  /** The film's name, or the series'. */
  title: string;
  season?: number;
  episode?: number;
  /** Playing now, or stopped in the last half hour. */
  seen: 'now' | 'recent';
  paused: boolean;
  server?: MediaServerKind;
}

/** One session, as each server's comes out, before the library is asked. */
interface Session {
  server: MediaServerKind;
  /** The server's id for the title: the film, or the episode's series. */
  titleId: string;
  movie: boolean;
  title: string;
  season?: number;
  episode?: number;
  paused: boolean;
}

/** Jellyfin writes ids with dashes in some places and not in others. */
const sameId = (a?: string | null, b?: string | null) =>
  !!a &&
  !!b &&
  a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase();

/** The ways one Jellyfin id may be written, to look it up by. */
const spellings = (id: string): string[] => {
  const bare = id.replace(/-/g, '').toLowerCase();
  const dashed = /^[0-9a-f]{32}$/.test(bare)
    ? `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`
    : bare;
  return [...new Set([id, bare, dashed])];
};

const fromPlex = (s: PlexSession): Session | undefined => {
  if (s.type !== 'movie' && s.type !== 'episode') return undefined;
  const movie = s.type === 'movie';
  const titleId = movie ? s.ratingKey : s.grandparentRatingKey;
  if (!titleId) return undefined;
  return {
    server: 'plex',
    titleId: String(titleId),
    movie,
    title: (movie ? s.title : s.grandparentTitle) ?? '',
    season: movie ? undefined : s.parentIndex,
    episode: movie ? undefined : s.index,
    paused: s.Player?.state === 'paused',
  };
};

const fromJellyfin = (
  server: MediaServerKind,
  s: JellyfinSession
): Session | undefined => {
  const item = s.NowPlayingItem;
  if (!item || (item.Type !== 'Movie' && item.Type !== 'Episode')) {
    return undefined;
  }
  const movie = item.Type === 'Movie';
  const titleId = movie ? item.Id : item.SeriesId;
  if (!titleId) return undefined;
  return {
    server,
    titleId,
    movie,
    title: (movie ? item.Name : item.SeriesName) ?? '',
    season: movie ? undefined : item.ParentIndexNumber,
    episode: movie ? undefined : item.IndexNumber,
    paused: !!s.PlayState?.IsPaused,
  };
};

class NowPlayingReader {
  /**
   * What this server is playing for this person. Plex's owner is "1" in
   * its own sessions, not their plex.tv id.
   */
  public async sessionsOn(
    server: MediaServerKind,
    user: User
  ): Promise<Session[]> {
    if (server === 'plex') {
      if (!user.plexId && user.id !== 1) return [];
      const owner = await getRepository(User).findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      if (!owner?.plexToken) return [];
      const sessions = await new PlexAPI({
        plexToken: owner.plexToken,
      }).getSessions();
      return sessions
        .filter((s) => {
          const id = s.User?.id;
          return (
            !!id &&
            ((!!user.plexId && id === String(user.plexId)) ||
              (id === '1' && user.id === 1))
          );
        })
        .flatMap((s) => fromPlex(s) ?? []);
    }
    if (!isJellyfinFamily(server)) return [];
    const viewer = user[USER_ID[server]];
    if (!viewer) return [];
    const client = await jellyfinClient(server);
    const sessions = await client.getSessions();
    return sessions
      .filter((s) => sameId(s.UserId, viewer))
      .flatMap((s) => fromJellyfin(server, s) ?? []);
  }

  /** The library's titles for sessions on one server, by the server's id. */
  private async libraryFor(
    server: MediaServerKind,
    titleIds: string[]
  ): Promise<Media[]> {
    if (!titleIds.length) return [];
    const ids = [...new Set(titleIds.flatMap(spellings))];
    return getRepository(Media).find({
      where: MEDIA_ID[server].map((column) => ({
        mediaType: In(VIDEO_MEDIA_TYPES),
        [column]: In(ids),
      })),
    });
  }

  /** What is playing for them on every connected server. */
  public async now(user: User): Promise<NowPlaying[]> {
    const found: NowPlaying[] = [];
    for (const server of connectedServers()) {
      let sessions: Session[];
      try {
        sessions = await this.sessionsOn(server, user);
      } catch (e) {
        // One server down doesn't hide what another is playing.
        logger.debug('Could not read what is playing', {
          label: 'Now Playing',
          server,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      const media = await this.libraryFor(
        server,
        sessions.map((s) => s.titleId)
      );
      for (const s of sessions) {
        const match = media.find((m) =>
          MEDIA_ID[server].some((column) => sameId(m[column], s.titleId))
        );
        if (!match) continue;
        if (s.movie !== (match.mediaType === MediaType.MOVIE)) continue;
        found.push({
          media: match,
          title: s.title,
          season: s.season,
          episode: s.episode,
          seen: 'now',
          paused: s.paused,
          server,
        });
      }
    }
    return found;
  }

  /** What they stopped watching in the last half hour, newest first. */
  public async recent(user: User): Promise<NowPlaying[]> {
    const source = watchSource();
    if (!source) return [];
    const since = Date.now() - RECENT_MS;
    const plays = (await source.history(user, 10)).filter(
      (p) => p.at * 1000 >= since
    );
    if (!plays.length) return [];
    const media = await source.mediaFor(plays.map((p) => p.titleId));
    const found: NowPlaying[] = [];
    for (const play of plays) {
      const match = media.get(play.titleId);
      if (!match) continue;
      found.push({
        media: match,
        title: play.title,
        season: play.season,
        episode: play.episode,
        seen: 'recent',
        paused: false,
      });
    }
    return found;
  }

  /**
   * What they are watching: playing before paused, then what they stopped
   * in the last half hour when nothing is playing. One entry per title, up
   * to three. `kind` keeps to films or series ("Fix this movie"), unless
   * nothing of that kind is there.
   */
  public async playingFor(
    user: User,
    kind?: MediaType.MOVIE | MediaType.TV
  ): Promise<NowPlaying[]> {
    let found = await this.now(user);
    if (!found.length) {
      found = await this.recent(user).catch((e) => {
        logger.debug('Could not read recent watch history', {
          label: 'Now Playing',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        return [];
      });
    }
    const ofKind = kind
      ? found.filter((f) => f.media.mediaType === kind)
      : found;
    const chosen = ofKind.length ? ofKind : found;
    const sorted = [...chosen].sort(
      (a, b) => Number(a.paused) - Number(b.paused)
    );
    const seen = new Set<number>();
    return sorted
      .filter((f) => {
        if (seen.has(f.media.id)) return false;
        seen.add(f.media.id);
        return true;
      })
      .slice(0, MOST);
  }
}

const nowPlaying = new NowPlayingReader();
export default nowPlaying;
