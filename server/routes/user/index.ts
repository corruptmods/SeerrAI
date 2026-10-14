import PlexTvAPI from '@server/api/plextv';
import TautulliAPI from '@server/api/tautulli';
import { ApiErrorCode } from '@server/constants/error';
import { MediaType, VIDEO_MEDIA_TYPES } from '@server/constants/media';
import { UserType } from '@server/constants/user';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import RemovedPlexAccount from '@server/entity/RemovedPlexAccount';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { Watchlist } from '@server/entity/Watchlist';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import type {
  QuotaResponse,
  UserRequestsResponse,
  UserResultsResponse,
  UserWatchDataResponse,
} from '@server/interfaces/api/userInterfaces';
import { featureEnabled } from '@server/lib/features';
import { linkedJellyfinUsers } from '@server/lib/jellyfinUsers';
import { mayManageUser, plexAccountMayClaim } from '@server/lib/manageUser';
import type { JellyfinFamilyKind } from '@server/lib/mediaServers';
import {
  USERNAME,
  USER_ID,
  USER_TYPE,
  isConnected,
  jellyfinAccountColumns,
  jellyfinClient as jellyfinClientFor,
  jellyfinFamilyServer,
  serverName,
} from '@server/lib/mediaServers';
import { musicReady } from '@server/lib/music/access';
import { attachAlbumStatuses } from '@server/lib/music/albumStatuses';
import { withNewUserDefaults } from '@server/lib/newUserDefaults';
import { Permission, hasPermission } from '@server/lib/permissions';
import { isPushServiceEndpoint } from '@server/lib/pushEndpoint';
import { getSettings } from '@server/lib/settings';
import {
  attachRequestCount,
  attachRequestCounts,
} from '@server/lib/userRequestCounts';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { checkAvatarChanged } from '@server/routes/avatarproxy';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import { pageOf } from '@server/utils/pagination';
import { isOwnProfileOrAdmin } from '@server/utils/profileMiddleware';
import { Router } from 'express';
import gravatarUrl from 'gravatar-url';
import { findIndex, sortBy } from 'lodash';
import type { EntityManager } from 'typeorm';
import { In, Not } from 'typeorm';
import userSettingsRoutes from './usersettings';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const includeIds = [
      ...new Set(
        req.query.includeIds ? req.query.includeIds.toString().split(',') : []
      ),
    ];
    const pageSize = req.query.take
      ? Number(req.query.take)
      : Math.max(10, includeIds.length);
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const q = req.query.q ? req.query.q.toString().toLowerCase() : '';
    const sortParam = req.query.sort ? req.query.sort.toString() : undefined;
    const sortDirectionQuery = req.query.sortDirection
      ? req.query.sortDirection.toString().toLowerCase()
      : undefined;

    let sortDirection: 'ASC' | 'DESC';
    if (sortDirectionQuery === 'asc') {
      sortDirection = 'ASC';
    } else if (sortDirectionQuery === 'desc') {
      sortDirection = 'DESC';
    } else {
      switch (sortParam) {
        case 'displayname':
          sortDirection = 'ASC';
          break;
        case 'requests':
        case 'updated':
          sortDirection = 'DESC';
          break;
        case 'created':
        case 'usertype':
        case 'role':
        case undefined:
        default:
          sortDirection = 'ASC';
          break;
      }
    }

    let query = getRepository(User).createQueryBuilder('user');

    if (q) {
      // Matching on email would let anyone confirm an address by searching
      // for it, so only those who manage users search email.
      const fields = [
        'user.username',
        'user.plexUsername',
        'user.jellyfinUsername',
        'user.embyUsername',
        ...(req.user?.hasPermission(Permission.MANAGE_USERS)
          ? ['user.email']
          : []),
      ];
      query = query.where(
        `(${fields.map((field) => `LOWER(${field}) LIKE :q`).join(' OR ')})`,
        { q: `%${q}%` }
      );
    }

    if (includeIds.length > 0) {
      query.andWhereInIds(includeIds);
    }

    switch (sortParam) {
      case 'created':
        query = query.orderBy('user.createdAt', sortDirection);
        break;
      case 'updated':
        query = query.orderBy('user.updatedAt', sortDirection);
        break;
      case 'displayname':
        query = query
          .addSelect(
            `CASE WHEN (user.username IS NULL OR user.username = '') THEN (
                CASE WHEN (user.plexUsername IS NULL OR user.plexUsername = '') THEN (
                  CASE WHEN (user.jellyfinUsername IS NULL OR user.jellyfinUsername = '') THEN (
                    CASE WHEN (user.embyUsername IS NULL OR user.embyUsername = '') THEN
                      "user"."email"
                    ELSE
                      LOWER(user.embyUsername)
                    END)
                  ELSE
                    LOWER(user.jellyfinUsername)
                  END)
                ELSE
                  LOWER(user.plexUsername)
                END)
              ELSE
                LOWER(user.username)
              END`,
            'displayname_sort_key'
          )
          .orderBy('displayname_sort_key', sortDirection);
        break;
      case 'requests':
        query = query
          .addSelect((subQuery) => {
            return subQuery
              .select('COUNT(request.id)', 'request_count')
              .from(MediaRequest, 'request')
              .where('request.requestedBy.id = user.id');
          }, 'request_count')
          .orderBy('request_count', sortDirection);
        break;
      case 'usertype':
        query = query.orderBy('user.userType', sortDirection);
        break;
      case 'role':
        query = query
          .addSelect(
            `CASE
              WHEN user.id = 1 THEN 0
              WHEN (user.permissions & ${Permission.ADMIN}) != 0 THEN 1
              ELSE 2
            END`,
            'role_sort_key'
          )
          .orderBy('role_sort_key', sortDirection);
        break;
      default:
        query = query.orderBy('user.id', sortDirection);
        break;
    }

    const [users, userCount] = await query
      .take(pageSize)
      .skip(skip)
      .distinct(true)
      .getManyAndCount();

    // Filled in explicitly rather than by a @RelationCount decorator, which
    // ran a parallel batch of counts on one connection.
    await attachRequestCounts(users);

    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(userCount / pageSize),
        pageSize,
        results: userCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: User.filterMany(
        users,
        req.user?.hasPermission(Permission.MANAGE_USERS)
      ),
    } as UserResultsResponse);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

