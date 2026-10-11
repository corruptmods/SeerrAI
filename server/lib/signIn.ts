import type { Request } from 'express';

/**
 * Signs someone in on a brand-new session. Whatever session the browser
 * brought is thrown away first: a session id that existed before signing in
 * (a passkey sign-in that was started and abandoned, or one planted by
 * someone else) must never become a signed-in one.
 */
export const startSession = (req: Request, userId: number): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!req.session) {
      resolve();
      return;
    }
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }
      req.session.userId = userId;
      req.session.save((saveError) =>
        saveError ? reject(saveError) : resolve()
      );
    });
  });

/** How long a stored session lasts: a month signed in, minutes otherwise. */
export const sessionTtlSeconds = (session: { userId?: number }): number =>
  session.userId ? 60 * 60 * 24 * 30 : 60 * 10;
