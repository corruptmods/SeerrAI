import type { Feature } from '@server/constants/features';
import { FEATURES } from '@server/constants/features';
import { hasPermission, Permission } from '@server/lib/permissions';

/** The features to show: all but `hidden`, and music once Lidarr is set up. */
export const shownFeatures = (
  hidden: readonly Feature[],
  musicReady: boolean
): Feature[] =>
  FEATURES.filter(
    (feature) =>
      !hidden.includes(feature) && (feature !== 'music' || musicReady)
  );

/** Left out of Settings → Features: music is under Settings → Music. */
export const NOT_ON_FEATURES_PAGE: readonly Feature[] = ['music'];

/** Left out of Settings → Music, which has only the Music switch. */
export const NOT_ON_MUSIC_PAGE: readonly Feature[] = FEATURES.filter(
  (feature) => feature !== 'music'
);

/** A person's switches left out for tools their permissions don't give them. */
export const unusableFeatures = (permissions: number): Feature[] => {
  const can = (permission: Permission | Permission[]) =>
    hasPermission(permission, permissions, { type: 'or' });
  return [
    ...(can(Permission.MANAGE_REQUESTS) ? [] : ['aiDeletionReview' as const]),
    // Adding to a list requests only for someone who may request.
    ...(can([
      Permission.REQUEST,
      Permission.REQUEST_MOVIE,
      Permission.REQUEST_TV,
    ])
      ? []
      : ['listRequests' as const]),
    ...(can(Permission.MANAGE_ISSUES) ? [] : ['aiIssueTriage' as const]),
    // Siri only reports issues.
    ...(can([Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES])
      ? []
      : ['siri' as const]),
    ...(can(Permission.ADMIN)
      ? []
      : ['aiLogs' as const, 'aiBackfill' as const, 'aiAgent' as const]),
  ];
};
