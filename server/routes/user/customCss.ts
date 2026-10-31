import { checkPersonalCss } from '@server/constants/customCss';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isOwnProfileOrAdmin } from '@server/utils/profileMiddleware';
import { Router } from 'express';

/*
 * A person's own CSS (Profile → Settings → Appearance), for their own
 * screens only, while an admin lets people add their own. It is checked
 * before it is kept (server/constants/customCss.ts); the reason a style is
 * refused is sent back for the page to explain.
 */

const personalCssRoutes = Router({ mergeParams: true });

const allowed = () => getSettings().appearance.personalCss === true;

personalCssRoutes.get<{ id: string }>(
  '/',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const settings = await getRepository(UserSettings).findOne({
        where: { user: { id: Number(req.params.id) } },
      });
      return res
        .status(200)
        .json({ css: settings?.customCss ?? '', allowed: allowed() });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

personalCssRoutes.post<{ id: string }>(
  '/',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    if (!allowed()) {
      return next({
        status: 403,
        message: 'People can’t add their own CSS on this server.',
      });
    }
    const checked = checkPersonalCss((req.body as { css?: unknown }).css);
    if (!('css' in checked)) {
      return res.status(400).json({
        message: 'This CSS can’t be used.',
        ...checked,
      });
    }
    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }
      // Someone else's screens: the owner's only by the owner, and an
      // admin's only by an admin.
      if (
        user.id !== req.user?.id &&
        (user.id === 1 ||
          (user.hasPermission(Permission.ADMIN) &&
            !req.user?.hasPermission(Permission.ADMIN)))
      ) {
        return next({
          status: 403,
          message: "You do not have permission to modify this user's settings.",
        });
      }
      const customCss = checked.css || null;
      const repository = getRepository(UserSettings);
      if (user.settings) {
        await repository.update(user.settings.id, { customCss });
      } else {
        await repository.save(new UserSettings({ user, customCss }));
      }
      return res.status(200).json({ css: checked.css, allowed: true });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

export default personalCssRoutes;
