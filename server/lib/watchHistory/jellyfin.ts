import type { JellyfinAccount, JellyfinUserItem } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import { MediaType } from '@server/constants/media';
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

/*
 * Jellyfin and Emby keep what each person has watched themselves, item by
 * item: whether it was played to the end, how far, and when last. There is
 * no log of every play, so a title shows once, at its latest play.
 */

/** Accounts asked about one title at a time. */
const ACCOUNT_CONCURRENCY = 4;
/** More accounts than this are not all asked who watched something. */
const MAX_ACCOUNTS = 100;

/** One person's item as a play; undefined when they never started it. */
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
  // An episode the server has not placed in a series yet (still being
  // scanned, or named oddly) cannot be told apart from any other title.
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
    // The server decides when something counts as played (and says so in
    // Played), so a part-watched item never reads as finished here, even
    // when its percentage runs past the end because the runtime it knows
    // is shorter than the file.
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

/** Jellyfin or Emby, which answer the same way. */
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

  public titleIdsOf(media: Media): string[] {
    return MEDIA_ID[this.kind]
      .map((column) => media[column])
      .filter((id): id is string => !!id);
  }

  public async mediaFor(titleIds: string[]): Promise<Map<string, Media>> {
    const found = new Map<string, Media>();
    if (!titleIds.length) return found;
    const media = await getRepository(Media).find({
      where: MEDIA_ID[this.kind].map((column) => ({
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
    // Finished and part-watched are asked apart: the server's filters
    // both have to match when given together.
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

  /** One account's plays of one title on the server. */
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
    // Emby keeps no date for an item marked watched by hand: with no moment
    // to be after, it counts; after one, it cannot be shown to be.
    return plays
      .flat()
      .filter((play) => cutoff <= 0 || play.at > cutoff)
      .sort(newestFirst);
  }
}
