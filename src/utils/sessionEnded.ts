import { isAxiosError } from 'axios';

/**
 * Whether the session has ended, from the latest user check. Only 401/403
 * count: other failures (a deploy, a proxy 502, a network switch) say nothing
 * about the session, and signing out would lose the user's work.
 */
const sessionEnded = (user: unknown, error: unknown): boolean => {
  if (error) {
    const status = isAxiosError(error) ? error.response?.status : undefined;
    return status === 401 || status === 403;
  }

  return !user;
};

export default sessionEnded;
