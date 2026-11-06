import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import type { JellyfinFamilyKind } from '@server/constants/server';
import { MediaServerType, kindOfType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User, noPasswordMatches } from '@server/entity/User';
import { startJobs } from '@server/job/schedule';
import { cssVersion } from '@server/lib/customCss';
import {
  confirmEmail,
  sendEmailConfirmation,
} from '@server/lib/emailConfirmation';
import {
  emailFree,
  mainAccountOn,
  plexAccountMayClaim,
  plexProfileChanges,
  takeEmail,
} from '@server/lib/manageUser';
import {
  DEVICE_ID,
  USERNAME,
  USER_ID,
  USER_TYPE,
  connectAsPrimary,
  connectedServers,
  hostnameFor,
  hostnameOf,
  isConnected,
  isJellyfinFamily,
  jellyfinAccountColumns,
  jellyfinFamily,
  jellyfinFamilyServer,
  primaryServer,
  serverName,
  signInAllowed,
} from '@server/lib/mediaServers';
import { withNewUserDefaults } from '@server/lib/newUserDefaults';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { endSessions, maySignIn, startSession } from '@server/lib/signIn';
import { SignInLimiter } from '@server/lib/signInLimiter';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { checkAvatarChanged } from '@server/routes/avatarproxy';
import oidcRoutes, { clearOidcInProgress } from '@server/routes/oidc';
import passkeyRoutes from '@server/routes/passkey';
import { ApiError } from '@server/types/error';
import { getAppVersion } from '@server/utils/appVersion';
import axios from 'axios';
import { Router } from 'express';
import net from 'net';
import validator from 'validator';
import { z } from 'zod';

const authRoutes = Router();

const passwordLimiter = new SignInLimiter('password', { capAccount: true });
const jellyfinLimiter = new SignInLimiter('jellyfin', { capAccount: true });
const resetLimiter = new SignInLimiter('reset', { capAccount: true });

// Passkey sign-in and management of your own passkeys.
authRoutes.use('/passkey', passkeyRoutes);

// Sign-in and account linking via single sign-on.
authRoutes.use('/oidc', oidcRoutes);

export const quickConnectSecret = z.object({
  secret: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Fa-f0-9]+$/),
});

authRoutes.get('/me', isAuthenticated(), async (req, res) => {
  const userRepository = getRepository(User);
  if (!req.user) {
    return res.status(500).json({
      status: 500,
      error: 'Please sign in.',
    });
  }
  const user = await userRepository.findOneOrFail({
    where: { id: req.user.id },
  });

  const settings = await getSettings();
  if (
    settings.notifications.agents.email.options.userEmailRequired &&
    !validator.isEmail(user.email, { require_tld: false })
  ) {
    user.warnings.push('userEmailRequired');
    logger.warn(`User ${user.username} has no valid email address`);
  }

  // Plex rejected their token during watchlist sync; only signing in with Plex
  // again fixes it, so warn them.
  if (user.plexTokenExpiredAt) {
    user.warnings.push('plexTokenExpired');
  }

  // Only the settings the app reads; notification credentials stay server-side.
  return res.status(200).json({
    ...user.toJSON(),
    // toJSON omits these for anyone but the user.
    email: user.email,
    plexId: user.plexId,
    plexTokenExpiredAt: user.plexTokenExpiredAt,
    settings: user.settings && {
      locale: user.settings.locale,
      discoverRegion: user.settings.discoverRegion,
      streamingRegion: user.settings.streamingRegion,
      originalLanguage: user.settings.originalLanguage,
      notificationTypes: user.settings.notificationTypes,
      watchlistSyncMovies: user.settings.watchlistSyncMovies,
      watchlistSyncTv: user.settings.watchlistSyncTv,
      traktUsername: user.settings.traktUsername ?? null,
      disabledFeatures: user.settings.disabledFeatures,
      hiddenSliders: user.settings.hiddenSliders,
      discoverNetworks: user.settings.discoverNetworks ?? null,
      sidebarOrder: user.settings.sidebarOrder,
      sidebarHidden: user.settings.sidebarHidden,
      appearance: user.settings.appearance ?? null,
      seasonNote: user.settings.seasonNote ?? null,
      // Their personal CSS version, while personal CSS is allowed.
      personalCssVersion: getSettings().appearance.personalCss
        ? cssVersion(user.settings.customCss)
        : null,
    },
  });
});

