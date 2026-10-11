import type Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';

/**
 * A title's own records (its requests and issues), shaped for whoever is
 * looking at the title page. Everyone may see that a title was requested and
 * by whom, but not other people's email addresses or Plex ids; and the issues
 * reported on it, with their text, only reach those allowed to see issues.
 */
const mediaForViewer = (
  media: Media | undefined,
  viewer: User | undefined
): Media | undefined => {
  if (!media) {
    return media;
  }

  const seesPersonalDetails = !!viewer?.hasPermission(Permission.MANAGE_USERS);
  const seesIssues = !!viewer?.hasPermission(
    [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
    { type: 'or' }
  );

  const person = <T>(user: T): T =>
    user instanceof User ? (user.filter(seesPersonalDetails) as T) : user;

  for (const request of media.requests ?? []) {
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
