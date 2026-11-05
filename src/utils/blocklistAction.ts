import { MediaStatus } from '@server/constants/media';

/**
 * Requested or downloaded states, where blocklisting also removes the title
 * from Radarr/Sonarr and deletes its files.
 */
const HELD_STATUSES = [
  MediaStatus.PENDING,
  MediaStatus.PROCESSING,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.AVAILABLE,
];

/**
 * Whether the blocklist button shows on a movie or series page, and whether
 * it deletes files.
 *
 * Blocklist managers see it for unrequested titles (as upstream). For
 * requested or downloaded titles, where it deletes files, only admins do.
 */
export const blocklistAction = (
  status: MediaStatus | undefined,
  {
    canManageBlocklist,
    isAdmin,
  }: { canManageBlocklist: boolean; isAdmin: boolean }
): { show: boolean; removesFiles: boolean } => {
  const removesFiles = status !== undefined && HELD_STATUSES.includes(status);

  return {
    show:
      canManageBlocklist &&
      status !== MediaStatus.BLOCKLISTED &&
      (!removesFiles || isAdmin),
    removesFiles,
  };
};

export default blocklistAction;