authRoutes.post('/plex', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as { authToken?: string };

  if (!body.authToken) {
    return next({
      status: 500,
      message: 'Authentication token required.',
    });
  }

  // Before setup, Plex sign-in is how Plex gets set up.
  if (primaryServer() && !signInAllowed('plex')) {
    return res.status(500).json({ error: 'Plex login is disabled' });
  }
  try {
    // Get the user's email from plex.tv.
    const plextv = new PlexTvAPI(body.authToken);
    const account = await plextv.getUser();

    // Find the user by Plex account, else by email (only someone this Plex
    // account may take over; see plexAccountMayClaim).
    let user = await userRepository.findOne({
      where: { plexId: account.id },
    });
    const sameEmail = user
      ? null
      : await userRepository
          .createQueryBuilder('user')
          .where('user.email = :email', {
            email: account.email.toLowerCase(),
          })
          .getOne();

    if (!user && !(await userRepository.count())) {
      // The first account sets Plex up, or, with Plex already primary, must
      // own its server, as a Jellyfin or Emby owner must be its administrator.
      // Another primary server sets up its own owner.
      const primary = primaryServer();
      if (
        (primary && primary !== 'plex') ||
        (primary === 'plex' &&
          settings.plex.machineId &&
          !(await plextv.reachesServer(settings.plex.machineId, {
            ownedOnly: true,
          })))
      ) {
        logger.warn(
          'Plex sign-in refused: no accounts yet and this Plex account does not own the media server',
          {
            label: 'API',
            ip: req.ip,
            plexId: account.id,
            plexUsername: account.username,
          }
        );
        return next({ status: 403, message: 'Access denied.' });
      }
      user = withNewUserDefaults(
        new User({
          email: account.email,
          plexUsername: account.username,
          plexId: account.id,
          plexToken: account.authToken,
          permissions: Permission.ADMIN,
          avatar: account.thumb,
          userType: UserType.PLEX,
        })
      );

      if (!primary) {
        connectAsPrimary('plex');
      }
      await settings.save();
      startJobs();

      await userRepository.save(user);
    } else {
      const mainUser = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true, plexId: true, email: true },
        where: { id: 1 },
      });
      const mainPlexTv = new PlexTvAPI(mainUser.plexToken ?? '');

      if (!account.id) {
        logger.error('Plex ID was missing from Plex.tv response', {
          label: 'API',
          ip: req.ip,
          email: account.email,
          plexUsername: account.username,
        });

        return next({
          status: 500,
          message: 'Something went wrong. Try again.',
        });
      }

      if (
        account.id === mainUser.plexId ||
        // The owner's first Plex sign-in, on a Plex-primary or not-yet-set-up
        // server, from a Plex account with access to the Plex server. With
        // another server primary, the owner's email says nothing about who
        // holds this Plex account.
        ((primaryServer() ?? 'plex') === 'plex' &&
          account.email === mainUser.email &&
          !mainUser.plexId &&
          !!settings.plex.machineId &&
          (await plextv.reachesServer(settings.plex.machineId))) ||
        (await mainPlexTv.checkUserAccess(account.id))
      ) {
        if (!user && sameEmail) {
          if (plexAccountMayClaim(sameEmail)) {
            user = sameEmail;
          } else if (sameEmail.emailVerified) {
            logger.warn(
              'Plex sign-in refused: the email belongs to an account that is not this Plex account',
              {
                label: 'API',
                ip: req.ip,
                userId: sameEmail.id,
                plexId: account.id,
                plexUsername: account.username,
              }
            );
            return next({
              status: 403,
              message: ApiErrorCode.ExistingAccount,
            });
          }
        }

        if (user) {
          if (!user.plexId) {
            logger.info(
              'Found matching Plex user; updating user with Plex data',
              {
                label: 'API',
                ip: req.ip,
                email: user.email,
                userId: user.id,
                plexId: account.id,
                plexUsername: account.username,
              }
            );
          }

          const changes: Partial<User> = {
            plexToken: body.authToken,
            // A fresh token clears the expired sign-in notice.
            plexTokenExpiredAt: null,
            plexId: account.id,
            plexUsername: account.username,
          };
          // Avatar, email and account type come from Plex only when Plex is
          // their main account.
          if (mainAccountOn(user, 'plex')) {
            changes.userType = UserType.PLEX;
          }
          Object.assign(changes, await plexProfileChanges(user, account));
          await userRepository.update(user.id, changes);
          user = await userRepository.findOneOrFail({
            where: { id: user.id },
          });
        } else if (!settings.main.newPlexLogin) {
          logger.warn(
            'Failed sign-in attempt by unimported Plex user with access to the media server',
            {
              label: 'API',
              ip: req.ip,
              email: account.email,
              plexId: account.id,
              plexUsername: account.username,
            }
          );
          return next({
            status: 403,
            message: 'Access denied.',
          });
        } else {
          logger.info(
            'Sign-in attempt from Plex user with access to the media server; creating new Seerr user',
            {
              label: 'API',
              ip: req.ip,
              email: account.email,
              plexId: account.id,
              plexUsername: account.username,
            }
          );
          if (!(await takeEmail(account.email))) {
            return next({
              status: 403,
              message: ApiErrorCode.ExistingAccount,
            });
          }
          user = withNewUserDefaults(
            new User({
              email: account.email,
              plexUsername: account.username,
              plexId: account.id,
              plexToken: account.authToken,
              permissions: settings.main.defaultPermissions,
              avatar: account.thumb,
              userType: UserType.PLEX,
            })
          );

          await userRepository.save(user);
        }
      } else {
        logger.warn(
          'Failed sign-in attempt by Plex user without access to the media server',
          {
            label: 'API',
            ip: req.ip,
            email: account.email,
            plexId: account.id,
            plexUsername: account.username,
          }
        );
        return next({
          status: 403,
          message: 'Access denied.',
        });
      }
    }

    // Owner signing in with Plex before any media server is set up (fresh
    // settings over an existing database): Plex becomes primary and jobs start,
    // as at first sign-in.
    if (primaryServer() === undefined && user.id === 1) {
      connectAsPrimary('plex');
      await settings.save();
      startJobs();
    }

    await startSession(req, user.id);

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
    logger.error('Something went wrong authenticating with Plex account', {
      label: 'API',
      errorMessage: e.message,
      ip: req.ip,
    });
    return next({
      status: 500,
      message: 'Unable to authenticate.',
    });
  }
});