router.post(
  '/',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const settings = getSettings();

      const body = req.body;
      const email = body.email || body.username;
      const userRepository = getRepository(User);

      const existingUser = await userRepository
        .createQueryBuilder('user')
        .where('user.email = :email', {
          email: email.toLowerCase(),
        })
        .getOne();

      if (existingUser) {
        return next({
          status: 409,
          message: 'User already exists with submitted email.',
          errors: ['USER_EXISTS'],
        });
      }

      const passedExplicitPassword = body.password && body.password.length > 0;
      const avatar = gravatarUrl(email, { default: 'mm', size: 200 });

      if (
        !passedExplicitPassword &&
        !settings.notifications.agents.email.enabled
      ) {
        throw new Error('Email notifications must be enabled');
      }

      const user = withNewUserDefaults(
        new User({
          email,
          avatar: body.avatar ?? avatar,
          username: body.username,
          password: body.password,
          permissions: settings.main.defaultPermissions,
          plexToken: '',
          userType: UserType.LOCAL,
        })
      );

      if (passedExplicitPassword) {
        await user?.setPassword(body.password);
      } else {
        await user?.generatePassword();
      }

      await userRepository.save(user);
      return res.status(201).json(user.filter());
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post<
  never,
  unknown,
  {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string;
  }
>('/registerPushSubscription', async (req, res, next) => {
  // Seerr sends notifications to this address itself, so it has to be a
  // browser's push service, not any address someone gives it.
  if (!isPushServiceEndpoint(req.body.endpoint)) {
    return next({ status: 400, message: 'Not a push service address.' });
  }
  try {
    // This prevents race conditions where two requests both pass the checks
    await dataSource.transaction(
      async (transactionalEntityManager: EntityManager) => {
        const transactionalRepo =
          transactionalEntityManager.getRepository(UserPushSubscription);

        // An endpoint is one device. When someone else registers it, it has
        // changed hands: the previous person's notifications must stop
        // arriving on it.
        const previousOwners = await transactionalRepo.find({
          relations: { user: true },
          where: {
            endpoint: req.body.endpoint,
            user: { id: Not(req.user?.id as number) },
          },
        });
        if (previousOwners.length > 0) {
          await transactionalRepo.remove(previousOwners);
          logger.info('A device used for push notifications changed hands', {
            label: 'API',
            userId: req.user?.id,
          });
        }

        // Check for existing subscription by endpoint within transaction
        const existingSubscription = await transactionalRepo.findOne({
          relations: { user: true },
          where: {
            endpoint: req.body.endpoint,
            user: { id: req.user?.id },
          },
        });

        if (existingSubscription) {
          // If endpoint matches but auth is different, update with new keys (iOS refresh case)
          if (
            existingSubscription.endpoint === req.body.endpoint &&
            existingSubscription.auth !== req.body.auth
          ) {
            existingSubscription.auth = req.body.auth;
            existingSubscription.p256dh = req.body.p256dh;
            existingSubscription.userAgent = req.body.userAgent;

            await transactionalRepo.save(existingSubscription);

            logger.debug(
              'Updated existing push subscription with new keys for same endpoint.',
              { label: 'API' }
            );
            return;
          }

          logger.debug(
            'Duplicate subscription detected. Skipping registration.',
            { label: 'API' }
          );
          return;
        }

        // Clean up only true endpoint rotations. Same push-service subscription
        // (matched by `auth`) but with a stale endpoint. Matching on `auth`
        // avoids deleting sibling devices that only share a user agent.
        if (req.body.auth) {
          const staleSubscriptions = await transactionalRepo.find({
            relations: { user: true },
            where: {
              user: { id: req.user?.id },
              auth: req.body.auth,
              endpoint: Not(req.body.endpoint),
            },
          });

          if (staleSubscriptions.length > 0) {
            await transactionalRepo.remove(staleSubscriptions);
            logger.debug(
              `Removed ${staleSubscriptions.length} stale push subscription(s) from same device.`,
              { label: 'API' }
            );
          }
        }

        const userPushSubscription = new UserPushSubscription({
          auth: req.body.auth,
          endpoint: req.body.endpoint,
          p256dh: req.body.p256dh,
          userAgent: req.body.userAgent,
          user: req.user,
        });

        await transactionalRepo.save(userPushSubscription);
      }
    );

    return res.status(204).send();
  } catch (e) {
    // Two subscribe attempts for the same device can land at once (the
    // device-state hook and the worker setup both re-subscribe after a
    // storage reset). Both pass the existence check, both insert, and the
    // second trips the (endpoint, user) unique constraint. The subscription
    // exists, which is the outcome the caller wanted — report success.
    const code =
      (e as { driverError?: { code?: string }; code?: string })?.driverError
        ?.code ?? (e as { code?: string })?.code;
    const message = e instanceof Error ? e.message : String(e);

    if (
      code === '23505' ||
      code === 'SQLITE_CONSTRAINT' ||
      /UNIQUE constraint failed|duplicate key value/i.test(message)
    ) {
      logger.debug(
        'Push subscription already registered by a concurrent request.',
        {
          label: 'API',
        }
      );
      return res.status(204).send();
    }

    logger.error('Failed to register user push subscription', {
      label: 'API',
      errorMessage: message,
    });
    next({ status: 500, message: 'Failed to register subscription.' });
  }
});

// Registered before the `/:id` routes so the literal path is matched first.
router.get(
  '/pushSubscriptionCounts',
  isAuthenticated(Permission.MANAGE_USERS),
  async (_req, res, next) => {
    try {
      const counts = await getRepository(UserPushSubscription)
        .createQueryBuilder('pushSub')
        .select('pushSub.userId', 'userId')
        .addSelect('COUNT(pushSub.id)', 'deviceCount')
        .groupBy('pushSub.userId')
        .getRawMany<{ userId: number; deviceCount: string | number }>();

      return res.status(200).json(
        counts.map((row) => ({
          userId: Number(row.userId),
          deviceCount: Number(row.deviceCount),
        }))
      );
    } catch (e) {
      logger.error('Failed to fetch push subscription counts', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to fetch subscription counts.' });
    }
  }
);

router.get<{ id: string }>(
  '/:id/pushSubscriptions',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userPushSubRepository = getRepository(UserPushSubscription);

      const userPushSubs = await userPushSubRepository.find({
        relations: { user: true },
        where: { user: { id: Number(req.params.id) } },
      });

      return res.status(200).json(userPushSubs);
    } catch {
      next({ status: 404, message: 'User subscriptions not found.' });
    }
  }
);

