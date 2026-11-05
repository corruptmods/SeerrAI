import { checkPersonalCss } from '@server/constants/customCss';
import { getRepository } from '@server/datasource';
import { UserSettings } from '@server/entity/UserSettings';
import { cssVersion } from '@server/lib/customCss';
import { getSettings } from '@server/lib/settings';
import type { Request, Response } from 'express';
import { Router } from 'express';

/*
 * The custom stylesheets pages load (see server/constants/customCss.ts): the
 * admin's Server CSS for everyone including the sign-in page, and the signed-in
 * person's own CSS while personal CSS is allowed. Pages request them by version
 * (?v=) so browsers cache each until it changes; other URLs are never cached.
 */

const styleRoutes = Router();

const sendCss = (
  req: Request,
  res: Response,
  css: string,
  scope: 'public' | 'private'
) => {
  const version = cssVersion(css);
  res.type('css');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Cache-Control',
    version && req.query.v === version
      ? `${scope}, max-age=31536000, immutable`
      : 'no-store'
  );
  return res.status(200).send(css);
};

styleRoutes.get('/server.css', (req, res) =>
  sendCss(req, res, getSettings().appearance.serverCss ?? '', 'public')
);

styleRoutes.get('/personal.css', async (req, res, next) => {
  if (!req.user || getSettings().appearance.personalCss !== true) {
    return sendCss(req, res, '', 'private');
  }
  try {
    const settings = await getRepository(UserSettings).findOne({
      where: { user: { id: req.user.id } },
    });
    // Rechecked: stored CSS may predate a stricter check.
    const checked = checkPersonalCss(settings?.customCss ?? '');
    return sendCss(req, res, 'css' in checked ? checked.css : '', 'private');
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

export default styleRoutes;
