import type { TautulliHistoryRecord } from '@server/api/tautulli';
import TautulliAPI from '@server/api/tautulli';
import { MediaType, VIDEO_MEDIA_TYPES } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import type { TautulliSettings } from '@server/lib/settings';
import type { Play, WatchSource } from '@server/lib/watchHistory/types';
import { In } from 'typeorm';

/** A Tautulli history record as a play. */
export const playOf = (record: TautulliHistoryRecord): Play => {
  const movie = record.media_type === 'movie';
  return {
    at: record.date,
    kind: movie ? 'movie' : 'episode',
    itemId: String(record.rating_key),
    titleId: String(movie ? record.rating_key : record.grandparent_rating_key),
    title: movie ? record.title : record.grandparent_title,
    year: record.year || undefined,
    season: movie ? undefined : Number(record.parent_media_index),
    episode: movie ? undefined : Number(record.media_index),
    finished: record.watched_status >= 1,
    percent: Number(record.percent_complete) || 0,
    viewerId: String(record.user_id),
    viewerName: record.friendly_name,
  };
};

/** Plex, through Tautulli, which keeps every play. */
export class TautulliWatchSource implements WatchSource {
  public readonly kind = 'tautulli' as const;
  public readonly label = 'Tautulli';
  private api: TautulliAPI;

  constructor(settings: TautulliSettings) {
    this.api = new TautulliAPI(settings);
  }

  public viewerOf(user: User): string | undefined {
    return user.plexId ? String(user.plexId) : undefined;
  }

  public titleIdsOf(media: Media): string[] {
    return [media.ratingKey, media.ratingKey4k].filter(
      (key): key is string => !!key
    );
  }

  public async mediaFor(titleIds: string[]): Promise<Map<string, Media>> {
    const found = new Map<string, Media>();
    if (!titleIds.length) return found;
    const media = await getRepository(Media).find({
      where: [
        { mediaType: In(VIDEO_MEDIA_TYPES), ratingKey: In(titleIds) },
        { mediaType: In(VIDEO_MEDIA_TYPES), ratingKey4k: In(titleIds) },
      ],
    });
    for (const item of media) {
      for (const key of this.titleIdsOf(item)) found.set(key, item);
    }
    return found;
  }

  public async usersFor(viewerIds: string[]): Promise<Map<string, User>> {
    const ids = viewerIds.map(Number).filter(Number.isInteger);
    if (!ids.length) return new Map();
    const users = await getRepository(User).find({
      where: { plexId: In(ids) },
    });
    return new Map(users.map((user) => [String(user.plexId), user]));
  }

  public async history(user: User, limit: number): Promise<Play[]> {
    if (!this.viewerOf(user)) return [];
    return (await this.api.getUserHistory(user, limit)).map(playOf);
  }

  public async titleHistory(media: Media): Promise<Play[]> {
    const isShow = media.mediaType === MediaType.TV;
    const records = await Promise.all(
      this.titleIdsOf(media).map((key) => this.api.getTitleHistory(key, isShow))
    );
    return records.flat().map(playOf);
  }

  public async playsSince(
    user: User,
    media: Media,
    after: Date
  ): Promise<Play[]> {
    if (!this.viewerOf(user)) return [];
    const isShow = media.mediaType === MediaType.TV;
    const records = await Promise.all(
      this.titleIdsOf(media).map((key) =>
        this.api.getUserPlaysSince(user, {
          ...(isShow ? { grandparentRatingKey: key } : { ratingKey: key }),
          after,
          strict: true,
        })
      )
    );
    return records.flat().map(playOf);
  }
}
