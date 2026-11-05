import { featureEnabled } from '@server/lib/features';
import { musicReady } from '@server/lib/music/access';
import type { NextFunction, Request, Response } from 'express';

// Standard music rejections: 403 when the Music switch is off (globally or for
// the user), 404 before an admin adds a default Lidarr.

export const MUSIC_OFF = { status: 403, message: 'Music is turned off.' };
export const MUSIC_NOT_SET_UP = {
  status: 404,
  message: 'Music is not set up.',
};

/** For music browsing routes. */
export const requireMusic = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (!featureEnabled('music', req.user)) {
    return next(MUSIC_OFF);
  }
  if (!musicReady()) {
    return next(MUSIC_NOT_SET_UP);
  }
  next();
};

/**
 * For music settings (Lidarr, Settings → Music): available while music is on
 * globally, even before a Lidarr is added, since adding one is how it starts.
 * An admin who turned music off for themselves still manages it.
 */
export const requireMusicSettings = (
  _req: Request,
  _res: Response,
  next: NextFunction
) => (featureEnabled('music') ? next() : next(MUSIC_OFF));
