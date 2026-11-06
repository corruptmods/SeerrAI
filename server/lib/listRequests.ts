import type { User } from '@server/entity/User';
import { featureEnabled } from '@server/lib/features';
import { Permission } from '@server/lib/permissions';
import type { RequestMissingResult } from '@server/lib/requestMissing';
import { requestMissing } from '@server/lib/requestMissing';
import logger from '@server/logger';
import AsyncLock from '@server/utils/asyncLock';

/** One request check per title at a time, so quick adds can't request twice. */
const titleLock = new AsyncLock();

/**
 * Whether adding a title to a list requests it for this person: on unless
 * they or an admin turned it off, and only for what they may request.
 */
export const requestsListAdds = (
  user: User,
  mediaType: 'movie' | 'tv'
): boolean =>
  featureEnabled('listRequests', user) &&
  user.hasPermission(
    [
      Permission.REQUEST,
      mediaType === 'tv' ? Permission.REQUEST_TV : Permission.REQUEST_MOVIE,
    ],
    { type: 'or' }
  );

/**
 * Requests a title someone just added to a list, in their name, the way
 * import's "also request" does: skipped when already here, requested or
 * blocklisted, refused within their quota. Undefined when nothing was tried;
 * never throws, so the add itself always stands.
 */
export const requestListAdd = async (
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  user: User
): Promise<RequestMissingResult | undefined> => {
  if (!requestsListAdds(user, mediaType)) {
    return undefined;
  }
  try {
    return await titleLock.dispatch(`${mediaType}:${tmdbId}`, () =>
      requestMissing(tmdbId, mediaType, user)
    );
  } catch (e) {
    logger.warn('Could not request a title added to a list', {
      label: 'API',
      tmdbId,
      mediaType,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { outcome: 'failed', message: 'It could not be requested.' };
  }
};