router.get<{ id: string; endpoint: string }>(
  '/:id/pushSubscription/:endpoint',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userPushSubRepository = getRepository(UserPushSubscription);

      const userPushSub = await userPushSubRepository.findOneOrFail({
        relations: {
          user: true,
        },
        where: {
          user: { id: Number(req.params.id) },
          endpoint: req.params.endpoint,
        },
      });

      return res.status(200).json(userPushSub);
    } catch {
      next({ status: 404, message: 'User subscription not found.' });
    }
  }
);

router.delete<{ id: string; endpoint: string }>(
  '/:id/pushSubscription/:endpoint',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userPushSubRepository = getRepository(UserPushSubscription);

      const userPushSub = await userPushSubRepository.findOne({
        relations: { user: true },
        where: {
          user: { id: Number(req.params.id) },
          endpoint: req.params.endpoint,
        },
      });

      // If not found, just return 204 to prevent push disable failure
      // (rare scenario where user push sub does not exist)
      if (!userPushSub) {
        return res.status(204).send();
      }

      await userPushSubRepository.remove(userPushSub);
      return res.status(204).send();
    } catch (e) {
      logger.error('Something went wrong deleting the user push subcription', {
        label: 'API',
        endpoint: req.params.endpoint,
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'User push subcription not found',
      });
    }
  }
);

