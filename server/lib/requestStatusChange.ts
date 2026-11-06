import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import requestLock, { requestKey } from '@server/utils/requestLock';

export type RequestAction = 'approve' | 'decline';

export const REQUEST_ACTIONS: readonly RequestAction[] = ['approve', 'decline'];

/*
 * A blocklisted title must stay out of Radarr and Sonarr, so approving or
 * retrying an older request for it is refused; declining or deleting is still
 * allowed.
 */
export const titleBlocklisted = (request: MediaRequest) =>
  request.media?.status === MediaStatus.BLOCKLISTED ||
  request.media?.status4k === MediaStatus.BLOCKLISTED;

export type StatusChange =
  | { outcome: 'done'; request: MediaRequest }
  | { outcome: 'notFound' }
  | { outcome: 'notPending'; request: MediaRequest }
  | { outcome: 'blocklisted'; request: MediaRequest };

interface ChangeOptions {
  declineReason?: string | null;
  beforeChange?: (request: MediaRequest) => Promise<boolean>;
  /** Undoes what beforeChange did, if the change then couldn't be saved. */
  onSaveFailed?: () => Promise<void>;
}

/**
 * Approves or declines a pending request as `actor`, the way the request list
 * does: one change at a time per request, recorded as theirs (modifiedBy), with
 * the save hooks sending it on and notifying. Every way of approving (the app,
 * push, ntfy and Telegram buttons) goes through here. `beforeChange` runs
 * inside the lock once the request is known to be pending, and can stop the
 * change by returning false (ntfy uses it to spend its one-time token);
 * `onSaveFailed` undoes that if the save then throws.
 */
export function changeRequestStatus(
  requestId: number,
  action: RequestAction,
  actor: User,
  options?: Omit<ChangeOptions, 'beforeChange' | 'onSaveFailed'>
): Promise<StatusChange>;
export function changeRequestStatus(
  requestId: number,
  action: RequestAction,
  actor: User,
  options: ChangeOptions
): Promise<StatusChange | { outcome: 'stopped'; request: MediaRequest }>;
export function changeRequestStatus(
  requestId: number,
  action: RequestAction,
  actor: User,
  options: ChangeOptions = {}
): Promise<StatusChange | { outcome: 'stopped'; request: MediaRequest }> {
  return requestLock.dispatch(requestKey(requestId), async () => {
    const requestRepository = getRepository(MediaRequest);
    const request = await requestRepository.findOne({
      where: { id: requestId },
      relations: { requestedBy: true, modifiedBy: true },
    });

    if (!request) {
      return { outcome: 'notFound' as const };
    }

    if (request.status !== MediaRequestStatus.PENDING) {
      return { outcome: 'notPending' as const, request };
    }

    if (action === 'approve' && titleBlocklisted(request)) {
      return { outcome: 'blocklisted' as const, request };
    }

    if (options.beforeChange && !(await options.beforeChange(request))) {
      return { outcome: 'stopped' as const, request };
    }

    request.status =
      action === 'approve'
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.DECLINED;
    request.modifiedBy = actor;
    // Saved with the status so the declined notification and title history
    // both have it.
    if (action === 'decline') {
      request.declineReason = options.declineReason || null;
    }
    try {
      await requestRepository.save(request);
    } catch (e) {
      await options.onSaveFailed?.().catch(() => undefined);
      throw e;
    }

    return { outcome: 'done' as const, request };
  });
}
