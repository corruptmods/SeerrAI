import { Permission, useUser } from '@app/hooks/useUser';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import useSWR from 'swr';

// The badge methods aren't in the DOM typings.
type BadgeNavigator = {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

const badges = (): BadgeNavigator | undefined =>
  typeof navigator !== 'undefined' && 'setAppBadge' in navigator
    ? (navigator as unknown as BadgeNavigator)
    : undefined;

/**
 * The installed app's badge: requests waiting for an admin. Shares the
 * sidebar's request count, so both come from one request and update together.
 */
const AppBadge = () => {
  const router = useRouter();
  const { hasPermission } = useUser();
  const shown =
    hasPermission(Permission.ADMIN) &&
    !router.pathname.match(/(login|setup|resetpassword)/);
  const { data } = useSWR<{ pending: number }>(
    shown && badges() ? '/api/v1/request/count' : null
  );
  const pending = shown ? data?.pending : 0;

  useEffect(() => {
    const badge = badges();
    if (!badge || pending === undefined) {
      return;
    }
    // Badge failures are ignored rather than surfacing as unhandled errors.
    (pending > 0
      ? badge.setAppBadge?.(pending)
      : badge.clearAppBadge?.()
    )?.catch(() => undefined);
  }, [pending]);

  return null;
};

export default AppBadge;
