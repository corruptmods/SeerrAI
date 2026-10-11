import { MediaStatus } from '@server/constants/media';

/**
 * States in which a title is already requested or downloaded. Blocklisting it
 * then also removes it from Radarr/Sonarr and deletes its files.
 */
const HELD_STATUSES = [
  MediaStatus.PENDING,
  MediaStatus.PROCESSING,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.AVAILABLE,
];

/**
 * Whether the blocklist button shows on a media page, and whether using it
 * deletes files.
 *
 * One rule shared by the movie and series pages. Anyone who can manage the
 * blocklist sees it for titles nobody has asked for, as upstream always
 * allowed. For titles already requested or downloaded — where blocklisting
 * destroys files — only an admin sees it.
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
