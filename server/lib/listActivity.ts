import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import type { MediaList, MediaListItem } from '@server/entity/MediaList';
import { MediaListMember } from '@server/entity/MediaList';
import type { User } from '@server/entity/User';
import { listTitle } from '@server/lib/listTitles';
import notificationManager, { Notification } from '@server/lib/notifications';
import logger from '@server/logger';

export type ListActivity = 'added' | 'removed' | 'watched';

const VERBS: Record<ListActivity, string> = {
  added: 'added',
  removed: 'removed',
  watched: 'marked as watched',
};

/**
 * The actor's name. displayName is populated when a user is loaded from the
 * database; the fallbacks avoid "undefined added ...".
 */
const nameOf = (actor: User): string =>
  actor.displayName || actor.plexUsername || actor.username || 'Someone';

/** Everyone who sees a list, except the actor. */
const recipientsOf = async (list: MediaList, actor: User): Promise<User[]> => {
  const members = await getRepository(MediaListMember).find({
    where: { listId: list.id },
    relations: { user: true },
  });
  const recipients: User[] = [];

  if (list.owner && list.owner.id !== actor.id) {
    recipients.push(list.owner);
  }
  for (const member of members) {
    if (member.user && member.user.id !== actor.id) {
      recipients.push(member.user);
    }
  }

  return recipients;
};

const posterUrl = (path?: string | null) =>
  path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${path}` : undefined;

/**
 * Tells everyone sharing a list that its contents changed. A list with no
 * members is private, so nothing is sent; the actor never hears of their own
 * change.
 */
export const notifyListActivity = async (
  list: MediaList,
  item: Pick<MediaListItem, 'tmdbId' | 'mediaType'>,
  activity: ListActivity,
  actor: User
): Promise<void> => {
  try {
    const recipients = await recipientsOf(list, actor);

    if (!recipients.length) {
      return;
    }

    const tmdb = new TheMovieDb();
    let title = `TMDB ${item.tmdbId}`;
    let image: string | undefined;

    try {
      const found = await listTitle(tmdb, item.tmdbId, item.mediaType);
      title = found.title;
      image = posterUrl(found.posterPath);
    } catch {
      // A title without metadata is still worth announcing.
    }

    for (const recipient of recipients) {
      notificationManager.sendNotification(Notification.LIST_ACTIVITY, {
        event: list.name,
        notifyAdmin: false,
        notifySystem: false,
        notifyUser: recipient,
        subject: list.name,
        message: `${nameOf(actor)} ${VERBS[activity]} ${title}.`,
        image,
      });
    }
  } catch (e) {
    logger.error('Failed to send list activity notification', {
      label: 'Notifications',
      listId: list.id,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
};

/**
 * Tells everyone sharing a list that several titles were added at once (an
 * import or collection), in one notice instead of one each.
 */
export const notifyListAdded = async (
  list: MediaList,
  items: Pick<MediaListItem, 'tmdbId' | 'mediaType' | 'posterPath'>[],
  actor: User
): Promise<void> => {
  if (items.length <= 1) {
    if (items.length) {
      await notifyListActivity(list, items[0], 'added', actor);
    }
    return;
  }

  try {
    const recipients = await recipientsOf(list, actor);
    const what = items.every((item) => item.mediaType === 'movie')
      ? 'films'
      : 'titles';
    const image = posterUrl(items.find((item) => item.posterPath)?.posterPath);

    for (const recipient of recipients) {
      notificationManager.sendNotification(Notification.LIST_ACTIVITY, {
        event: list.name,
        notifyAdmin: false,
        notifySystem: false,
        notifyUser: recipient,
        subject: list.name,
        message: `${nameOf(actor)} added ${items.length} ${what}.`,
        image,
      });
    }
  } catch (e) {
    logger.error('Failed to send list activity notification', {
      label: 'Notifications',
      listId: list.id,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
};

/**
 * Tells users a list was shared with them.
 *
 * Only newly added members are told, so re-saving the sharing dialog doesn't
 * re-notify existing members. Uses the same notification type as other list
 * activity, so users who turned that off aren't notified here either.
 */
export const notifyListShared = async (
  list: MediaList,
  newMembers: User[],
  actor: User
): Promise<void> => {
  const recipients = newMembers.filter((user) => user && user.id !== actor.id);

  if (!recipients.length) {
    return;
  }

  try {
    for (const recipient of recipients) {
      notificationManager.sendNotification(Notification.LIST_ACTIVITY, {
        event: list.name,
        notifyAdmin: false,
        notifySystem: false,
        notifyUser: recipient,
        subject: list.name,
        message: `${nameOf(actor)} shared the list "${list.name}" with you.`,
      });
    }
  } catch (e) {
    logger.error('Failed to send list share notification', {
      label: 'Notifications',
      listId: list.id,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
};

export default notifyListActivity;