router.get<{ id: string }>('/:id', async (req, res, next) => {
  try {
    const userRepository = getRepository(User);
    const user = await userRepository.findOneOrFail({
      where: { id: Number(req.params.id) },
    });

    // The profile page shows this; it is no longer populated by a decorator.
    await attachRequestCount(user);

    const isOwnProfile = req.user?.id === user.id;
    const isAdmin = req.user?.hasPermission(Permission.MANAGE_USERS);

    return res.status(200).json(user.filter(isOwnProfile || isAdmin));
  } catch {
    next({ status: 404, message: 'User not found.' });
  }
});

router.get<{ jellyfinUserId: string }>(
  '/jellyfin/:jellyfinUserId',
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      const jellyfinUserId = normalizeJellyfinGuid(req.params.jellyfinUserId);
      if (!jellyfinUserId) {
        return next({ status: 400, message: 'Invalid Jellyfin User ID.' });
      }

      // An Emby account's id is looked for too: Emby's ids were kept with
      // Jellyfin's before Emby had its own.
      const user = await userRepository.findOneOrFail({
        where: [{ jellyfinUserId }, { embyUserId: jellyfinUserId }],
      });

      return res
        .status(200)
        .json(user.filter(req.user?.hasPermission(Permission.MANAGE_USERS)));
    } catch {
      next({ status: 404, message: 'User not found.' });
    }
  }
);

router.use('/:id/settings', userSettingsRoutes);