/** User's avatar URL on a Jellyfin or Emby server. */
function getUserAvatarUrl(user: User, kind: JellyfinFamilyKind): string {
  return `/avatarproxy/${user[USER_ID[kind]]}?v=${user.avatarVersion}`;
}

authRoutes.post('/jellyfin', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as {
    username?: string;
    password?: string;
    hostname?: string;
    port?: number;
    urlBase?: string;
    useSsl?: boolean;
    email?: string;
    serverType?: number;
  };

  // During setup, the server being set up. Afterwards, serverType if given,
  // else the first connected Jellyfin or Emby server with sign-in on.
  const settingUp = !primaryServer();
  const asked = kindOfType(body.serverType);
  const kind: JellyfinFamilyKind | undefined = settingUp
    ? body.serverType === MediaServerType.EMBY
      ? 'emby'
      : 'jellyfin'
    : body.serverType !== undefined
      ? isJellyfinFamily(asked)
        ? asked
        : undefined
      : (connectedServers().filter(isJellyfinFamily).find(signInAllowed) ??
        jellyfinFamilyServer());

  // Outside setup, only a connected server with sign-in on.
  if (!settingUp && (!kind || !signInAllowed(kind))) {
    return res.status(500).json({ error: 'Jellyfin login is disabled' });
  }
  const serverKind = kind ?? 'jellyfin';
  const server = jellyfinFamily(serverKind);
  const name = serverName(serverKind);

  // Only setup chooses the server's address; afterwards sign-in uses the one in
  // settings.
  if (!body.username) {
    return res.status(500).json({ error: 'You must provide an username' });
  } else if ((!settingUp || server.ip !== '') && body.hostname) {
    return res
      .status(500)
      .json({ error: 'Jellyfin hostname already configured' });
  } else if (server.ip === '' && !body.hostname) {
    return res.status(500).json({ error: 'No hostname provided.' });
  }

  if (!jellyfinLimiter.take(req, res, body.username)) {
    return;
  }
  // Counted until the credentials prove right.
  let counted = true;

  try {
    const hostname =
      server.ip !== ''
        ? hostnameFor(serverKind)
        : hostnameOf({
            useSsl: body.useSsl,
            ip: body.hostname,
            port: body.port,
            urlBase: body.urlBase,
          });

    // Reuse the user's device id, else generate one.
    let user = await userRepository.findOne({
      where: { [USERNAME[serverKind]]: body.username },
      select: { id: true, [DEVICE_ID[serverKind]]: true },
    });

    let deviceId = 'BOT_seerr';
    if (user && user.id === 1) {
      // Admin is always BOT_seerr
      deviceId = 'BOT_seerr';
    } else if (user && user[DEVICE_ID[serverKind]]) {
      deviceId = user[DEVICE_ID[serverKind]] as string;
    } else if (body.username) {
      deviceId = Buffer.from(`BOT_seerr_${body.username}`).toString('base64');
    }

    // Authenticate against the media server.
    const jellyfinserver = new JellyfinAPI(
      hostname ?? '',
      undefined,
      deviceId,
      serverKind
    );

    const ip = req.ip;
    let clientIp;

    if (ip) {
      if (net.isIPv4(ip)) {
        clientIp = ip;
      } else if (net.isIPv6(ip)) {
        clientIp = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
      }
    }

    const account = await jellyfinserver.login(
      body.username,
      body.password,
      clientIp
    );
    if (!account?.User?.Id) {
      throw new ApiError(401, ApiErrorCode.InvalidCredentials);
    }
    jellyfinLimiter.clear(req, body.username);
    counted = false;

    user = await userRepository.findOne({
      where: { [USER_ID[serverKind]]: account.User.Id },
    });

    const missingAdminUser = !user && !(await userRepository.count());
    if (missingAdminUser || settingUp) {
      if (account.User.Policy.IsAdministrator === false) {
        throw new ApiError(403, ApiErrorCode.NotAdmin);
      }

      if (
        body.serverType !== MediaServerType.JELLYFIN &&
        body.serverType !== MediaServerType.EMBY
      ) {
        throw new ApiError(500, ApiErrorCode.NoAdminUser);
      }

      // With no accounts, only the primary server, if any, sets up the owner.
      // With accounts but no primary server (fresh settings), only the
      // owner's own account on this kind of server, or one they lack.
      const owner = missingAdminUser
        ? null
        : await userRepository.findOne({ where: { id: 1 } });
      const ownerAccount = owner?.[USER_ID[serverKind]];
      if (
        (missingAdminUser &&
          primaryServer() &&
          primaryServer() !== serverKind) ||
        (owner &&
          ((ownerAccount && ownerAccount !== account.User.Id) ||
            (user && user.id !== owner.id)))
      ) {
        logger.warn(
          `${name} sign-in refused: this account may not set up the owner`,
          {
            label: 'API',
            ip: req.ip,
            jellyfinUsername: account.User.Name,
          }
        );
        return next({
          status: 403,
          message: ApiErrorCode.ExistingAccount,
        });
      }

      // Everything the media server must answer comes first, so a failure
      // leaves settings as they were.
      const serverName = await jellyfinserver.getServerName();
      const apiKey = await new JellyfinAPI(
        hostname,
        account.AccessToken,
        deviceId,
        serverKind
      ).createApiToken('Seerr');

      connectAsPrimary(serverKind, account.User.Id);

      if (missingAdminUser) {
        logger.info(
          'Sign-in attempt from Jellyfin user with access to the media server; creating initial admin user for Seerr',
          {
            label: 'API',
            ip: req.ip,
            jellyfinUsername: account.User.Name,
          }
        );

        // No users in the database yet: create this one as admin.

        user = withNewUserDefaults(
          new User({
            id: 1,
            email: body.email || account.User.Name,
            ...jellyfinAccountColumns(serverKind, {
              userId: account.User.Id,
              username: account.User.Name,
              deviceId,
              authToken: account.AccessToken,
            }),
            permissions: Permission.ADMIN,
            userType: USER_TYPE[serverKind],
          })
        );
        user.avatar = getUserAvatarUrl(user, serverKind);

        await userRepository.save(user);
      } else {
        logger.info(
          'Sign-in attempt from Jellyfin user with access to the media server; editing admin user for Seerr',
          {
            label: 'API',
            ip: req.ip,
            jellyfinUsername: account.User.Name,
          }
        );

        // User exists but settings.json isn't configured: update the admin
        // user.
        if (!owner) {
          throw new Error('Unable to find admin user to edit');
        }
        user = owner;
        user.email = body.email || account.User.Name;
        Object.assign(
          user,
          jellyfinAccountColumns(serverKind, {
            userId: account.User.Id,
            username: account.User.Name,
            deviceId,
            authToken: account.AccessToken,
          })
        );
        user.permissions = Permission.ADMIN;
        user.avatar = getUserAvatarUrl(user, serverKind);
        user.userType = USER_TYPE[serverKind];

        await userRepository.save(user);
      }

      server.name = serverName;
      server.serverId = account.User.ServerId;
      if (body.hostname) {
        server.ip = body.hostname;
        server.port = body.port ?? 8096;
        server.urlBase = body.urlBase ?? '';
        server.useSsl = body.useSsl ?? false;
      }
      server.apiKey = apiKey;
      await settings.save();
      startJobs();
    }
    // Existing user: update their details.
    else if (account.User.Id === user?.[USER_ID[serverKind]]) {
      logger.info(`Found matching ${name} user; updating user with ${name}`, {
        label: 'API',
        ip: req.ip,
        jellyfinUsername: account.User.Name,
      });
      const changes: Partial<User> = {
        [USERNAME[serverKind]]: account.User.Name,
      };
      // Avatar and name come from this server only when it holds their main
      // account.
      if (mainAccountOn(user, serverKind)) {
        changes.avatar = getUserAvatarUrl(user, serverKind);
        if (user.username === account.User.Name) {
          changes.username = '';
        }
      }
      await userRepository.update(user.id, changes);
      Object.assign(user, changes);
    } else if (!settings.main.newPlexLogin) {
      logger.warn(
        'Failed sign-in attempt by unimported Jellyfin user with access to the media server',
        {
          label: 'API',
          ip: req.ip,
          jellyfinUserId: account.User.Id,
          jellyfinUsername: account.User.Name,
        }
      );
      return next({
        status: 403,
        message: 'Access denied.',
      });
    } else if (!user) {
      logger.info(
        'Sign-in attempt from Jellyfin user with access to the media server; creating new Seerr user',
        {
          label: 'API',
          ip: req.ip,
          jellyfinUsername: account.User.Name,
        }
      );

      // Their email, else their server username, is their password-login name;
      // never one another account already has. The server vouches only for
      // their username.
      const email = body.email || account.User.Name;
      const vouched = email.toLowerCase() === account.User.Name.toLowerCase();
      if (!(await (vouched ? takeEmail(email) : emailFree(email)))) {
        logger.warn(
          `${name} sign-in refused: another account already has this email or name`,
          {
            label: 'API',
            ip: req.ip,
            jellyfinUsername: account.User.Name,
          }
        );
        return next({
          status: 403,
          message: ApiErrorCode.ExistingAccount,
        });
      }

      user = withNewUserDefaults(
        new User({
          email,
          ...jellyfinAccountColumns(serverKind, {
            userId: account.User.Id,
            username: account.User.Name,
            deviceId,
          }),
          permissions: settings.main.defaultPermissions,
          userType: USER_TYPE[serverKind],
          emailVerified: vouched,
        })
      );
      user.avatar = getUserAvatarUrl(user, serverKind);

      // Also enable local login when a password was given.
      const passedExplicitPassword = body.password && body.password.length > 0;
      if (passedExplicitPassword) {
        await user.setPassword(body.password ?? '');
      }
      await userRepository.save(user);
      if (!vouched) {
        void sendEmailConfirmation(user);
      }
    }

    // Avatar follows this server only when it holds their main account.
    if (user && user[USER_ID[serverKind]] && mainAccountOn(user, serverKind)) {
      try {
        const { changed } = await checkAvatarChanged(user, serverKind);

        if (changed) {
          user.avatar = getUserAvatarUrl(user, serverKind);
          await userRepository.update(user.id, { avatar: user.avatar });
          logger.debug('Avatar updated during login', {
            userId: user.id,
            jellyfinUserId: user[USER_ID[serverKind]],
          });
        }
      } catch (error) {
        logger.error('Error handling avatar during login', {
          label: 'Auth',
          errorMessage: error.message,
        });
      }
    }

    if (user) {
      await startSession(req, user.id);
    }

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
    if (counted && e.errorCode !== ApiErrorCode.InvalidCredentials) {
      jellyfinLimiter.refund(req, body.username);
    }
    switch (e.errorCode) {
      case ApiErrorCode.InvalidUrl:
        logger.error(
          `The provided ${name} is invalid or the server is not reachable.`,
          {
            label: 'Auth',
            error: e.errorCode,
            status: e.statusCode,
            hostname: hostnameOf({
              useSsl: body.useSsl,
              ip: body.hostname,
              port: body.port,
              urlBase: body.urlBase,
            }),
          }
        );
        return next({
          status: e.statusCode,
          message: e.errorCode,
        });

      case ApiErrorCode.ConnectionError:
        logger.error(`Unable to reach the ${name} server.`, {
          label: 'Auth',
          error: e.errorCode,
          status: e.statusCode,
          hostname: hostnameOf({
            useSsl: body.useSsl,
            ip: body.hostname,
            port: body.port,
            urlBase: body.urlBase,
          }),
        });
        return next({
          status: e.statusCode,
          message: e.errorCode,
        });

      case ApiErrorCode.InvalidCredentials:
        logger.warn(
          'Failed sign-in attempt from user with incorrect Jellyfin credentials',
          {
            label: 'Auth',
            account: {
              ip: req.ip,
              email: body.username,
              password: '__REDACTED__',
            },
          }
        );
        return next({
          status: e.statusCode,
          message: e.errorCode,
        });

      case ApiErrorCode.NotAdmin:
        logger.warn(
          'Failed sign-in attempt from user without admin permissions',
          {
            label: 'Auth',
            account: {
              ip: req.ip,
              email: body.username,
            },
          }
        );
        return next({
          status: e.statusCode,
          message: e.errorCode,
        });

      case ApiErrorCode.NoAdminUser:
        logger.warn(
          'Failed sign-in attempt from user without admin permissions and no admin user exists',
          {
            label: 'Auth',
            account: {
              ip: req.ip,
              email: body.username,
            },
          }
        );
        return next({
          status: e.statusCode,
          message: e.errorCode,
        });

      default:
        logger.error(e.message, { label: 'Auth' });
        return next({
          status: 500,
          message: 'Something went wrong.',
        });
    }
  }
});

