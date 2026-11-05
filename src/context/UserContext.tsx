import type { User } from '@app/hooks/useUser';
import { useUser } from '@app/hooks/useUser';
import forgetSession from '@app/utils/forgetSession';
import { loginUrl } from '@app/utils/loginRedirect';
import sessionEnded from '@app/utils/sessionEnded';
import { useRouter } from 'next/dist/client/router';
import { useEffect, useRef } from 'react';

interface UserContextProps {
  /** The first page's user; none on sign-in pages. */
  initialUser?: User;
  children?: React.ReactNode;
}

/** Seeds the useUser cache from SSR and redirects to login if the session becomes invalid. */
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
      // The session ended without sign-out (expired or ended elsewhere):
      // clear its data before the next user.
      forgetSession().finally(() => {
        // Full page load so nothing in memory survives to the next user.
        // Signing in returns to this page.
        location.href = loginUrl(
          location.pathname + location.search + location.hash
        );
      });
    }
  }, [router, user, error]);

  return <>{children}</>;
};
