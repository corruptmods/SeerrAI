import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import type { JellyfinFamilyKind } from '@server/constants/server';
import { MediaServerType, kindOfType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { startJobs } from '@server/job/schedule';
import { cssVersion } from '@server/lib/customCss';
import {
  emailFree,
  mainAccountOn,
  plexAccountMayClaim,
  plexProfileChanges,
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
import oidcRoutes from '@server/routes/oidc';
import passkeyRoutes from '@server/routes/passkey';
import { ApiError } from '@server/types/error';
import { getAppVersion } from '@server/utils/appVersion';
import axios from 'axios';
import { Router } from 'express';
import net from 'net';
import validator from 'validator';
import { z } from 'zod';

const authRoutes = Router();

const passwordLimiter = new SignInLimiter('password');
const jellyfinLimiter = new SignInLimiter('jellyfin');
const resetLimiter = new SignInLimiter('reset');

// Signing in with a passkey, and managing your own.
authRoutes.use('/passkey', passkeyRoutes);

// Signing in, or linking an account, through a single sign-on provider.
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

  // check if email is required in settings and if user has an valid email
  const settings = await getSettings();
  if (
    settings.notifications.agents.email.options.userEmailRequired &&
    !validator.isEmail(user.email, { require_tld: false })
  ) {
    user.warnings.push('userEmailRequired');
    logger.warn(`User ${user.username} has no valid email address`);
  }

  // Plex rejected their token during watchlist sync. Signing in again with
  // Plex is the only fix, so say so where they will see it.
  if (user.plexTokenExpiredAt) {
    user.warnings.push('plexTokenExpired');
  }

  // Only the settings the app reads about the person signed in; their
  // notification credentials stay on the server.
  return res.status(200).json({
    ...user.toJSON(),
    // Their own, which toJSON leaves out for anyone else's eyes.
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
      // The version of their own CSS that pages load, while it is allowed.
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

  // Before setup, signing in with Plex is how Plex is set up.
  if (primaryServer() && !signInAllowed('plex')) {
    return res.status(500).json({ error: 'Plex login is disabled' });
  }
  try {
    // First we need to use this auth token to get the user's email from plex.tv
    const plextv = new PlexTvAPI(body.authToken);
    const account = await plextv.getUser();

    // Next let's see if the user already exists: by Plex account, or else
    // by email, which only finds someone this Plex account may take over
    // (see plexAccountMayClaim).
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

      connectAsPrimary('plex');
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
        // The owner signing in with Plex for the first time, on a server
        // set up with Plex, or with none set up yet. With another server
        // primary, the owner's email says nothing about who holds this Plex
        // account.
        ((primaryServer() ?? 'plex') === 'plex' &&
          account.email === mainUser.email &&
          !mainUser.plexId) ||
        (await mainPlexTv.checkUserAccess(account.id))
      ) {
        if (!user && sameEmail) {
          if (!plexAccountMayClaim(sameEmail)) {
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
          user = sameEmail;
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
            // A fresh token ends any expired sign-in notice.
            plexTokenExpiredAt: null,
            plexId: account.id,
            plexUsername: account.username,
          };
          // Their picture, email and kind of account come from Plex only
          // when Plex is their main account: someone who signs in with
          // Jellyfin or Emby too keeps what they have.
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

    // The owner signing in with Plex before any media server is set up
    // (settings started afresh over an existing database): Plex becomes the
    // primary server and the jobs start, as at a first sign-in.
    if (primaryServer() === undefined && user.id === 1) {
      connectAsPrimary('plex');
      await settings.save();
      startJobs();
    }

    // Set logged in session
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

/** A person's avatar from their account on a Jellyfin or Emby server. */
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

  // At setup, the server being set up. After it, the server asked for
  // (serverType), else the first connected Jellyfin or Emby server people
  // may sign in with.
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

  // Setup aside, only a connected server whose sign-in is on.
  if (!settingUp && (!kind || !signInAllowed(kind))) {
    return res.status(500).json({ error: 'Jellyfin login is disabled' });
  }
  const serverKind = kind ?? 'jellyfin';
  const server = jellyfinFamily(serverKind);
  const name = serverName(serverKind);

  if (!body.username) {
    return res.status(500).json({ error: 'You must provide an username' });
  } else if (server.ip !== '' && body.hostname) {
    return res
      .status(500)
      .json({ error: 'Jellyfin hostname already configured' });
  } else if (server.ip === '' && !body.hostname) {
    return res.status(500).json({ error: 'No hostname provided.' });
  }

  if (!jellyfinLimiter.allow(req, res, body.username)) {
    return;
  }

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

    // Try to find deviceId that corresponds to jellyfin user, else generate a new one
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

    // First we need to attempt to log the user in to jellyfin
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

    // Next let's see if the user already exists
    user = await userRepository.findOne({
      where: { [USER_ID[serverKind]]: account.User.Id },
    });

    const missingAdminUser = !user && !(await userRepository.count());
    if (missingAdminUser || settingUp) {
      // Check if user is admin on jellyfin
      if (account.User.Policy.IsAdministrator === false) {
        throw new ApiError(403, ApiErrorCode.NotAdmin);
      }

      if (
        body.serverType !== MediaServerType.JELLYFIN &&
        body.serverType !== MediaServerType.EMBY
      ) {
        throw new ApiError(500, ApiErrorCode.NoAdminUser);
      }
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

        // User doesn't exist, and there are no users in the database, we'll create the user
        // with admin permissions

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

        // User alread exist but settings.json is not configured, we'll edit the admin user

        user = await userRepository.findOne({
          where: { id: 1 },
        });
        if (!user) {
          throw new Error('Unable to find admin user to edit');
        }
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

      // Create an API key on Jellyfin from this admin user
      const jellyfinClient = new JellyfinAPI(
        hostname,
        account.AccessToken,
        deviceId,
        serverKind
      );
      const apiKey = await jellyfinClient.createApiToken('Seerr');

      server.name = await jellyfinserver.getServerName();
      server.serverId = account.User.ServerId;
      server.ip = body.hostname ?? '';
      server.port = body.port ?? 8096;
      server.urlBase = body.urlBase ?? '';
      server.useSsl = body.useSsl ?? false;
      server.apiKey = apiKey;
      await settings.save();
      startJobs();
    }
    // User already exists, let's update their information
    else if (account.User.Id === user?.[USER_ID[serverKind]]) {
      logger.info(`Found matching ${name} user; updating user with ${name}`, {
        label: 'API',
        ip: req.ip,
        jellyfinUsername: account.User.Name,
      });
      const changes: Partial<User> = {
        [USERNAME[serverKind]]: account.User.Name,
      };
      // Their picture and name come from this server only when it holds
      // their main account; someone who signs in with another server too
      // keeps what they have.
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

      // Their email, or else their name there, is how they sign in with a
      // password: never one another account already has.
      const email = body.email || account.User.Name;
      if (!(await emailFree(email))) {
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
        })
      );
      user.avatar = getUserAvatarUrl(user, serverKind);

      //initialize Jellyfin/Emby users with local login
      const passedExplicitPassword = body.password && body.password.length > 0;
      if (passedExplicitPassword) {
        await user.setPassword(body.password ?? '');
      }
      await userRepository.save(user);
    }

    // Their picture follows this server only when it holds their main
    // account.
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

    // Set logged in session
    if (user) {
      await startSession(req, user.id);
    }
    jellyfinLimiter.clear(req, body.username);

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
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
        jellyfinLimiter.count(req, body.username);
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

  // With Jellyfin sign-in turned off, Quick Connect is only for someone
  // already signed in linking their Jellyfin account.
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

    // The same switch as signing in with a Jellyfin password.
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
        // Their picture follows Jellyfin only when it holds their main
        // account.
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
      } else if (!(await emailFree(account.User.Name))) {
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

      // Set session
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
  if (!passwordLimiter.allow(req, res, body.email)) {
    return;
  }
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

    if (!user || !(await user.passwordMatch(body.password))) {
      passwordLimiter.count(req, body.email);
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

    // The right password, for someone the media server no longer lets in.
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

    // Set logged in session
    await startSession(req, user.id);

    return res.status(200).json(user.filter());
  } catch (e) {
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
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(200).json({ status: 'ok' });
    }

    // Signing out of Seerr also removes the device Seerr signed in to each
    // connected Jellyfin or Emby server as.
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

  if (!resetLimiter.allow(req, res, body.email)) {
    return;
  }
  // Counted whether or not the account exists, so the answer is the same.
  resetLimiter.count(req, body.email);

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
    // Not waited for: how long the mail server takes would tell anyone
    // asking whether the account exists.
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
      guid: req.params.guid,
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
  // Whoever knew the old password is signed out.
  await endSessions(user.id);
  logger.info('Successfully reset password', {
    label: 'API',
    ip: req.ip,
    guid: req.params.guid,
    email: user.email,
  });

  return res.status(200).json({ status: 'ok' });
});

export default authRoutes;
