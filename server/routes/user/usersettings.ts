import type { JellyfinLoginResponse } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import {
  cleanNavHidden,
  cleanNavOrder,
  isDefaultNavOrder,
} from '@server/constants/navigation';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import { User } from '@server/entity/User';
import UserPasskey from '@server/entity/UserPasskey';
import { UserSettings } from '@server/entity/UserSettings';
import type {
  UserSettingsGeneralResponse,
  UserSettingsNotificationsResponse,
} from '@server/interfaces/api/userSettingsInterfaces';
import {
  DiscoverNetworksError,
  sanitizeDiscoverNetworks,
} from '@server/lib/discoverNetworks';
import { cleanFeatureList } from '@server/lib/features';
import { mayEditUser, mayManageUser } from '@server/lib/manageUser';
import type {
  JellyfinFamilyKind,
  MediaServerKind,
} from '@server/lib/mediaServers';
import {
  USERNAME,
  USER_ID,
  USER_TYPE,
  connectedServers,
  hostnameFor,
  isConnected,
  isJellyfinFamily,
  jellyfinAccountColumns,
  primaryServer,
  serverName,
} from '@server/lib/mediaServers';
import { passkeySummary } from '@server/lib/passkeys';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { endSessions } from '@server/lib/signIn';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { quickConnectSecret } from '@server/routes/auth';
import { ApiError } from '@server/types/error';
import {
  isOwnProfile,
  isOwnProfileOrAdmin,
} from '@server/utils/profileMiddleware';
import type { Request, Response } from 'express';
import { Router } from 'express';
import gravatarUrl from 'gravatar-url';
import net from 'net';
import { Not } from 'typeorm';
import { canMakePermissionsChange } from '.';

/**
 * Trakt usernames: letters, digits, dots, dashes and underscores, and not
 * only dots ("." and ".." would change which Trakt page is read).
 */
const TRAKT_USERNAME = /^(?=.*[\w-])[\w.-]{1,64}$/;

const userSettingsRoutes = Router({ mergeParams: true });

