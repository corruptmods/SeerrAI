import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';

/*
 * A title a media server has only in libraries the viewer can't open, with
 * "Show people only what their libraries hold" on, is shown as not available
 * to them. Requesting it would bring them nothing they can watch, so it isn't
 * offered.
 */

/** Whether the viewer's libraries leave out this copy of a title. */
export const outsideLibraries = (
  media: Pick<Media, 'outsideLibraries' | 'outsideLibraries4k'> | undefined,
  is4k = false
): boolean => !!(is4k ? media?.outsideLibraries4k : media?.outsideLibraries);

/** Whether a title card offers Request. */
export const cardRequestable = (
  status: MediaStatus | undefined,
  outside = false
): boolean =>
  !outside &&
  (!status || status === MediaStatus.UNKNOWN || status === MediaStatus.DELETED);