authRoutes.post('/jellyfin/quickconnect/initiate', async (req, res, next) => {
  if (!isConnected('jellyfin')) {
    return next({
      status: 403,
      message: 'Quick Connect is only supported by Jellyfin.',
    });
  }

  // With Jellyfin sign-in off, Quick Connect only links Jellyfin for a
  // signed-in user.
  if (!signInAllowed('jellyfin') && !req.user) {
    return next({
      status: 403,
      message: 'Jellyfin sign-in is disabled.',
    });
  }

  try {
    const jellyfinServer = new JellyfinAPI(
      hostnameFor('jellyfin'),
      undefined,
      undefined,
      'jellyfin'
    );

    const response = await jellyfinServer.initiateQuickConnect();

    return res.status(200).json({
      code: response.Code,
      secret: response.Secret,
    });
  } catch (error) {
    logger.error('Error initiating Jellyfin quick connect', {
      label: 'Auth',
      errorMessage: error.message,
    });
    return next({
      status: 500,
      message: 'Failed to initiate quick connect.',
    });
  }
});

authRoutes.get('/jellyfin/quickconnect/check', async (req, res, next) => {
  if (!isConnected('jellyfin')) {
    return next({
      status: 403,
      message: 'Quick Connect is only supported by Jellyfin.',
    });
  }

  const result = quickConnectSecret.safeParse(req.query);
  if (!result.success) {
    return next({
      status: 400,
      message: 'Invalid secret format',
    });
  }

  const { secret } = result.data;

  try {
    const jellyfinServer = new JellyfinAPI(
      hostnameFor('jellyfin'),
      undefined,
      undefined,
      'jellyfin'
    );

    const response = await jellyfinServer.checkQuickConnect(secret);

    return res.status(200).json({ authenticated: response.Authenticated });
  } catch (e) {
    return next({
      status: e.statusCode || 500,
      message: 'Failed to check Quick Connect status',
    });
  }
});