userSettingsRoutes.get<{ id: string }, UserSettingsGeneralResponse>(
  '/main',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const {
      main: { defaultQuotas },
    } = getSettings();
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({
        username: user.username,
        email: user.email,
        locale: user.settings?.locale,
        discoverRegion: user.settings?.discoverRegion,
        streamingRegion: user.settings?.streamingRegion,
        originalLanguage: user.settings?.originalLanguage,
        movieQuotaLimit: user.movieQuotaLimit,
        movieQuotaDays: user.movieQuotaDays,
        tvQuotaLimit: user.tvQuotaLimit,
        tvQuotaDays: user.tvQuotaDays,
        musicQuotaLimit: user.musicQuotaLimit,
        musicQuotaDays: user.musicQuotaDays,
        globalMovieQuotaDays: defaultQuotas.movie.quotaDays,
        globalMovieQuotaLimit: defaultQuotas.movie.quotaLimit,
        globalTvQuotaDays: defaultQuotas.tv.quotaDays,
        globalTvQuotaLimit: defaultQuotas.tv.quotaLimit,
        globalMusicQuotaDays: defaultQuotas.music?.quotaDays,
        globalMusicQuotaLimit: defaultQuotas.music?.quotaLimit,
        watchlistSyncMovies: user.settings?.watchlistSyncMovies,
        watchlistSyncTv: user.settings?.watchlistSyncTv,
        traktUsername: user.settings?.traktUsername ?? null,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  UserSettingsGeneralResponse,
  UserSettingsGeneralResponse
>('/main', isOwnProfileOrAdmin(), async (req, res, next) => {
  const userRepository = getRepository(User);

  try {
    const user = await userRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }

    // Only the owner changes the owner's settings, or another admin's: an
    // admin's email is where their password reset link goes.
    if (!mayEditUser(req.user, user)) {
      return next({
        status: 403,
        message: "You do not have permission to modify this user's settings.",
      });
    }

    const oldEmail = user.email;
    user.username = req.body.username;
    if (user.userType !== UserType.PLEX) {
      user.email =
        req.body.email ||
        user.jellyfinUsername ||
        user.embyUsername ||
        user.email;
    }

    const existingUser = await userRepository.findOne({
      where: { email: user.email, id: Not(user.id) },
    });

    if (oldEmail !== user.email && existingUser) {
      throw new ApiError(400, ApiErrorCode.InvalidEmail);
    }

    // Update quota values only if the user has the correct permissions
    if (
      !user.hasPermission(Permission.MANAGE_USERS) &&
      req.user?.id !== user.id
    ) {
      user.movieQuotaDays = req.body.movieQuotaDays;
      user.movieQuotaLimit = req.body.movieQuotaLimit;
      user.tvQuotaDays = req.body.tvQuotaDays;
      user.tvQuotaLimit = req.body.tvQuotaLimit;
      user.musicQuotaDays = req.body.musicQuotaDays;
      user.musicQuotaLimit = req.body.musicQuotaLimit;
    }

    // A Trakt username as Trakt writes them; blank clears it.
    const traktUsername =
      typeof req.body.traktUsername === 'string'
        ? req.body.traktUsername.trim()
        : undefined;
    if (traktUsername && !TRAKT_USERNAME.test(traktUsername)) {
      return next({
        status: 400,
        message: 'That is not a Trakt username.',
      });
    }

    if (!user.settings) {
      user.settings = new UserSettings({
        user: req.user,
        locale: req.body.locale,
        discoverRegion: req.body.discoverRegion,
        streamingRegion: req.body.streamingRegion,
        originalLanguage: req.body.originalLanguage,
        watchlistSyncMovies: req.body.watchlistSyncMovies,
        watchlistSyncTv: req.body.watchlistSyncTv,
        traktUsername: traktUsername || null,
      });
    } else {
      user.settings.locale = req.body.locale;
      user.settings.discoverRegion = req.body.discoverRegion;
      user.settings.streamingRegion = req.body.streamingRegion;
      user.settings.originalLanguage = req.body.originalLanguage;
      user.settings.watchlistSyncMovies = req.body.watchlistSyncMovies;
      user.settings.watchlistSyncTv = req.body.watchlistSyncTv;
      if (traktUsername !== undefined) {
        user.settings.traktUsername = traktUsername || null;
      }
    }

    const savedUser = await userRepository.save(user);

    return res.status(200).json({
      username: savedUser.username,
      locale: savedUser.settings?.locale,
      discoverRegion: savedUser.settings?.discoverRegion,
      streamingRegion: savedUser.settings?.streamingRegion,
      originalLanguage: savedUser.settings?.originalLanguage,
      watchlistSyncMovies: savedUser.settings?.watchlistSyncMovies,
      watchlistSyncTv: savedUser.settings?.watchlistSyncTv,
      traktUsername: savedUser.settings?.traktUsername ?? null,
      email: savedUser.email,
    });
  } catch (e) {
    if (e.errorCode) {
      return next({
        status: e.statusCode,
        message: e.errorCode,
      });
    }
    return next({ status: 500, message: e.message });
  }
});

userSettingsRoutes.get<{ id: string }, { hasPassword: boolean }>(
  '/password',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
        select: ['id', 'password'],
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({ hasPassword: !!user.password });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  null,
  { currentPassword?: string; newPassword: string }
>('/password', isOwnProfileOrAdmin(), async (req, res, next) => {
  const userRepository = getRepository(User);

  try {
    const user = await userRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    const userWithPassword = await userRepository.findOne({
      select: ['id', 'password'],
      where: { id: Number(req.params.id) },
    });

    if (!user || !userWithPassword) {
      return next({ status: 404, message: 'User not found.' });
    }

    if (req.body.newPassword.length < 8) {
      return next({
        status: 400,
        message: 'Password must be at least 8 characters.',
      });
    }

    if (!mayEditUser(req.user, user)) {
      return next({
        status: 403,
        message: "You do not have permission to modify this user's password.",
      });
    }

    // If the user has the permission to manage users and they are not
    // editing themselves, we will just set the new password
    if (
      req.user?.hasPermission(Permission.MANAGE_USERS) &&
      req.user?.id !== user.id
    ) {
      await user.setPassword(req.body.newPassword);
      await userRepository.update(user.id, { password: user.password });
      // Signed out everywhere: the new password is the only way back in.
      await endSessions(user.id);
      logger.debug('Password overriden by user.', {
        label: 'User Settings',
        userEmail: user.email,
        changingUser: req.user.email,
      });
      return res.status(204).send();
    }

    // If the user has a password, we need to check the currentPassword is
    // correct. Only the copy loaded with the password has it.
    if (
      userWithPassword.password &&
      (!req.body.currentPassword ||
        !(await userWithPassword.passwordMatch(req.body.currentPassword)))
    ) {
      logger.debug(
        'Attempt to change password for user failed. Invalid current password provided.',
        { label: 'User Settings', userEmail: user.email }
      );
      return next({ status: 403, message: 'Current password is invalid.' });
    }

    await user.setPassword(req.body.newPassword);
    await userRepository.update(user.id, { password: user.password });
    // Signed out everywhere else; this session stays.
    await endSessions(user.id, req.sessionID);

    return res.status(204).send();
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

/*
 * Linked accounts: someone's accounts on the connected media servers, one
 * per server. Linking takes proof (signing in there), an account nobody
 * else here has, and one that may use that server. It never changes what
 * kind of account someone has, unless they only had a password.
 */

/** The address Jellyfin and Emby are told a sign-in comes from. */
const clientIpOf = (req: Request): string | undefined => {
  const ip = req.ip;
  if (ip && net.isIPv4(ip)) {
    return ip;
  }
  if (ip && net.isIPv6(ip)) {
    return ip.startsWith('::ffff:') ? ip.substring(7) : ip;
  }
  return undefined;
};

/** The device Seerr signs in to Jellyfin or Emby as, for this person. */
const deviceIdFor = (user: User): string =>
  Buffer.from(
    user.id === 1 ? 'BOT_seerr' : `BOT_seerr_${user.username ?? ''}`
  ).toString('base64');

/**
 * The server POST and DELETE /linked-accounts/jellyfin work with. Before
 * Emby had its own, they also stood for an Emby server, and still do when
 * Emby is the one connected.
 */
const jellyfinRouteKind = (user?: Partial<User>): JellyfinFamilyKind =>
  user?.jellyfinUserId || isConnected('jellyfin') || !isConnected('emby')
    ? 'jellyfin'
    : 'emby';

/** Links a Jellyfin or Emby account someone signed in to. */
const linkJellyfinAccount = async (
  user: User,
  kind: JellyfinFamilyKind,
  account: JellyfinLoginResponse,
  deviceId: string
): Promise<{ status: number; body?: unknown }> => {
  const userRepository = getRepository(User);

  if (
    await userRepository.exist({
      where: { [USER_ID[kind]]: account.User.Id },
    })
  ) {
    return {
      status: 422,
      body: {
        message: 'The specified account is already linked to a Seerr user',
      },
    };
  }

  if (account.User.Policy?.IsDisabled) {
    return {
      status: 403,
      body: {
        code: ApiErrorCode.AccountDisabled,
        message: `This ${serverName(kind)} account is switched off.`,
      },
    };
  }

  await userRepository.update(user.id, {
    ...jellyfinAccountColumns(kind, {
      userId: account.User.Id,
      username: account.User.Name,
      authToken: account.AccessToken,
      deviceId,
    }),
    // Only a password account becomes this server's kind of account.
    ...(user.userType === UserType.LOCAL ? { userType: USER_TYPE[kind] } : {}),
  });

  return { status: 204 };
};

/**
 * Unlinks someone's account on a media server, if they can still sign in
 * afterwards: with a password, or another account on a connected server.
 * The owner keeps their account on the primary server, and their Plex
 * account while Plex is connected: Seerr reaches Plex with it.
 */
const unlinkAccount = async (
  req: Request,
  userId: number,
  kind: MediaServerKind
): Promise<{ status: number; body?: unknown }> => {
  const userRepository = getRepository(User);
  const user = await userRepository
    .createQueryBuilder('user')
    .addSelect('user.password')
    .where({ id: userId })
    .getOne();

  if (!user) {
    return { status: 404, body: { message: 'User not found.' } };
  }

  // Unlinking an admin from someone else's settings is the owner's call.
  if (!mayEditUser(req.user, user)) {
    return {
      status: 403,
      body: {
        message: "You do not have permission to modify this user's settings.",
      },
    };
  }

  if (user.id === 1 && kind === primaryServer()) {
    return {
      status: 400,
      body: {
        message: `The owner's ${serverName(kind)} account cannot be unlinked while ${serverName(kind)} is the primary media server.`,
      },
    };
  }
  if (user.id === 1 && kind === 'plex' && isConnected('plex')) {
    return {
      status: 400,
      body: {
        message:
          "The owner's Plex account cannot be unlinked while Plex is connected: Seerr reaches Plex with it.",
      },
    };
  }

  const others = connectedServers().filter(
    (other) => other !== kind && !!user[USER_ID[other]]
  );
  if (!user.password && others.length === 0) {
    return {
      status: 400,
      body: {
        message:
          'Set a password first, or link another media server account: without either this person could not sign in.',
      },
    };
  }

  const changes: Partial<User> =
    kind === 'plex'
      ? {
          plexId: null,
          plexUsername: null,
          plexToken: null,
          plexTokenExpiredAt: null,
        }
      : jellyfinAccountColumns(kind, {
          userId: null,
          username: null,
          authToken: null,
          deviceId: null,
        });

  // Their kind of account moves to another account they still have,
  // the primary server's first, else they have a password account.
  if (user.userType === USER_TYPE[kind]) {
    const next = others[0];
    changes.userType = next ? USER_TYPE[next] : UserType.LOCAL;
    if (next && isJellyfinFamily(next)) {
      changes.avatar = `/avatarproxy/${user[USER_ID[next]]}`;
    } else if (!next && user.avatar.startsWith('/avatarproxy/')) {
      // The picture came from the account being unlinked.
      changes.avatar = gravatarUrl(user.email || 'none', {
        default: 'mm',
        size: 200,
      });
    }
  }

  await userRepository.update(user.id, changes);
  return { status: 204 };
};

userSettingsRoutes.post<{ id: string }>(
  '/linked-accounts/plex',
  isOwnProfile(),
  async (req, res) => {
    const userRepository = getRepository(User);
    const user = req.user;

    if (!user) {
      return res.status(404).json({ code: ApiErrorCode.Unauthorized });
    }
    if (!isConnected('plex')) {
      return res.status(500).json({ message: 'Plex login is disabled' });
    }

    try {
      // First we need to use this auth token to get the user's email from plex.tv
      const account = await new PlexTvAPI(req.body.authToken).getUser();

      // Do not allow linking of an already linked account
      if (await userRepository.exist({ where: { plexId: account.id } })) {
        return res.status(422).json({
          message: 'This Plex account is already linked to a Seerr user',
        });
      }

      // A Plex or password account links the Plex account with its own
      // email. Someone who signs in with Jellyfin or Emby has that server's
      // name as their email, so theirs cannot be compared.
      if (
        (user.userType === UserType.PLEX || user.userType === UserType.LOCAL) &&
        user.email !== account.email.toLowerCase()
      ) {
        return res.status(422).json({
          message:
            'This Plex account is registered under a different email address.',
        });
      }

      // The owner shares the Plex server with this account.
      const owner = await userRepository.findOneOrFail({
        select: { id: true, plexId: true, plexToken: true },
        where: { id: 1 },
      });
      if (
        account.id !== owner.plexId &&
        !(await new PlexTvAPI(owner.plexToken ?? '').checkUserAccess(
          account.id
        ))
      ) {
        return res.status(403).json({
          message: 'This Plex account does not have access to the Plex server.',
        });
      }

      await userRepository.update(user.id, {
        plexId: account.id,
        plexUsername: account.username,
        plexToken: account.authToken,
        plexTokenExpiredAt: null,
        // Only a password account becomes a Plex account.
        ...(user.userType === UserType.LOCAL
          ? { userType: UserType.PLEX }
          : {}),
      });

      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to link Plex account to user.', {
        label: 'API',
        ip: req.ip,
        errorMessage: e.message,
      });
      return res.status(401).json({ code: ApiErrorCode.InvalidAuthToken });
    }
  }
);

userSettingsRoutes.delete<{ id: string }>(
  '/linked-accounts/plex',
  isOwnProfileOrAdmin(),
  async (req, res) => {
    try {
      const { status, body } = await unlinkAccount(
        req,
        Number(req.params.id),
        'plex'
      );
      return body ? res.status(status).json(body) : res.status(status).send();
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
  }
);

/** Linking a Jellyfin or Emby account with its username and password. */
const linkWithPassword =
  (kindOf: () => JellyfinFamilyKind) =>
  async (
    req: Request<
      { id: string },
      unknown,
      { username: string; password: string }
    >,
    res: Response
  ) => {
    const userRepository = getRepository(User);
    const user = req.user;

    if (!user) {
      return res.status(401).json({ code: ApiErrorCode.Unauthorized });
    }
    const kind = kindOf();
    if (!isConnected(kind)) {
      return res
        .status(500)
        .json({ message: `${serverName(kind)} login is disabled` });
    }

    // Do not allow linking of an already linked account
    if (
      await userRepository.exist({
        where: { [USERNAME[kind]]: req.body.username },
      })
    ) {
      return res.status(422).json({
        message: 'The specified account is already linked to a Seerr user',
      });
    }

    const deviceId = deviceIdFor(user);
    const jellyfinserver = new JellyfinAPI(
      hostnameFor(kind),
      undefined,
      deviceId,
      kind
    );

    try {
      const account = await jellyfinserver.login(
        req.body.username,
        req.body.password,
        clientIpOf(req)
      );
      const { status, body } = await linkJellyfinAccount(
        user,
        kind,
        account,
        deviceId
      );
      return body ? res.status(status).json(body) : res.status(status).send();
    } catch (e) {
      logger.error('Failed to link account to user.', {
        label: 'API',
        ip: req.ip,
        error: e,
      });
      if (
        e instanceof ApiError &&
        e.errorCode === ApiErrorCode.InvalidCredentials
      ) {
        return res.status(401).json({ code: e.errorCode });
      }

      return res.status(500).send();
    }
  };

userSettingsRoutes.post<{ id: string }>(
  '/linked-accounts/jellyfin',
  isOwnProfile(),
  linkWithPassword(() => jellyfinRouteKind())
);

userSettingsRoutes.post<{ id: string }>(
  '/linked-accounts/emby',
  isOwnProfile(),
  linkWithPassword(() => 'emby')
);

userSettingsRoutes.delete<{ id: string }>(
  '/linked-accounts/jellyfin',
  isOwnProfileOrAdmin(),
  async (req, res) => {
    try {
      const target = await getRepository(User).findOne({
        select: { id: true, jellyfinUserId: true },
        where: { id: Number(req.params.id) },
      });
      const { status, body } = await unlinkAccount(
        req,
        Number(req.params.id),
        jellyfinRouteKind(target ?? undefined)
      );
      return body ? res.status(status).json(body) : res.status(status).send();
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
  }
);

userSettingsRoutes.delete<{ id: string }>(
  '/linked-accounts/emby',
  isOwnProfileOrAdmin(),
  async (req, res) => {
    try {
      const { status, body } = await unlinkAccount(
        req,
        Number(req.params.id),
        'emby'
      );
      return body ? res.status(status).json(body) : res.status(status).send();
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
  }
);

userSettingsRoutes.post<{ secret: string }>(
  '/linked-accounts/jellyfin/quickconnect',
  isOwnProfile(),
  async (req, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ code: ApiErrorCode.Unauthorized });
    }

    const result = quickConnectSecret.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ message: 'Invalid secret format' });
    }

    const { secret } = result.data;

    if (!isConnected('jellyfin')) {
      return res
        .status(403)
        .json({ message: 'Quick Connect is only supported by Jellyfin.' });
    }

    const jellyfinServer = new JellyfinAPI(
      hostnameFor('jellyfin'),
      undefined,
      undefined,
      'jellyfin'
    );

    try {
      const account = await jellyfinServer.authenticateQuickConnect(secret);
      const { status, body } = await linkJellyfinAccount(
        user,
        'jellyfin',
        account,
        deviceIdFor(user)
      );
      return body ? res.status(status).json(body) : res.status(status).send();
    } catch (e) {
      logger.error('Failed to link account with Quick Connect.', {
        label: 'API',
        ip: req.ip,
        error: e,
      });

      const status = e instanceof ApiError ? e.statusCode : 500;
      return res.status(status).send();
    }
  }
);

userSettingsRoutes.get<{ id: string }, UserSettingsNotificationsResponse>(
  '/notifications',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const settings = getSettings()?.notifications.agents;

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({
        emailEnabled: settings.email.enabled,
        pgpKey: user.settings?.pgpKey,
        discordEnabled:
          settings?.discord.enabled && settings.discord.options.enableMentions,
        discordEnabledTypes:
          settings?.discord.enabled && settings.discord.options.enableMentions
            ? settings.discord.types
            : 0,
        discordIds: user.settings?.discordIds ?? [],
        pushbulletAccessToken: user.settings?.pushbulletAccessToken,
        pushoverApplicationToken: user.settings?.pushoverApplicationToken,
        pushoverUserKey: user.settings?.pushoverUserKey,
        pushoverSound: user.settings?.pushoverSound,
        telegramEnabled: settings.telegram.enabled,
        telegramBotUsername: settings.telegram.options.botUsername,
        telegramChatId: user.settings?.telegramChatId,
        telegramMessageThreadId: user.settings?.telegramMessageThreadId,
        telegramSendSilently: user.settings?.telegramSendSilently,
        webPushEnabled: settings.webpush.enabled,
        notificationTypes: user.settings?.notificationTypes ?? {},
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<{ id: string }, UserSettingsNotificationsResponse>(
  '/notifications',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      // Only the owner changes the owner's settings, or another admin's.
      if (!mayEditUser(req.user, user)) {
        return next({
          status: 403,
          message: "You do not have permission to modify this user's settings.",
        });
      }

      const discordIds =
        req.body.discordIds?.filter((id: string) => id !== '') ?? [];

      if (!user.settings) {
        user.settings = new UserSettings({
          user: req.user,
          pgpKey: req.body.pgpKey,
          discordIds,
          pushbulletAccessToken: req.body.pushbulletAccessToken,
          pushoverApplicationToken: req.body.pushoverApplicationToken,
          pushoverUserKey: req.body.pushoverUserKey,
          telegramChatId: req.body.telegramChatId,
          telegramMessageThreadId: req.body.telegramMessageThreadId,
          telegramSendSilently: req.body.telegramSendSilently,
          notificationTypes: req.body.notificationTypes,
        });
      } else {
        user.settings.pgpKey = req.body.pgpKey;
        user.settings.discordIds = discordIds;
        user.settings.pushbulletAccessToken = req.body.pushbulletAccessToken;
        user.settings.pushoverApplicationToken =
          req.body.pushoverApplicationToken;
        user.settings.pushoverUserKey = req.body.pushoverUserKey;
        user.settings.pushoverSound = req.body.pushoverSound;
        user.settings.telegramChatId = req.body.telegramChatId;
        user.settings.telegramMessageThreadId =
          req.body.telegramMessageThreadId;
        user.settings.telegramSendSilently = req.body.telegramSendSilently;
        user.settings.notificationTypes = Object.assign(
          {},
          user.settings.notificationTypes,
          req.body.notificationTypes
        );
      }

      await userRepository.save(user);

      return res.status(200).json({
        pgpKey: user.settings.pgpKey,
        discordIds: user.settings.discordIds ?? [],
        pushbulletAccessToken: user.settings.pushbulletAccessToken,
        pushoverApplicationToken: user.settings.pushoverApplicationToken,
        pushoverUserKey: user.settings.pushoverUserKey,
        pushoverSound: user.settings.pushoverSound,
        telegramChatId: user.settings.telegramChatId,
        telegramMessageThreadId: user.settings.telegramMessageThreadId,
        telegramSendSilently: user.settings.telegramSendSilently,
        notificationTypes: user.settings.notificationTypes,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.get<{ id: string }, { permissions?: number }>(
  '/permissions',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({ permissions: user.permissions });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  { permissions?: number },
  { permissions: number }
>(
  '/permissions',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      // Nobody sets their own permissions or the owner's, and only the owner
      // changes another admin's.
      if (!mayManageUser(req.user, user)) {
        return next({
          status: 403,
          message: 'You do not have permission to modify this user',
        });
      }

      if (!canMakePermissionsChange(req.body.permissions, req.user)) {
        return next({
          status: 403,
          message: 'You do not have permission to grant this level of access',
        });
      }
      user.permissions = req.body.permissions;

      await userRepository.save(user);

      return res.status(200).json({ permissions: user.permissions });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

/*
 * The fork's optional features this person has turned off for themselves.
 * Features an admin turned off for everyone stay off whatever this says.
 */
userSettingsRoutes.get<{ id: string }>(
  '/features',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }
      return res
        .status(200)
        .json({ disabled: user.settings?.disabledFeatures ?? [] });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<{ id: string }>(
  '/features',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const disabled = cleanFeatureList(
      (req.body as { disabled?: unknown }).disabled
    );
    if (!disabled) {
      return next({ status: 400, message: 'A list of features is required.' });
    }
    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }
      // As with every other setting: only the owner changes the owner's.
      if (user.id === 1 && req.user?.id !== 1) {
        return next({
          status: 403,
          message: "You do not have permission to modify this user's settings.",
        });
      }
      const repository = getRepository(UserSettings);
      if (user.settings) {
        await repository.update(user.settings.id, {
          disabledFeatures: disabled,
        });
      } else {
        await repository.save(
          new UserSettings({ user, disabledFeatures: disabled })
        );
      }
      return res.status(200).json({ disabled });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

/**
 * The home page rows a person hid for themselves, by slider id. Rows an
 * admin turned off are off for everyone whatever this says.
 */
userSettingsRoutes.get<{ id: string }>(
  '/discover',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }
      return res.status(200).json({
        hidden: user.settings?.hiddenSliders ?? [],
        networks: user.settings?.discoverNetworks ?? null,
      });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<{ id: string }>(
  '/discover',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const body = req.body as { hidden?: unknown; networks?: unknown };
    const raw = body.hidden;
    const sentNetworks = 'networks' in body;
    if (
      (raw === undefined && !sentNetworks) ||
      (raw !== undefined &&
        (!Array.isArray(raw) || !raw.every((n) => Number.isInteger(n))))
    ) {
      return next({
        status: 400,
        message: 'A list of slider ids, or of networks, is required.',
      });
    }
    // Their own list for the Networks row, checked and re-written; null (or
    // empty) for the usual list.
    let networks: string | null | undefined;
    if (sentNetworks) {
      try {
        networks = sanitizeDiscoverNetworks(
          body.networks as string | null | undefined
        );
      } catch (e) {
        if (e instanceof DiscoverNetworksError) {
          return res.status(400).json({ message: e.message });
        }
        throw e;
      }
    }
    // Only rows that exist, once each.
    let hidden: number[] | undefined;
    if (raw !== undefined) {
      const existing = new Set(
        (
          await getRepository(DiscoverSlider).find({ select: { id: true } })
        ).map((s) => s.id)
      );
      hidden = [...new Set(raw as number[])].filter((id) => existing.has(id));
    }
    const changes: Partial<UserSettings> = {
      ...(hidden !== undefined && { hiddenSliders: hidden }),
      ...(networks !== undefined && { discoverNetworks: networks }),
    };
    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }
      if (user.id === 1 && req.user?.id !== 1) {
        return next({
          status: 403,
          message: "You do not have permission to modify this user's settings.",
        });
      }
      const repository = getRepository(UserSettings);
      if (user.settings) {
        await repository.update(user.settings.id, changes);
      } else {
        await repository.save(new UserSettings({ user, ...changes }));
      }
      return res.status(200).json({
        hidden: hidden ?? user.settings?.hiddenSliders ?? [],
        networks:
          networks !== undefined
            ? networks
            : (user.settings?.discoverNetworks ?? null),
      });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

/*
 * The order a person put their sidebar and phone menu in, and the items
 * they hid, by item name (server/constants/navigation.ts). Arranged from
 * their home page; nobody else's sidebar changes.
 */
userSettingsRoutes.get<{ id: string }>(
  '/sidebar',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }
      return res.status(200).json({
        order: user.settings?.sidebarOrder ?? [],
        hidden: user.settings?.sidebarHidden ?? [],
      });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<{ id: string }>(
  '/sidebar',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const body = req.body as { order?: unknown; hidden?: unknown };
    const isNames = (value: unknown) =>
      Array.isArray(value) && value.every((name) => typeof name === 'string');
    if (
      (body.order === undefined && body.hidden === undefined) ||
      (body.order !== undefined && !isNames(body.order)) ||
      (body.hidden !== undefined && !isNames(body.hidden))
    ) {
      return next({
        status: 400,
        message: 'A list of sidebar items to order, or to hide, is required.',
      });
    }
    // Names that are not items are dropped. The usual order is kept as no
    // order at all, so items added later take their usual place and the
    // phone menu keeps its own order.
    const order =
      body.order === undefined
        ? undefined
        : isDefaultNavOrder(cleanNavOrder(body.order) ?? [])
          ? []
          : (cleanNavOrder(body.order) ?? []);
    const hidden =
      body.hidden === undefined ? undefined : cleanNavHidden(body.hidden);
    const changes: Partial<UserSettings> = {
      ...(order !== undefined && { sidebarOrder: order }),
      ...(hidden !== undefined && { sidebarHidden: hidden }),
    };
    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }
      if (user.id === 1 && req.user?.id !== 1) {
        return next({
          status: 403,
          message: "You do not have permission to modify this user's settings.",
        });
      }
      const repository = getRepository(UserSettings);
      if (user.settings) {
        await repository.update(user.settings.id, changes);
      } else {
        await repository.save(new UserSettings({ user, ...changes }));
      }
      return res.status(200).json({
        order: order ?? user.settings?.sidebarOrder ?? [],
        hidden: hidden ?? user.settings?.sidebarHidden ?? [],
      });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

/*
 * Someone else's passkeys, for whoever manages users: to see which devices
 * can sign in as them and remove one that is lost or no longer theirs.
 * Adding or renaming stays with the person themselves. As with passwords,
 * only the owner can touch the owner's, or another admin's.
 */
const passkeyManager = async (
  req: Request<{ id: string }>
): Promise<User | { status: number; message: string }> => {
  const user = await getRepository(User).findOne({
    where: { id: Number(req.params.id) },
  });
  if (!user) {
    return { status: 404, message: 'User not found.' };
  }
  if (!mayEditUser(req.user, user)) {
    return {
      status: 403,
      message: "You do not have permission to manage this user's passkeys.",
    };
  }
  return user;
};

userSettingsRoutes.get<{ id: string }>(
  '/passkeys',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const user = await passkeyManager(req);
      if (!(user instanceof User)) {
        return next(user);
      }
      const passkeys = await getRepository(UserPasskey).find({
        where: { user: { id: user.id } },
        order: { createdAt: 'ASC' },
      });
      return res.status(200).json(passkeys.map(passkeySummary));
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.delete<{ id: string; passkeyId: string }>(
  '/passkeys/:passkeyId',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const user = await passkeyManager(req);
      if (!(user instanceof User)) {
        return next(user);
      }
      const result = await getRepository(UserPasskey).delete({
        id: Number(req.params.passkeyId),
        user: { id: user.id },
      });
      if (!result.affected) {
        return next({ status: 404, message: 'Passkey not found.' });
      }
      // Whoever has the device it was on is signed out with it.
      await endSessions(
        user.id,
        req.user?.id === user.id ? req.sessionID : undefined
      );
      logger.info('Passkey removed by an admin', {
        label: 'Auth',
        userId: user.id,
        passkeyId: Number(req.params.passkeyId),
        removedBy: req.user?.id,
      });
      return res.status(204).send();
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

export default userSettingsRoutes;
