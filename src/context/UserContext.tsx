import type { User } from '@app/hooks/useUser';
import { useUser } from '@app/hooks/useUser';
import forgetSession from '@app/utils/forgetSession';
import sessionEnded from '@app/utils/sessionEnded';
import { useRouter } from 'next/dist/client/router';
import { useEffect, useRef } from 'react';

interface UserContextProps {
  initialUser: User;
  children?: React.ReactNode;
}

/**
 * This UserContext serves the purpose of just preparing the useUser hooks
 * cache on server side render. It also will handle redirecting the user to
 * the login page if their session ever becomes invalid.
 */
export const UserContext = ({ initialUser, children }: UserContextProps) => {
  const { user, error, revalidate } = useUser({
    initialData: initialUser,
    primary: true,
  });
  const router = useRouter();
  const routing = useRef(false);

  useEffect(() => {
    revalidate();
  }, [router.pathname, revalidate]);

  useEffect(() => {
    if (
      !router.pathname.match(/(setup|login|resetpassword)/) &&
      sessionEnded(user, error) &&
      !routing.current
    ) {
      routing.current = true;
      // The session ended without anyone signing out (it expired, or was
      // ended elsewhere): clear what it left here before the next person.
      forgetSession().finally(() => {
        // A full page load on purpose: nothing held in memory for the last
        // person (cached rows, their settings) survives into the next.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        location.href = '/login';
      });
    }
  }, [router, user, error]);

  return <>{children}</>;
};
