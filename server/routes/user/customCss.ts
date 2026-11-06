import { checkPersonalCss } from '@server/constants/customCss';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isOwnProfileOrAdmin } from '@server/utils/profileMiddleware';
import { Router } from 'express';

/*
 * A user's own CSS (Profile → Settings → Appearance), for their screens only,
 * while an admin allows it. Checked before saving
 * (server/constants/customCss.ts); a refusal's reason is sent back for the
 * page to show.
 */

const personalCssRoutes = Router({ mergeParams: true });

const allowed = () => getSettings().appearance.personalCss === true;

/**
 * For another user: the owner's only by the owner, an admin's only by an
 * admin.
 */
const mayUse = (actor: User | undefined, user: User): boolean =>
  user.id === actor?.id ||
  (user.id !== 1 &&
    (!user.hasPermission(Permission.ADMIN) ||
      !!actor?.hasPermission(Permission.ADMIN)));

personalCssRoutes.get<{ id: string }>(
  '/',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }
      if (!mayUse(req.user, user)) {
        return next({
          status: 403,
          message: "You do not have permission to view this user's settings.",
        });
      }
      return res
        .status(200)
        .json({ css: user.settings?.customCss ?? '', allowed: allowed() });
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
      if (!mayUse(req.user, user)) {
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
