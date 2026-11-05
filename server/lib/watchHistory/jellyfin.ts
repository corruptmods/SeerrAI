import type { JellyfinAccount, JellyfinUserItem } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import { MediaType, VIDEO_MEDIA_TYPES } from '@server/constants/media';
import type { JellyfinFamilyKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import {
  MEDIA_ID,
  USER_ID,
  hostnameFor,
  serverName,
} from '@server/lib/mediaServers';
import type { Play, WatchSource } from '@server/lib/watchHistory/types';
import { COMPLETE_PERCENT } from '@server/lib/watchHistory/types';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { In } from 'typeorm';

// Jellyfin/Emby keep per-item user data, not a play log: each item appears
// once, at its latest play.

/** Accounts queried in parallel for one title. */
const ACCOUNT_CONCURRENCY = 4;
/** Cap on accounts queried for a title's history. */
const MAX_ACCOUNTS = 100;

/** A user's item as a play; undefined if never started. */
export const playOf = (
  item: JellyfinUserItem,
  viewer: { id: string; name: string }
): Play | undefined => {
  const data = item.UserData ?? {};
  const started =
    !!data.Played ||
    (data.PlaybackPositionTicks ?? 0) > 0 ||
    (data.PlayCount ?? 0) > 0;
  if (!started) return undefined;
  const movie = item.Type === 'Movie';
  if (!movie && item.Type !== 'Episode') return undefined;
  // An episode not yet placed in a series can't be attributed to a title.
  if (!movie && !item.SeriesId) return undefined;
  const at = data.LastPlayedDate ? Date.parse(data.LastPlayedDate) : NaN;
  return {
    at: Number.isFinite(at) ? Math.floor(at / 1000) : 0,
    kind: movie ? 'movie' : 'episode',
    itemId: item.Id,
    titleId: movie ? item.Id : (item.SeriesId ?? ''),
    title: movie ? item.Name : (item.SeriesName ?? item.Name),
    year: movie ? item.ProductionYear : undefined,
    season: movie ? undefined : item.ParentIndexNumber,
    episode: movie ? undefined : item.IndexNumber,
    finished: !!data.Played,
    // Only Played means finished; cap the percentage below COMPLETE_PERCENT,
    // since it can exceed 100 when the known runtime is shorter than the file.
    percent: data.Played
      ? 100
      : Math.min(
          COMPLETE_PERCENT - 1,
          Math.max(0, Math.round(data.PlayedPercentage ?? 0))
        ),
    viewerId: viewer.id,
    viewerName: viewer.name,
  };
};

const newestFirst = (a: Play, b: Play) => b.at - a.at;

/** Jellyfin or Emby (same API). */
export class JellyfinWatchSource implements WatchSource {
  public readonly label: string;
  private api: JellyfinAPI;

  constructor(
    public readonly kind: JellyfinFamilyKind,
    apiKey: string,
    hostname: string = hostnameFor(kind)
  ) {
    this.label = serverName(kind);
    this.api = new JellyfinAPI(hostname, apiKey, undefined, kind);
  }

  public viewerOf(user: User): string | undefined {
    return user[USER_ID[this.kind]] || undefined;
  }

  /** Deduped: regular and 4K can be the same item. */
  public titleIdsOf(media: Media): string[] {
    return [
      ...new Set(
        MEDIA_ID[this.kind]
          .map((column) => media[column])
          .filter((id): id is string => !!id)
      ),
    ];
  }

  public async mediaFor(titleIds: string[]): Promise<Map<string, Media>> {
    const found = new Map<string, Media>();
    if (!titleIds.length) return found;
    const media = await getRepository(Media).find({
      where: MEDIA_ID[this.kind].map((column) => ({
        mediaType: In(VIDEO_MEDIA_TYPES),
        [column]: In(titleIds),
      })),
    });
    for (const item of media) {
      for (const id of this.titleIdsOf(item)) found.set(id, item);
    }
    return found;
  }

  public async usersFor(viewerIds: string[]): Promise<Map<string, User>> {
    if (!viewerIds.length) return new Map();
    const column = USER_ID[this.kind];
    const users = await getRepository(User).find({
      where: { [column]: In(viewerIds) },
    });
    return new Map(users.map((user) => [user[column] as string, user]));
  }

  public async history(user: User, limit: number): Promise<Play[]> {
    const id = this.viewerOf(user);
    if (!id) return [];
    const viewer = { id, name: user.displayName };
    const query = {
      Recursive: true,
      IncludeItemTypes: 'Movie,Episode',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Limit: limit,
    };
    // Separate queries: combined Filters must all match.
    const [finished, started] = await Promise.all([
      this.api.getUserItems(id, { ...query, Filters: 'IsPlayed' }),
      this.api.getUserItems(id, { ...query, Filters: 'IsResumable' }),
    ]);
    const plays = new Map<string, Play>();
    for (const item of [...finished.Items, ...started.Items]) {
      const play = playOf(item, viewer);
      if (play && !plays.has(play.itemId)) plays.set(play.itemId, play);
    }
    return [...plays.values()].sort(newestFirst).slice(0, limit);
  }

  private async playsOf(
    viewer: { id: string; name: string },
    titleId: string,
    isShow: boolean
  ): Promise<Play[]> {
    const { Items } = await this.api.getUserItems(
      viewer.id,
      isShow
        ? {
            ParentId: titleId,
            Recursive: true,
            IncludeItemTypes: 'Episode',
          }
        : { Ids: titleId }
    );
    return Items.map((item) => playOf(item, viewer)).filter(
      (play): play is Play => !!play
    );
  }

  public async titleHistory(media: Media): Promise<Play[]> {
    const ids = this.titleIdsOf(media);
    if (!ids.length) return [];
    const isShow = media.mediaType === MediaType.TV;
    const accounts = (await this.api.getAccounts()).slice(0, MAX_ACCOUNTS);
    const plays = await mapWithConcurrency(
      accounts,
      ACCOUNT_CONCURRENCY,
      async (account: JellyfinAccount) =>
        (
          await Promise.all(
            ids.map((id) =>
              this.playsOf({ id: account.Id, name: account.Name }, id, isShow)
            )
          )
        ).flat()
    );
    return plays.flat().sort(newestFirst);
  }

  public async playsSince(
    user: User,
    media: Media,
    after: Date
  ): Promise<Play[]> {
    const id = this.viewerOf(user);
    if (!id) return [];
    const isShow = media.mediaType === MediaType.TV;
    const viewer = { id, name: user.displayName };
    const cutoff = Math.floor(after.getTime() / 1000);
    const plays = await Promise.all(
      this.titleIdsOf(media).map((titleId) =>
        this.playsOf(viewer, titleId, isShow)
      )
    );
    // Undated plays (Emby, marked by hand) count only with no cutoff.
    return plays
      .flat()
      .filter((play) => cutoff <= 0 || play.at > cutoff)
      .sort(newestFirst);
  }
}
