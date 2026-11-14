import type { Appearance } from '@server/constants/theme';
import { UserType } from '@server/constants/user';
import type { PermissionCheckOptions } from '@server/lib/permissions';
import { hasPermission, Permission } from '@server/lib/permissions';
import type { NotificationAgentKey } from '@server/lib/settings';
import { useRouter } from 'next/router';
import { useCallback } from 'react';
import type { MutatorCallback } from 'swr';
import useSWR, { useSWRConfig } from 'swr';

export { Permission, UserType };
export type { PermissionCheckOptions };

export interface User {
  id: number;
  warnings: string[];
  plexUsername?: string | null;
  jellyfinUsername?: string | null;
  embyUsername?: string | null;
  /** Media servers the user has linked accounts on. */
  linkedServers?: ('plex' | 'jellyfin' | 'emby')[];
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
  /** Optional features the user turned off. */
  disabledFeatures?: string[];
  /** Home page slider ids the user hid. */
  hiddenSliders?: number[];
  /** Custom Networks row as JSON; null for the default. */
  discoverNetworks?: string | null;
  /** Custom sidebar and phone menu order; empty for the default. */
  sidebarOrder?: string[];
  /** Sidebar and phone menu items the user hid. */
  sidebarHidden?: string[];
  /** The user's look; null for the server default. */
  appearance?: Appearance | null;
  /** Answer to a seasonal theme's note, '<season>-<year>:keep|off'. */
  seasonNote?: string | null;
  /** Version of the user's personal CSS; null for none. */
  personalCssVersion?: string | null;
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
  /** The single polling instance (UserContext, always mounted); others read its cache. */
  primary?: boolean;
} = {}): UserHookResponse => {
  const router = useRouter();
  const isAuthPage = /^\/(login|setup|resetpassword(?:\/|$))/.test(
    router.pathname
  );

  // The user the server rendered the first page for, moments ago.
  const fromServer = useSWRConfig().fallback['/api/v1/auth/me'] !== undefined;

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<User>(id ? `/api/v1/user/${id}` : `/api/v1/auth/me`, {
    fallbackData: initialData,
    // Dozens of components read the user; only one instance polls and
    // revalidates, or /auth/me calls grow with the page. Others fetch only
    // when nothing is cached and the server sent no user.
    ...(id || primary
      ? {
          refreshInterval: !isAuthPage ? 30000 : 0,
          revalidateOnFocus: !isAuthPage,
          // Not again straight after the server sent it; polling follows.
          revalidateOnMount: !isAuthPage && !(primary && initialData),
          revalidateOnReconnect: !isAuthPage,
        }
      : {
          // Nobody to fetch on the sign-in pages.
          revalidateOnMount: isAuthPage || fromServer ? false : undefined,
          revalidateIfStale: false,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }),
    errorRetryInterval: 30000,
    shouldRetryOnError: false,
  });

  // Stable until permissions change, so dependent effects don't re-run each render.
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
