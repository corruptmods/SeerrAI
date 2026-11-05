import type Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';

/**
 * A title's requests and issues, shaped for the title page viewer. Everyone
 * may see that it was requested and by whom, but not others' emails or Plex
 * ids; issues and their text reach only those allowed to see issues. Decline
 * reasons reach the requester and those who may see all requests.
 */
const mediaForViewer = (
  media: Media | undefined,
  viewer: User | undefined
): Media | undefined => {
  if (!media) {
    return media;
  }

  const seesPersonalDetails = !!viewer?.hasPermission(Permission.MANAGE_USERS);
  // Decline reasons go to the requester, and to others only if they may see
  // all requests anyway.
  const seesAllRequests = !!viewer?.hasPermission(
    [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
    { type: 'or' }
  );
  const seesIssues = !!viewer?.hasPermission(
    [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
    { type: 'or' }
  );

  const person = <T>(user: T): T =>
    user instanceof User ? (user.filter(seesPersonalDetails) as T) : user;

  for (const request of media.requests ?? []) {
    if (
      !seesAllRequests &&
      (!viewer || request.requestedBy?.id !== viewer.id)
    ) {
      delete request.declineReason;
    }
    request.requestedBy = person(request.requestedBy);
    request.modifiedBy = person(request.modifiedBy);
  }

  if (!seesIssues) {
    media.issues = [];
  } else {
    for (const issue of media.issues ?? []) {
      issue.createdBy = person(issue.createdBy);
      issue.modifiedBy = person(issue.modifiedBy);
      for (const comment of issue.comments ?? []) {
        comment.user = person(comment.user);
      }
    }
  }

  return media;
};

export default mediaForViewer;
