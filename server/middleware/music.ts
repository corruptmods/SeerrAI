import { featureEnabled } from '@server/lib/features';
import { musicReady } from '@server/lib/music/access';
import type { NextFunction, Request, Response } from 'express';

/*
 * The usual refusals for music: off (403) for anyone with the Music switch
 * off, for everyone or for themselves, and not found (404) before an admin
 * has added a default Lidarr.
 */

export const MUSIC_OFF = { status: 403, message: 'Music is turned off.' };
export const MUSIC_NOT_SET_UP = {
  status: 404,
  message: 'Music is not set up.',
};

/** For the routes people browse music with. */
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
 * For music's settings (Lidarr, Metadata → Music): there while music is on
 * for everyone, even before a Lidarr is added, since adding one is how it
 * starts. An admin who turned music off for themselves still manages it.
 */
export const requireMusicSettings = (
  _req: Request,
  _res: Response,
  next: NextFunction
) => (featureEnabled('music') ? next() : next(MUSIC_OFF));
