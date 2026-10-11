import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import type { MediaList, MediaListItem } from '@server/entity/MediaList';
import { MediaListMember } from '@server/entity/MediaList';
import type { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import logger from '@server/logger';

export type ListActivity = 'added' | 'removed' | 'watched';

const VERBS: Record<ListActivity, string> = {
  added: 'added',
  removed: 'removed',
  watched: 'marked as watched',
};

/**
 * Tells everyone who shares a list that its contents changed.
 *
 * A list with no members is private to its owner, so nothing is sent. The
 * person who made the change never hears about their own action.
 */
export const notifyListActivity = async (
  list: MediaList,
  item: Pick<MediaListItem, 'tmdbId' | 'mediaType'>,
  activity: ListActivity,
  actor: User
): Promise<void> => {
  try {
    const members = await getRepository(MediaListMember).find({
      where: { listId: list.id },
      relations: { user: true },
    });

    // Everyone with visibility: the owner plus every member, minus whoever
    // performed the action.
    const recipients: User[] = [];

    if (list.owner && list.owner.id !== actor.id) {
      recipients.push(list.owner);
    }

    for (const member of members) {
      if (member.user && member.user.id !== actor.id) {
        recipients.push(member.user);
      }
    }

    if (!recipients.length) {
      return;
    }

    // displayName is populated when a user is loaded from the database; fall
    // back so a notification never reads "undefined added ...".
    const actorName =
      actor.displayName || actor.plexUsername || actor.username || 'Someone';

    const tmdb = new TheMovieDb();
    let title = `TMDB ${item.tmdbId}`;
    let image: string | undefined;

    try {
      if (item.mediaType === 'movie') {
        const movie = await tmdb.getMovie({ movieId: item.tmdbId });
        title = movie.title;
        image = movie.poster_path
          ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${movie.poster_path}`
          : undefined;
      } else {
        const tv = await tmdb.getTvShow({ tvId: item.tmdbId });
        title = tv.name;
        image = tv.poster_path
          ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tv.poster_path}`
          : undefined;
      }
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
        message: `${actorName} ${VERBS[activity]} ${title}.`,
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
 * Tells someone a list has been shared with them.
 *
 * Only newly added members are told — re-saving the sharing dialog should not
 * notify people who were already on the list. Uses the same notification type
 * as other list activity, so a user who has turned that off is not notified
 * here either.
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

  const actorName =
    actor.displayName || actor.plexUsername || actor.username || 'Someone';

  try {
    for (const recipient of recipients) {
      notificationManager.sendNotification(Notification.LIST_ACTIVITY, {
        event: list.name,
        notifyAdmin: false,
        notifySystem: false,
        notifyUser: recipient,
        subject: list.name,
        message: `${actorName} shared the list "${list.name}" with you.`,
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
