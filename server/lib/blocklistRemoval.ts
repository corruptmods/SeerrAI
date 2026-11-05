import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import { removeFromArr } from '@server/lib/arrRemoval';
import { recordMediaDeletion } from '@server/lib/mediaDeletions';
import logger from '@server/logger';

export interface BlocklistRemovalResult {
  /** The servers it was removed from, e.g. "Radarr" or "4K Sonarr". */
  removedFrom: string[];
  /** Servers it could not be removed from, and why. */
  failed: { service: string; message: string }[];
  /** Pending or approved requests now declined. */
  declinedRequests: number;
}

/**
 * Finishes blocklisting a title already requested or downloaded.
 *
 * Removes it from every Radarr or Sonarr holding it, deleting its files and
 * adding an import exclusion so the *arr's own lists can't re-add it, and
 * declines pending or approved requests. The title stays BLOCKLISTED.
 *
 * A failed removal doesn't undo the blocklist; it is reported for manual
 * cleanup.
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

  // Blocklisting already declined these; this catches any approved since.
  result.declinedRequests = await Blocklist.declineOpenRequests(media.id);

  return result;
};

export default removeBlocklistedFromLibrary;
