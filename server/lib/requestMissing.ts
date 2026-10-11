import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import logger from '@server/logger';

export type RequestMissingOutcome =
  /** A request was made. */
  | 'requested'
  /** Already in the library, or on its way. */
  | 'here'
  /** Someone has already asked for it. */
  | 'asked'
  /** Could not be requested: see the message. */
  | 'failed';

export interface RequestMissingResult {
  outcome: RequestMissingOutcome;
  /** Why it could not be requested, in words for the person. */
  message?: string;
}

/** Why a request was refused, said plainly. */
const refusal = (e: unknown): string => {
  if (e instanceof QuotaRestrictedError) {
    return 'Your request limit has been reached.';
  }
  if (e instanceof RequestPermissionError) {
    return 'You are not allowed to request this.';
  }
  if (e instanceof BlocklistedMediaError) {
    return 'This title is blocklisted.';
  }
  if (e instanceof DuplicateMediaRequestError) {
    return 'It has already been requested.';
  }
  if (e instanceof NoSeasonsAvailableError) {
    return 'There are no seasons to request.';
  }
  return 'It could not be requested.';
};

/**
 * Requests a title if nothing has it yet: a series with every season.
 *
 * Goes through MediaRequest.request, so quotas, permissions and
 * auto-approval behave exactly as they do from the request window: asking
 * for many titles at once must not become a way around any of that.
 */
export const requestMissing = async (
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  user: User
): Promise<RequestMissingResult> => {
  const media = await getRepository(Media).findOne({
    where: {
      tmdbId,
      mediaType: mediaType === 'tv' ? MediaType.TV : MediaType.MOVIE,
    },
    relations: { requests: true },
  });

  /*
   * Leave alone anything already here or on its way. Media that was removed
   * from the library counts as missing, not as handled: its old requests are
   * history, so they must not block a new one either.
   */
  const isMissing =
    !media ||
    media.status === MediaStatus.UNKNOWN ||
    media.status === MediaStatus.DELETED;

  if (!isMissing) {
    return { outcome: 'here' };
  }

  const hasLiveRequest = (media?.requests ?? []).some(
    (existing) =>
      !existing.is4k &&
      (existing.status === MediaRequestStatus.PENDING ||
        existing.status === MediaRequestStatus.APPROVED)
  );

  if (hasLiveRequest) {
    return { outcome: 'asked' };
  }

  try {
    if (mediaType === 'tv') {
      const tv = await new TheMovieDb().getTvShow({ tvId: tmdbId });
      const seasons = (tv.seasons ?? [])
        .filter((season) => season.season_number > 0)
        .map((season) => season.season_number);

      if (!seasons.length) {
        return {
          outcome: 'failed',
          message: 'There are no seasons to request.',
        };
      }

      await MediaRequest.request(
        { mediaId: tmdbId, mediaType: MediaType.TV, seasons },
        user
      );
    } else {
      await MediaRequest.request(
        { mediaId: tmdbId, mediaType: MediaType.MOVIE },
        user
      );
    }

    return { outcome: 'requested' };
  } catch (e) {
    logger.debug('Could not request a title', {
      label: 'API',
      tmdbId,
      mediaType,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { outcome: 'failed', message: refusal(e) };
  }
};
