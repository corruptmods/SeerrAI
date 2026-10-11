import { UserType } from '@server/constants/user';
import type { PermissionCheckOptions } from '@server/lib/permissions';
import { hasPermission, Permission } from '@server/lib/permissions';
import type { NotificationAgentKey } from '@server/lib/settings';
import { useRouter } from 'next/router';
import { useCallback } from 'react';
import type { MutatorCallback } from 'swr';
import useSWR from 'swr';

export { Permission, UserType };
export type { PermissionCheckOptions };

export interface User {
  id: number;
  warnings: string[];
  plexUsername?: string | null;
  jellyfinUsername?: string | null;
  username?: string;
  displayName: string;
  email: string;
  avatar: string;
  permissions: number;
  userType: number;
  createdAt: Date;
  updatedAt: Date;
  requestCount: number;
  settings?: UserSettings;
}

type NotificationAgentTypes = Record<NotificationAgentKey, number>;

export interface UserSettings {
  discoverRegion?: string;
  streamingRegion?: string;
  originalLanguage?: string;
  locale?: string;
  notificationTypes: Partial<NotificationAgentTypes>;
  watchlistSyncMovies?: boolean;
  watchlistSyncTv?: boolean;
  /** Optional features this person turned off for themselves. */
  disabledFeatures?: string[];
  /** Home page rows (slider ids) this person hid for themselves. */
  hiddenSliders?: number[];
}

interface UserHookResponse {
  user?: User;
  loading: boolean;
  error: string;
  revalidate: (
    data?: User | Promise<User> | MutatorCallback<User> | undefined,
    shouldRevalidate?: boolean | undefined
  ) => Promise<User | undefined>;
  hasPermission: (
    permission: Permission | Permission[],
    options?: PermissionCheckOptions
  ) => boolean;
}

export const useUser = ({
  id,
  initialData,
  primary = false,
}: {
  id?: number;
  initialData?: User;
  /**
   * The one instance that keeps the signed-in user fresh: UserContext, which
   * is always mounted. Every other component reads the same cached copy.
   */
  primary?: boolean;
} = {}): UserHookResponse => {
  const router = useRouter();
  const isAuthPage = /^\/(login|setup|resetpassword(?:\/|$))/.test(
    router.pathname
  );

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<User>(id ? `/api/v1/user/${id}` : `/api/v1/auth/me`, {
    fallbackData: initialData,
    // Dozens of components ask who is signed in, a title card among them.
    // Each polling and re-checking on mount was a stream of /auth/me calls
    // that grew with the page; one instance now does that for all of them.
    // Anyone else still fetches if nothing is cached yet.
    ...(id || primary
      ? {
          refreshInterval: !isAuthPage ? 30000 : 0,
          revalidateOnFocus: !isAuthPage,
          revalidateOnMount: !isAuthPage,
          revalidateOnReconnect: !isAuthPage,
        }
      : {
          // Not on the sign-in pages, where there is no one to fetch yet.
          revalidateOnMount: isAuthPage ? false : undefined,
          revalidateIfStale: false,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }),
    errorRetryInterval: 30000,
    shouldRetryOnError: false,
  });

  // The same function until the permissions change, so effects that list it
  // as a dependency do not re-run on every render.
  const permissions = data?.permissions ?? 0;
  const checkPermission = useCallback(
    (
      permission: Permission | Permission[],
      options?: PermissionCheckOptions
    ): boolean => hasPermission(permission, permissions, options),
    [permissions]
  );

  return {
    user: data,
    loading: !data && !error,
    error,
    hasPermission: checkPermission,
    revalidate,
  };
};
