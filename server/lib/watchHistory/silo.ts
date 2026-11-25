import { VIDEO_MEDIA_TYPES } from '@server/constants/media';
import { MEDIA_ID } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import SiloPlay from '@server/entity/SiloPlay';
import { User } from '@server/entity/User';
import { freshSiloHistory } from '@server/lib/siloHistory';
import type { Play, WatchSource } from '@server/lib/watchHistory/types';
import type { FindOptionsWhere } from 'typeorm';
import { In, IsNull, MoreThan, Not } from 'typeorm';

/*
 * Silo's watch history, from Seerr AI's copy of it (silo_play, see
 * lib/siloHistory), brought up to date before each read. A Seerr AI user is
 * a Silo account; with a profile chosen, only that household profile's plays
 * are theirs. Every play is kept, each with its own date.
 *
 * Silo's history has only real plays: something marked watched by hand, or
 * imported into Silo from another server or a watch service, isn't in it.
 */

/** A viewer: the account, and the profile when the play names one. */
const viewerIdOf = (userId: string, profileId?: string | null): string =>
  profileId ? `${userId}/${profileId}` : userId;

const playOf = (row: SiloPlay): Play => ({
  at: Math.floor(new Date(row.endedAt).getTime() / 1000),
  kind: row.kind === 'movie' ? 'movie' : 'episode',
  itemId: row.itemId,
  titleId: row.titleId ?? '',
  title: row.title,
  season: row.kind === 'movie' ? undefined : (row.season ?? undefined),
  episode: row.kind === 'movie' ? undefined : (row.episode ?? undefined),
  finished: row.completed,
  percent: row.percent,
  viewerId: viewerIdOf(row.userId, row.profileId),
  viewerName: row.viewerName,
});

/** Plays that can be attributed to a title. */
const placed: FindOptionsWhere<SiloPlay> = {
  titleId: Not(IsNull()),
  kind: In(['movie', 'episode']),
};

export class SiloWatchSource implements WatchSource {
  public readonly kind = 'silo' as const;
  public readonly label = 'Silo';

  public viewerOf(user: User): string | undefined {
    if (!user.siloUserId) return undefined;
    return viewerIdOf(user.siloUserId, user.siloProfileId);
  }

  /** Deduped: regular and 4K can be the same item. */
  public titleIdsOf(media: Media): string[] {
    return [
      ...new Set(
        MEDIA_ID.silo
          .map((column) => media[column])
          .filter((id): id is string => !!id)
      ),
    ];
  }

  public async mediaFor(titleIds: string[]): Promise<Map<string, Media>> {
    const found = new Map<string, Media>();
    if (!titleIds.length) return found;
    const media = await getRepository(Media).find({
      where: MEDIA_ID.silo.map((column) => ({
        mediaType: In(VIDEO_MEDIA_TYPES),
        [column]: In(titleIds),
      })),
    });
    for (const item of media) {
      for (const id of this.titleIdsOf(item)) found.set(id, item);
    }
    return found;
  }

  /**
   * A profile's plays belong to whoever chose that profile, else to whoever
   * linked the whole account; an account's plays without a profile, to the
   * latter.
   */
  public async usersFor(viewerIds: string[]): Promise<Map<string, User>> {
    const found = new Map<string, User>();
    if (!viewerIds.length) return found;
    const accounts = [...new Set(viewerIds.map((id) => id.split('/')[0]))];
    const users = await getRepository(User).find({
      where: { siloUserId: In(accounts) },
    });
    for (const id of viewerIds) {
      const [account, profile] = id.split('/');
      const onAccount = users.filter((user) => user.siloUserId === account);
      const user =
        (profile
          ? onAccount.find((candidate) => candidate.siloProfileId === profile)
          : undefined) ??
        onAccount.find((candidate) => !candidate.siloProfileId);
      if (user) found.set(id, user);
    }
    return found;
  }

  /** Whose plays are this user's: their account, and profile if chosen. */
  private whose(user: User): FindOptionsWhere<SiloPlay> | undefined {
    if (!user.siloUserId) return undefined;
    return {
      userId: user.siloUserId,
      ...(user.siloProfileId ? { profileId: user.siloProfileId } : {}),
    };
  }

  public async history(user: User, limit: number): Promise<Play[]> {
    const whose = this.whose(user);
    if (!whose) return [];
    await freshSiloHistory();
    const rows = await getRepository(SiloPlay).find({
      where: { ...placed, ...whose },
      order: { endedAt: 'DESC', id: 'DESC' },
      take: limit,
    });
    return rows.map(playOf);
  }

  public async titleHistory(media: Media): Promise<Play[]> {
    const ids = this.titleIdsOf(media);
    if (!ids.length) return [];
    await freshSiloHistory();
    const rows = await getRepository(SiloPlay).find({
      where: { ...placed, titleId: In(ids) },
      order: { endedAt: 'DESC', id: 'DESC' },
    });
    return rows.map(playOf);
  }

  public async playsSince(
    user: User,
    media: Media,
    after: Date
  ): Promise<Play[]> {
    const whose = this.whose(user);
    const ids = this.titleIdsOf(media);
    if (!whose || !ids.length) return [];
    await freshSiloHistory();
    const rows = await getRepository(SiloPlay).find({
      where: {
        ...placed,
        ...whose,
        titleId: In(ids),
        endedAt: MoreThan(after),
      },
      order: { endedAt: 'DESC', id: 'DESC' },
    });
    return rows.map(playOf);
  }
}
