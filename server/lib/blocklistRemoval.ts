import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { removeFromArr } from '@server/lib/arrRemoval';
import { recordMediaDeletion } from '@server/lib/mediaDeletions';
import logger from '@server/logger';
import { In } from 'typeorm';

export interface BlocklistRemovalResult {
  /** The servers it was removed from, e.g. "Radarr" or "4K Sonarr". */
  removedFrom: string[];
  /** Servers it could not be removed from, and why. */
  failed: { service: string; message: string }[];
  /** Requests that were still pending or approved, now declined. */
  declinedRequests: number;
}

/**
 * Finishes blocklisting a title that was already requested or downloaded.
 *
 * Removes it from every Radarr or Sonarr that holds it, deleting its files and
 * adding an import exclusion so the *arr's own lists cannot bring it back.
 * Any request still pending or approved is declined, since it can no longer
 * be fulfilled. The title stays BLOCKLISTED throughout.
 *
 * A removal that fails does not undo the blocklist: the title is still
 * blocked from being requested, and the failure is reported so it can be
 * cleaned up by hand.
 */
export const removeBlocklistedFromLibrary = async (
  tmdbId: number,
  mediaType: MediaType
): Promise<BlocklistRemovalResult> => {
  const result: BlocklistRemovalResult = {
    removedFrom: [],
    failed: [],
    declinedRequests: 0,
  };

  const mediaRepository = getRepository(Media);
  const media = await mediaRepository.findOne({
    where: { tmdbId, mediaType },
    relations: { seasons: true },
  });

  if (!media) {
    return result;
  }

  const arr = mediaType === MediaType.MOVIE ? 'Radarr' : 'Sonarr';

  for (const is4k of [false, true]) {
    const held = is4k
      ? media.serviceId4k != null || media.externalServiceId4k != null
      : media.serviceId != null || media.externalServiceId != null;

    if (!held) {
      continue;
    }

    const service = `${is4k ? '4K ' : ''}${arr}`;

    try {
      await removeFromArr(media, is4k, { addImportExclusion: true });

      media.resetServiceData(is4k);

      for (const season of media.seasons ?? []) {
        season[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
      }

      result.removedFrom.push(service);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      logger.warn('Blocklisted title could not be removed from the *arr', {
        label: 'Blocklist',
        tmdbId,
        service,
        errorMessage: message,
      });

      result.failed.push({ service, message });
    }
  }

  if (result.removedFrom.length) {
    await mediaRepository.save(media);
    await recordMediaDeletion(tmdbId, mediaType);
  }

  // A plain update, so declining here does not send each requester a
  // "declined" notification for what was an admin clean-up.
  const declined = await getRepository(MediaRequest)
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status: MediaRequestStatus.DECLINED })
    .where({
      media: { id: media.id },
      status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
    })
    .execute();

  result.declinedRequests = declined.affected ?? 0;

  return result;
};

export default removeBlocklistedFromLibrary;