router.get<{ id: string }, UserRequestsResponse>(
  '/:id/requests',
  async (req, res, next) => {
    const { pageSize, skip } = pageOf(req.query, 20);

    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      if (
        user.id !== req.user?.id &&
        !req.user?.hasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        )
      ) {
        return next({
          status: 403,
          message: "You do not have permission to view this user's requests.",
        });
      }

      // Music only for a viewer who has it: set up, and not turned off.
      const types =
        musicReady() && featureEnabled('music', req.user)
          ? [...VIDEO_MEDIA_TYPES, MediaType.MUSIC]
          : [...VIDEO_MEDIA_TYPES];
      const [requests, requestCount] = await getRepository(MediaRequest)
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .leftJoinAndSelect('request.seasons', 'seasons')
        .leftJoinAndSelect('request.albums', 'albums')
        .leftJoinAndSelect('request.modifiedBy', 'modifiedBy')
        .leftJoinAndSelect('request.requestedBy', 'requestedBy')
        .andWhere('requestedBy.id = :id', {
          id: user.id,
        })
        .andWhere('request.type IN (:...types)', { types })
        .orderBy('request.id', 'DESC')
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();
      await attachAlbumStatuses(requests);

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(requestCount / pageSize),
          pageSize,
          results: requestCount,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: requests,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

export const canMakePermissionsChange = (
  permissions: number,
  user?: User
): boolean =>
  // Only let the owner grant admin privileges
  !(hasPermission(Permission.ADMIN, permissions) && user?.id !== 1);

router.put<
  Record<string, never>,
  Partial<User>[],
  { ids: string[]; permissions: number }
>('/', isAuthenticated(Permission.MANAGE_USERS), async (req, res, next) => {
  try {
    if (!canMakePermissionsChange(req.body.permissions, req.user)) {
      return next({
        status: 403,
        message: 'You do not have permission to grant this level of access',
      });
    }

    const userRepository = getRepository(User);

    // Anyone chosen whom this person may not manage (themselves, the
    // owner, another admin unless they are the owner) is left as they are.
    const users = (
      await userRepository.find({ where: { id: In(req.body.ids) } })
    ).filter((user) => mayManageUser(req.user, user));

    if (users.length > 0) {
      await userRepository.update(
        { id: In(users.map((user) => user.id)) },
        { permissions: req.body.permissions }
      );
    }

    const updatedUsers = await userRepository.find({
      where: { id: In(users.map((user) => user.id)) },
    });

    return res.status(200).json(User.filterMany(updatedUsers));
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

router.put<{ id: string }>(
  '/:id',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      const user = await userRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      // Nobody changes their own permissions, and only the owner changes
      // another admin's.
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

      Object.assign(user, {
        username: req.body.username,
        permissions: req.body.permissions,
      });

      await userRepository.update(user.id, {
        username: req.body.username,
        permissions: req.body.permissions,
      });

      return res.status(200).json(user.filter());
    } catch {
      next({ status: 404, message: 'User not found.' });
    }
  }
);

router.delete<{ id: string }>(
  '/:id',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
        relations: { requests: true },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      if (user.id === 1) {
        return next({
          status: 405,
          message: 'This account cannot be deleted.',
        });
      }

      if (user.hasPermission(Permission.ADMIN) && req.user?.id !== 1) {
        return next({
          status: 405,
          message: 'You cannot delete users with administrative privileges.',
        });
      }

      const requestRepository = getRepository(MediaRequest);

      /**
       * Requests are usually deleted through a cascade constraint. Those however, do
       * not trigger the removal event so listeners to not run and the parent Media
       * will not be updated back to unknown for titles that were still pending. So
       * we manually remove all requests from the user here so the parent media's
       * properly reflect the change.
       */
      await requestRepository.remove(user.requests, {
        /**
         * Break-up into groups of 1000 requests to be removed at a time.
         * Necessary for users with >1000 requests, else an SQLite 'Expression tree is too large' error occurs.
         * https://typeorm.io/repository-api#additional-options
         */
        chunk: user.requests.length / 1000,
      });

      // Otherwise the automatic Plex import would bring them straight back.
      if (user.plexId) {
        await getRepository(RemovedPlexAccount).upsert(
          { plexId: user.plexId },
          { conflictPaths: ['plexId'] }
        );
      }

      await userRepository.delete(user.id);
      return res.status(200).json(user.filter());
    } catch (e) {
      logger.error('Something went wrong deleting a user', {
        label: 'API',
        userId: req.params.id,
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Something went wrong deleting the user',
      });
    }
  }
);