authRoutes.post(
  '/jellyfin/quickconnect/authenticate',
  async (req, res, next) => {
    const settings = getSettings();
    const userRepository = getRepository(User);
    const result = quickConnectSecret.safeParse(req.body);
    if (!result.success) {
      return next({
        status: 400,
        message: 'Secret required',
      });
    }

    const { secret } = result.data;

    if (!primaryServer() || !(await userRepository.count())) {
      return next({
        status: 403,
        message: 'Quick Connect is not available during initial setup.',
      });
    }

    if (!isConnected('jellyfin')) {
      return next({
        status: 403,
        message: 'Quick Connect is only supported by Jellyfin.',
      });
    }

    // Same switch as Jellyfin password sign-in.
    if (!signInAllowed('jellyfin')) {
      return next({
        status: 403,
        message: 'Jellyfin sign-in is disabled.',
      });
    }

    try {
      const jellyfinServer = new JellyfinAPI(
        hostnameFor('jellyfin'),
        undefined,
        undefined,
        'jellyfin'
      );

      const account = await jellyfinServer.authenticateQuickConnect(secret);
      if (!account?.User?.Id) {
        throw new ApiError(401, ApiErrorCode.InvalidCredentials);
      }

      let user = await userRepository.findOne({
        where: { jellyfinUserId: account.User.Id },
      });

      const deviceId = Buffer.from(
        `BOT_seerr_${account.User.Name ?? ''}`
      ).toString('base64');

      if (user) {
        logger.info('Quick Connect sign-in from existing user', {
          label: 'API',
          ip: req.ip,
          jellyfinUsername: account.User.Name,
          userId: user.id,
        });

        const changes: Partial<User> = {
          jellyfinAuthToken: account.AccessToken,
          jellyfinDeviceId: deviceId,
        };
        // Avatar follows Jellyfin only when it holds their main account.
        if (mainAccountOn(user, 'jellyfin')) {
          changes.avatar = getUserAvatarUrl(user, 'jellyfin');
        }
        await userRepository.update(user.id, changes);
        Object.assign(user, changes);
      } else if (!settings.main.newPlexLogin) {
        logger.warn(
          'Failed Quick Connect sign-in attempt by unimported Jellyfin user',
          {
            label: 'API',
            ip: req.ip,
            jellyfinUserId: account.User.Id,
            jellyfinUsername: account.User.Name,
          }
        );
        return next({
          status: 403,
          message: 'Access denied.',
        });
      } else if (!(await takeEmail(account.User.Name))) {
        logger.warn(
          'Quick Connect sign-in refused: another account already has this name as its email',
          {
            label: 'API',
            ip: req.ip,
            jellyfinUsername: account.User.Name,
          }
        );
        return next({
          status: 403,
          message: ApiErrorCode.ExistingAccount,
        });
      } else {
        logger.info(
          'Quick Connect sign-in from new Jellyfin user; creating new Seerr user',
          {
            label: 'API',
            ip: req.ip,
            jellyfinUsername: account.User.Name,
          }
        );

        user = withNewUserDefaults(
          new User({
            email: account.User.Name,
            jellyfinUsername: account.User.Name,
            jellyfinUserId: account.User.Id,
            jellyfinDeviceId: deviceId,
            permissions: settings.main.defaultPermissions,
            userType: UserType.JELLYFIN,
          })
        );
        user.avatar = getUserAvatarUrl(user, 'jellyfin');
        await userRepository.save(user);
      }

      if (user.jellyfinUserId && mainAccountOn(user, 'jellyfin')) {
        try {
          const { changed } = await checkAvatarChanged(user, 'jellyfin');

          if (changed) {
            user.avatar = getUserAvatarUrl(user, 'jellyfin');
            await userRepository.update(user.id, { avatar: user.avatar });
            logger.debug('Avatar updated during Quick Connect login', {
              userId: user.id,
              jellyfinUserId: user.jellyfinUserId,
            });
          }
        } catch (error) {
          logger.error('Error handling avatar during Quick Connect login', {
            label: 'Auth',
            errorMessage: error.message,
          });
        }
      }

      await startSession(req, user.id);

      return res.status(200).json(user?.filter() ?? {});
    } catch (e) {
      logger.error('Quick Connect authentication failed', {
        label: 'Auth',
        error: e.message,
        ip: req.ip,
      });
      return next({
        status: e.statusCode || 500,
        message: ApiErrorCode.InvalidCredentials,
      });
    }
  }
);

