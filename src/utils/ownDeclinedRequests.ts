import { MediaRequestStatus } from '@server/constants/media';

/** The request fields this reads. */
export interface RequestLike {
  id: number;
  status: MediaRequestStatus;
  is4k: boolean;
  createdAt: Date | string;
  requestedBy?: { id: number } | null;
  declineReason?: string | null;
}

/**
 * The viewer's declined requests to show on a title page: per quality (4K or
 * not), their latest request if declined with a reason. A newer request hides it.
 */
export const ownDeclinedRequests = (
  requests: RequestLike[] | undefined,
  userId: number | undefined
): { reason: string; is4k: boolean }[] => {
  if (userId === undefined) {
    return [];
  }

  const own = (requests ?? [])
    .filter((request) => request.requestedBy?.id === userId)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        b.id - a.id
    );

  return [false, true].flatMap((is4k) => {
    const latest = own.find((request) => request.is4k === is4k);
    const reason = latest?.declineReason?.trim();

    return latest?.status === MediaRequestStatus.DECLINED && reason
      ? [{ reason, is4k }]
      : [];
  });
};