router.post(
  '/import-from-plex',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const userRepository = getRepository(User);
      const body = req.body as { plexIds: string[] } | undefined;

      if (!isConnected('plex')) {
        return next({ status: 400, message: 'Plex is not connected.' });
      }

      // taken from auth.ts
      const mainUser = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const mainPlexTv = new PlexTvAPI(mainUser.plexToken ?? '');

      const plexUsersResponse = await mainPlexTv.getUsers();
      const createdUsers: User[] = [];
      const skippedUsers: { id: string; name: string; reason: string }[] = [];
      let refreshedUsers = 0;
      for (const rawUser of plexUsersResponse.MediaContainer.User) {
        const account = rawUser.$;

        if (account.email) {
          const linked = await userRepository.findOne({
            where: { plexId: parseInt(account.id) },
          });
          const sameEmail = linked
            ? null
            : await userRepository
                .createQueryBuilder('user')
                .where('user.email = :email', {
                  email: account.email.toLowerCase(),
                })
                .getOne();
          // An account with this email that is not waiting for this Plex
          // account (a password account, or one linked to another Plex
          // account) is never taken over: its owner links Plex themselves.
          const user =
            linked ??
            (sameEmail && plexAccountMayClaim(sameEmail) ? sameEmail : null);

          if (user) {
            // Update the user's avatar with their Plex thumbnail, in case it changed
            await userRepository.update(user.id, {
              avatar: account.thumb,
              email: account.email,
              plexUsername: account.username,
            });
            refreshedUsers += 1;
          } else if (sameEmail) {
            logger.info(
              'Plex user not imported: their email belongs to another account',
              { label: 'API', userId: sameEmail.id, plexId: account.id }
            );
            if (!body || body.plexIds.includes(account.id)) {
              skippedUsers.push({
                id: account.id,
                name: account.username,
                reason: ApiErrorCode.ExistingAccount,
              });
            }
          } else if (!body || body.plexIds.includes(account.id)) {
            if (await mainPlexTv.checkUserAccess(parseInt(account.id))) {
              const newUser = withNewUserDefaults(
                new User({
                  plexUsername: account.username,
                  email: account.email,
                  permissions: settings.main.defaultPermissions,
                  plexId: parseInt(account.id),
                  plexToken: '',
                  avatar: account.thumb,
                  userType: UserType.PLEX,
                })
              );
              await userRepository.save(newUser);
              createdUsers.push(newUser);
            }
          }
        }
      }

      return res.status(201).json({
        createdUsers: User.filterMany(createdUsers),
        refreshedUsers,
        skippedUsers,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

/**
 * Imports people from a Jellyfin or Emby server: those not yet imported
 * (all of them, or those chosen) get an account, and those already
 * imported have their name and picture brought up to date. Someone whose
 * name there is already another account's email or name is left out, with
 * the reason: they sign in with that account and link this server.
 */
const importJellyfinUsers = async (
  kind: JellyfinFamilyKind,
  chosenIds: string[] | undefined
) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const jellyfinClient = await jellyfinClientFor(kind, { asAdmin: true });

  const createdUsers: User[] = [];
  const skippedUsers: { id: string; name: string; reason: string }[] = [];
  let refreshedUsers = 0;

  const jellyfinUsers = (await jellyfinClient.getUsers()).users.filter(
    (jellyfinUser) => normalizeJellyfinGuid(jellyfinUser.Id)
  );
  const linked = await linkedJellyfinUsers(
    jellyfinUsers.map((jellyfinUser) => jellyfinUser.Id),
    kind
  );
  // With no list, everyone not yet imported is, as on Import Plex Users.
  const chosen = chosenIds
    ? new Set(chosenIds.map((id) => normalizeJellyfinGuid(id)))
    : null;

  for (const jellyfinUser of jellyfinUsers) {
    const jellyfinUserId = normalizeJellyfinGuid(jellyfinUser.Id)!;
    const user = linked.get(jellyfinUserId);

    if (user) {
      // Already imported: bring what comes from the server up to date (the
      // name, and the picture if it changed there and is theirs from this
      // server), as Import Plex Users does. The account's own settings and
      // permissions are left alone.
      const ownPicture = user.userType === USER_TYPE[kind];
      const { changed } = ownPicture
        ? await checkAvatarChanged(user, kind)
        : { changed: false };
      await userRepository.update(user.id, {
        [USERNAME[kind]]: jellyfinUser.Name,
        ...(changed && user.avatarVersion
          ? {
              avatar: `/avatarproxy/${user[USER_ID[kind]]}?v=${user.avatarVersion}`,
            }
          : {}),
      });
      refreshedUsers += 1;
    } else if (!chosen || chosen.has(jellyfinUserId)) {
      const taken = await userRepository
        .createQueryBuilder('user')
        .where('user.email = :email', {
          email: (jellyfinUser.Name ?? '').toLowerCase(),
        })
        .getExists();
      if (taken) {
        logger.info(
          `${serverName(kind)} user not imported: another account already has their name as its email`,
          { label: 'API', jellyfinUserId: jellyfinUser.Id }
        );
        skippedUsers.push({
          id: jellyfinUser.Id,
          name: jellyfinUser.Name,
          reason: ApiErrorCode.ExistingAccount,
        });
        continue;
      }

      const newUser = withNewUserDefaults(
        new User({
          ...jellyfinAccountColumns(kind, {
            username: jellyfinUser.Name,
            userId: jellyfinUser.Id,
            deviceId: Buffer.from(
              `BOT_seerr_${jellyfinUser.Name ?? ''}`
            ).toString('base64'),
          }),
          email: jellyfinUser.Name,
          permissions: settings.main.defaultPermissions,
          avatar: `/avatarproxy/${jellyfinUser.Id}`,
          userType: USER_TYPE[kind],
        })
      );

      await userRepository.save(newUser);
      createdUsers.push(newUser);
    }
  }

  return {
    createdUsers: User.filterMany(createdUsers),
    refreshedUsers,
    skippedUsers,
  };
};

router.post(
  '/import-from-jellyfin',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const body = req.body as { jellyfinUserIds?: string[] } | undefined;
      // Jellyfin; before Emby had its own import, this also imported from
      // an Emby server, and still does when Emby is the one connected.
      const kind = isConnected('jellyfin')
        ? 'jellyfin'
        : (jellyfinFamilyServer() ?? 'jellyfin');
      if (!isConnected(kind)) {
        return next({ status: 400, message: 'Jellyfin is not connected.' });
      }

      return res
        .status(201)
        .json(await importJellyfinUsers(kind, body?.jellyfinUserIds));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post(
  '/import-from-emby',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const body = req.body as { embyUserIds?: string[] } | undefined;
      if (!isConnected('emby')) {
        return next({ status: 400, message: 'Emby is not connected.' });
      }

      return res
        .status(201)
        .json(await importJellyfinUsers('emby', body?.embyUserIds));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.get<{ id: string }, QuotaResponse>(
  '/:id/quota',
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      if (
        Number(req.params.id) !== req.user?.id &&
        !req.user?.hasPermission(
          [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
          { type: 'and' }
        )
      ) {
        return next({
          status: 403,
          message:
            "You do not have permission to view this user's request limits.",
        });
      }

      const user = await userRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      const quotas = await user.getQuota();

      return res.status(200).json(quotas);
    } catch (e) {
      next({ status: 404, message: e.message });
    }
  }
);

router.get<{ id: string }, UserWatchDataResponse>(
  '/:id/watch_data',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const settings = getSettings().tautulli;

    // Tautulli is Plex's watch history: read only while Plex is connected.
    if (
      !isConnected('plex') ||
      !settings.hostname ||
      !settings.port ||
      !settings.apiKey
    ) {
      return next({
        status: 404,
        message: 'Tautulli API not configured.',
      });
    }

    try {
      const user = await getRepository(User).findOneOrFail({
        where: { id: Number(req.params.id) },
        select: { id: true, plexId: true },
      });

      const tautulli = new TautulliAPI(settings);

      const watchStats = await tautulli.getUserWatchStats(user);
      const watchHistory = await tautulli.getUserWatchHistory(user);

      const recentlyWatched = sortBy(
        await getRepository(Media).find({
          where: [
            {
              mediaType: MediaType.MOVIE,
              ratingKey: In(
                watchHistory
                  .filter((record) => record.media_type === 'movie')
                  .map((record) => record.rating_key)
              ),
            },
            {
              mediaType: MediaType.MOVIE,
              ratingKey4k: In(
                watchHistory
                  .filter((record) => record.media_type === 'movie')
                  .map((record) => record.rating_key)
              ),
            },
            {
              mediaType: MediaType.TV,
              ratingKey: In(
                watchHistory
                  .filter((record) => record.media_type === 'episode')
                  .map((record) => record.grandparent_rating_key)
              ),
            },
            {
              mediaType: MediaType.TV,
              ratingKey4k: In(
                watchHistory
                  .filter((record) => record.media_type === 'episode')
                  .map((record) => record.grandparent_rating_key)
              ),
            },
          ],
        }),
        [
          (media) =>
            findIndex(
              watchHistory,
              (record) =>
                (!!media.ratingKey &&
                  parseInt(media.ratingKey) ===
                    (record.media_type === 'movie'
                      ? record.rating_key
                      : record.grandparent_rating_key)) ||
                (!!media.ratingKey4k &&
                  parseInt(media.ratingKey4k) ===
                    (record.media_type === 'movie'
                      ? record.rating_key
                      : record.grandparent_rating_key))
            ),
        ]
      );

      return res.status(200).json({
        recentlyWatched,
        playCount: watchStats.total_plays,
      });
    } catch (e) {
      logger.error('Something went wrong fetching user watch data', {
        label: 'API',
        errorMessage: e.message,
        userId: req.params.id,
      });
      next({
        status: 500,
        message: 'Failed to fetch user watch data.',
      });
    }
  }
);

router.get<{ id: string }, WatchlistResponse>(
  '/:id/watchlist',
  async (req, res, next) => {
    if (
      Number(req.params.id) !== req.user?.id &&
      !req.user?.hasPermission(
        [Permission.MANAGE_REQUESTS, Permission.WATCHLIST_VIEW],
        {
          type: 'or',
        }
      )
    ) {
      return next({
        status: 403,
        message: "You do not have permission to view this user's Watchlist.",
      });
    }

    const itemsPerPage = 20;
    const page = req.query.page ? Number(req.query.page) : 1;
    const offset = (page - 1) * itemsPerPage;

    const user = await getRepository(User).findOneOrFail({
      where: { id: Number(req.params.id) },
      select: ['id', 'plexToken'],
    });

    if (user) {
      const [result, total] = await getRepository(Watchlist).findAndCount({
        where: { requestedBy: { id: user?.id } },
        relations: {
          /*requestedBy: true,media:true*/
        },
        // loadRelationIds: true,
        take: itemsPerPage,
        skip: offset,
      });
      if (total) {
        return res.json({
          page: page,
          totalPages: Math.ceil(total / itemsPerPage),
          totalResults: total,
          results: result,
        });
      }
    }

    // We will just return an empty array if the user has no Plex token
    if (!user.plexToken) {
      return res.json({
        page: 1,
        totalPages: 1,
        totalResults: 0,
        results: [],
      });
    }

    const plexTV = new PlexTvAPI(user.plexToken);

    const watchlist = await plexTV.getWatchlist({ offset });

    return res.json({
      page,
      totalPages: Math.ceil(watchlist.totalSize / itemsPerPage),
      totalResults: watchlist.totalSize,
      results: watchlist.items.map((item) => ({
        id: item.tmdbId,
        ratingKey: item.ratingKey,
        title: item.title,
        mediaType: item.type === 'show' ? 'tv' : 'movie',
        tmdbId: item.tmdbId,
      })),
    });
  }
);

export default router;
