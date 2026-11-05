import type { MediaType } from '@server/constants/media';
import AsyncLock from '@server/utils/asyncLock';

// Keyed on user id or request id. Never dispatch from a subscriber or
// transaction: a waiter would block while holding the save's connection.
const requestLock = new AsyncLock();

// Keyed on media. Always taken inside requestLock, never around it.
export const mediaLock = new AsyncLock();

export const userKey = (userId: number) => `user:${userId}`;
export const requestKey = (requestId: number) => `request:${requestId}`;
/** A title's TMDB id, or the artist's MusicBrainz id for music. */
export const mediaKey = (mediaType: MediaType, mediaId: number | string) =>
  `${mediaType}:${mediaId}`;

export default requestLock;