authRoutes.post('/local', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as { email?: string; password?: string };

  if (!settings.main.localLogin) {
    return res.status(500).json({ error: 'Password sign-in is disabled.' });
  } else if (!body.email || !body.password) {
    return res.status(500).json({
      error: 'You must provide both an email address and a password.',
    });
  }
  if (!passwordLimiter.take(req, res, body.email)) {
    return;
  }
  // Counted until the password proves right or wrong.
  let pending = true;
  try {
    const user = await userRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.email',
        'user.password',
        'user.plexId',
        'user.userType',
        'user.jellyfinUserId',
        'user.embyUserId',
      ])
      .where('user.email = :email', { email: body.email.toLowerCase() })
      .getOne();

    const matches = user
      ? await user.passwordMatch(body.password)
      : await noPasswordMatches(body.password);
    pending = false;
    if (!user || !matches) {
      logger.warn('Failed sign-in attempt using invalid Seerr password', {
        label: 'API',
        ip: req.ip,
        email: body.email,
        userId: user?.id,
      });
      return next({
        status: 403,
        message: 'Access denied.',
      });
    }

    passwordLimiter.clear(req, body.email);

    // Right password, but the media server no longer allows this user.
    if (!(await maySignIn(user, 'password'))) {
      logger.warn('Password sign-in by someone no longer allowed to sign in', {
        label: 'API',
        ip: req.ip,
        userId: user.id,
      });
      return next({
        status: 403,
        message: 'Access denied.',
      });
    }

    await startSession(req, user.id);

    return res.status(200).json(user.filter());
  } catch (e) {
    if (pending) {
      passwordLimiter.refund(req, body.email);
    }
    logger.error('Something went wrong authenticating with Seerr password', {
      label: 'API',
      errorMessage: e.message,
      ip: req.ip,
      email: body.email,
    });
    return next({
      status: 500,
      message: 'Unable to authenticate.',
    });
  }
});

