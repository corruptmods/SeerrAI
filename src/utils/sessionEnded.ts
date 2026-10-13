import { isAxiosError } from 'axios';

/**
 * Whether the signed-in person's session is over, from the latest check of
 * who is signed in. Only the server saying so ends it (401 or 403): a check
 * that failed for any other reason (a deploy, a proxy answering 502, a phone
 * between networks) says nothing about the session, and signing someone out
 * for it would throw away what they were doing.
 */
const sessionEnded = (user: unknown, error: unknown): boolean => {
  if (error) {
    const status = isAxiosError(error) ? error.response?.status : undefined;
    return status === 401 || status === 403;
  }

  return !user;
};

export default sessionEnded;
