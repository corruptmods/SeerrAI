import { checkServerCss } from '@server/constants/customCss';
import { getSettings } from '@server/lib/settings';
import { Router } from 'express';

/*
 * Settings → Appearance → Server CSS: styles for everyone, the sign-in
 * page included, and whether people may add their own CSS for their own
 * screens (server/constants/customCss.ts).
 */

const serverCssRoutes = Router();

const current = () => {
  const appearance = getSettings().appearance;
  return {
    css: appearance.serverCss ?? '',
    personalCss: appearance.personalCss === true,
  };
};

serverCssRoutes.get('/', (_req, res) => res.status(200).json(current()));

serverCssRoutes.post('/', async (req, res, next) => {
  const body = req.body as Record<string, unknown>;
  const checked = checkServerCss(body.css);
  if (
    !('css' in checked) ||
    typeof body.personalCss !== 'boolean' ||
    Object.keys(body).some((key) => key !== 'css' && key !== 'personalCss')
  ) {
    return next({
      status: 400,
      message:
        'css (text, at most 64 KB) and personalCss (true or false) are required.',
    });
  }
  const settings = getSettings();
  settings.appearance.serverCss = checked.css;
  settings.appearance.personalCss = body.personalCss;
  await settings.save();
  return res.status(200).json(current());
});

export default serverCssRoutes;