authRoutes.post('/logout', async (req, res, next) => {
  try {
    clearOidcInProgress(req, res);
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(200).json({ status: 'ok' });
    }

    // Signing out also removes Seerr's device from each connected Jellyfin or
    // Emby server.
    const kinds = connectedServers().filter(isJellyfinFamily);
    const user = kinds.length
      ? await getRepository(User)
          .createQueryBuilder('user')
          .addSelect(
            kinds.flatMap((kind) => [
              `user.${USER_ID[kind]}`,
              `user.${DEVICE_ID[kind]}`,
            ])
          )
          .where('user.id = :id', { id: userId })
          .getOne()
      : null;

    for (const kind of kinds) {
      const accountId = user?.[USER_ID[kind]];
      const deviceId = user?.[DEVICE_ID[kind]];
      if (!user || !accountId || !deviceId) {
        continue;
      }
      try {
        await axios.delete(`${hostnameFor(kind)}/Devices`, {
          timeout: 5000,
          params: { Id: deviceId },
          headers: {
            Authorization: `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="seerr", Version="${
              kind === 'emby' ? '1.0.0' : getAppVersion()
            }", Token="${jellyfinFamily(kind).apiKey}"`,
          },
        });
      } catch (error) {
        logger.error(`Failed to delete ${serverName(kind)} device`, {
          label: 'Auth',
          error: error instanceof Error ? error.message : 'Unknown error',
          userId: user.id,
          jellyfinUserId: accountId,
        });
      }
    }

    req.session?.destroy((err: Error | null) => {
      if (err) {
        logger.error('Failed to destroy session', {
          label: 'Auth',
          error: err.message,
          userId,
        });
        return next({ status: 500, message: 'Failed to destroy session.' });
      }
      logger.debug('Successfully logged out user', {
        label: 'Auth',
        userId,
      });
      res.status(200).json({ status: 'ok' });
    });
  } catch (error) {
    logger.error('Error during logout process', {
      label: 'Auth',
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.session?.userId,
    });
    next({ status: 500, message: 'Error during logout process.' });
  }
});

authRoutes.post('/reset-password', async (req, res, next) => {
  const userRepository = getRepository(User);
  const body = req.body as { email?: string };

  if (!body.email) {
    return next({
      status: 500,
      message: 'Email address required.',
    });
  }

  // Counted whether or not the account exists, so responses don't reveal it.
  if (!resetLimiter.take(req, res, body.email)) {
    return;
  }

  const user = await userRepository
    .createQueryBuilder('user')
    .where('user.email = :email', { email: body.email.toLowerCase() })
    .getOne();

  if (user) {
    user.newResetPasswordLink();
    await userRepository.update(user.id, {
      resetPasswordGuid: user.resetPasswordGuid,
      recoveryLinkExpirationDate: user.recoveryLinkExpirationDate,
    });
    // Not awaited: mail server latency would reveal whether the account exists.
    void user.sendResetPasswordEmail();
    logger.info('Sending password reset link', {
      label: 'API',
      ip: req.ip,
      email: body.email,
    });
  } else {
    logger.error('Something went wrong sending password reset link', {
      label: 'API',
      ip: req.ip,
      email: body.email,
    });
  }

  return res.status(200).json({ status: 'ok' });
});

authRoutes.post('/reset-password/:guid', async (req, res, next) => {
  const userRepository = getRepository(User);

  if (!req.body.password || req.body.password?.length < 8) {
    logger.warn('Failed password reset attempt using invalid new password', {
      label: 'API',
      ip: req.ip,
    });
    return next({
      status: 500,
      message: 'Password must be at least 8 characters long.',
    });
  }

  const user = await userRepository.findOne({
    where: { resetPasswordGuid: req.params.guid },
  });

  if (!user) {
    logger.warn('Failed password reset attempt using invalid recovery link', {
      label: 'API',
      ip: req.ip,
      guid: req.params.guid,
    });
    return next({
      status: 500,
      message: 'Invalid password reset link.',
    });
  }

  if (
    !user.recoveryLinkExpirationDate ||
    user.recoveryLinkExpirationDate <= new Date()
  ) {
    logger.warn('Failed password reset attempt using expired recovery link', {
      label: 'API',
      ip: req.ip,
      guid: req.params.guid,
      email: user.email,
    });
    return next({
      status: 500,
      message: 'Invalid password reset link.',
    });
  }
  user.recoveryLinkExpirationDate = null;
  await user.setPassword(req.body.password);
  await userRepository.update(user.id, {
    password: user.password,
    recoveryLinkExpirationDate: null,
  });
  // Sign out anyone who knew the old password.
  await endSessions(user.id);
  logger.info('Successfully reset password', {
    label: 'API',
    ip: req.ip,
    guid: req.params.guid,
    email: user.email,
  });

  return res.status(200).json({ status: 'ok' });
});

// The link emailed to confirm an address someone set on their own account.
authRoutes.get<{ token: string }>(
  '/confirm-email/:token',
  async (req, res, next) => {
    if (!(await confirmEmail(req.params.token))) {
      return next({
        status: 400,
        message: 'This confirmation link is invalid or has expired.',
      });
    }
    return res.redirect(
      `${getSettings().main.applicationUrl}/profile/settings`
    );
  }
);

export default authRoutes;
