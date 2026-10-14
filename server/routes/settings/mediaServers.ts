import JellyfinAPI from '@server/api/jellyfin';
import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import type {
  JellyfinFamilyKind,
  MediaServerKind,
} from '@server/constants/server';
import {
  MEDIA_SERVER_KINDS,
  USERNAME,
  isJellyfinFamily,
} from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type { MediaServerSummary } from '@server/interfaces/api/mediaServerInterfaces';
import { refreshMediaServerJobs } from '@server/job/schedule';
import { linkedJellyfinUsers } from '@server/lib/jellyfinUsers';
import {
  MediaServerChangeError,
  deriveMediaServerLogin,
  makePrimary,
  removalImpact,
  removeServer,
  setSignIn,
} from '@server/lib/mediaServerAdmin';
import {
  USER_TYPE,
  connectedServers,
  hostnameOf,
  jellyfinAccountColumns,
  primaryServer,
  serverName,
} from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { ApiError } from '@server/types/error';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';

/*
 * Settings → Media Servers: connecting Plex, Jellyfin and Emby, removing
 * them, choosing the primary one, and whether people may sign in with each.
 * Editing a connected server stays at /settings/plex, /settings/jellyfin and
 * /settings/emby.
 */

/** Seerr's own device id on a Jellyfin or Emby server, as at setup. */
const OWNER_DEVICE_ID = 'BOT_seerr';

const mediaServerRoutes = Router();

const summaries = async (): Promise<MediaServerSummary[]> => {
  const settings = getSettings();
  const connected = connectedServers();
  const primary = primaryServer();
  const owner = await getRepository(User).findOne({
    where: { id: 1 },
    select: ['id', ...MEDIA_SERVER_KINDS.map((kind) => USERNAME[kind])],
  });

  return MEDIA_SERVER_KINDS.map((kind) => {
    const server = settings[kind];
    const libraries = [...server.libraries, ...(server.musicLibraries ?? [])];
    const enabled = libraries.filter((library) => library.enabled);
    const scans = enabled
      .map((library) => library.lastScan)
      .filter((scan): scan is number => !!scan);
    const family = isJellyfinFamily(kind) ? settings[kind] : undefined;
    return {
      kind,
      name: server.name ?? '',
      connected: connected.includes(kind),
      primary: kind === primary,
      signIn: server.signIn !== false,
      libraries: libraries.length,
      enabledLibraries: enabled.length,
      lastScan: scans.length ? Math.max(...scans) : undefined,
      address: {
        ip: server.ip ?? '',
        port: server.port,
        useSsl: !!server.useSsl,
        ...(family
          ? {
              urlBase: family.urlBase ?? '',
              externalHostname: family.externalHostname ?? '',
            }
          : { webAppUrl: settings.plex.webAppUrl ?? '' }),
      },
      ownerAccount: owner?.[USERNAME[kind]] || undefined,
    };
  });
};

/** Answers with every server's summary. */
const listed = async (res: Response) => res.status(200).json(await summaries());

/** Passes a refused change on with its status, anything else as a 500. */
const failed = (next: NextFunction, e: unknown) => {
  if (e instanceof MediaServerChangeError) {
    return next({ status: e.status, message: e.message });
  }
  logger.error('Something went wrong changing the media servers', {
    label: 'Media Servers',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return next({ status: 500, message: ApiErrorCode.Unknown });
};

const kindParam = (req: Request): MediaServerKind | undefined =>
  MEDIA_SERVER_KINDS.find((kind) => kind === req.params.kind);

/**
 * Only the owner can link their own account: it is user 1's that is
 * linked, and Plex's access goes through it.
 */
const isOwner = (req: Request): boolean => req.user?.id === 1;

/** Connecting a server: a newly connected one starts scanning at once. */
const connected = async (kind: MediaServerKind) => {
  deriveMediaServerLogin();
  await getSettings().save();
  refreshMediaServerJobs();
  logger.info(`Connected to ${serverName(kind)}`, { label: 'Media Servers' });
};

mediaServerRoutes.get('/', async (_req, res, next) => {
  try {
    return await listed(res);
  } catch (e) {
    return failed(next, e);
  }
});

/*
 * Connecting Plex, step one: the owner signs in with Plex, and that Plex
 * account is linked to their own (user 1). Seerr reaches Plex with it.
 * Their email and the rest of their account are left as they are.
 */
mediaServerRoutes.post('/plex/account', async (req, res, next) => {
  if (!isOwner(req)) {
    return next({
      status: 403,
      message: 'Only the owner can connect Plex, with their own Plex account.',
    });
  }
  const { authToken } = req.body as { authToken?: string };
  if (!authToken) {
    return next({ status: 400, message: 'A Plex sign-in is required.' });
  }

  let account;
  try {
    account = await new PlexTvAPI(authToken).getUser();
  } catch {
    return next({ status: 401, message: ApiErrorCode.InvalidAuthToken });
  }

  const userRepository = getRepository(User);
  const holder = await userRepository.findOne({
    where: { plexId: account.id },
    select: ['id'],
  });
  if (holder && holder.id !== 1) {
    return next({
      status: 409,
      message: 'This Plex account is already linked to someone else.',
    });
  }

  const owner = await userRepository.findOneOrFail({
    where: { id: 1 },
    select: ['id', 'userType'],
  });
  await userRepository.update(1, {
    plexId: account.id,
    plexUsername: account.username,
    plexToken: account.authToken,
    plexTokenExpiredAt: null,
    // Linking an account changes the kind of account only for one that
    // had none.
    ...(owner.userType === UserType.LOCAL ? { userType: UserType.PLEX } : {}),
  });

  return res.status(200).json({ plexUsername: account.username });
});

interface ConnectBody {
  hostname?: string;
  port?: number;
  useSsl?: boolean;
  urlBase?: string;
  externalHostname?: string;
  webAppUrl?: string;
  username?: string;
  password?: string;
  apiKey?: string;
  adminUserId?: string;
  linkOwner?: boolean;
  signIn?: boolean;
}

/*
 * Connecting Plex, step two: the server the owner chose (from
 * /settings/plex/devices/servers), reached with their Plex account. Its
 * libraries are then synced and chosen at /settings/plex/library.
 */
const connectPlex = async (
  req: Request,
  body: ConnectBody,
  next: NextFunction
): Promise<boolean> => {
  if (!isOwner(req)) {
    next({
      status: 403,
      message: 'Only the owner can connect Plex, with their own Plex account.',
    });
    return false;
  }
  const owner = await getRepository(User).findOneOrFail({
    where: { id: 1 },
    select: ['id', 'plexToken'],
  });
  if (!owner.plexToken) {
    next({ status: 400, message: 'Sign in with Plex first.' });
    return false;
  }

  const settings = getSettings();
  const address = {
    ip: body.hostname ?? '',
    port: Number(body.port ?? 32400),
    useSsl: !!body.useSsl,
  };
  let status;
  try {
    status = await new PlexAPI({
      plexToken: owner.plexToken,
      plexSettings: { ...settings.plex, ...address },
      timeout: 10000,
    }).getStatus();
  } catch (e) {
    logger.warn('Could not reach the Plex server being connected', {
      label: 'Media Servers',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
  const machineId = status?.MediaContainer?.machineIdentifier;
  if (!machineId) {
    next({ status: 502, message: ApiErrorCode.InvalidUrl });
    return false;
  }

  // Another server's libraries are not this one's.
  if (settings.plex.machineId && settings.plex.machineId !== machineId) {
    settings.plex.libraries = [];
    settings.plex.musicLibraries = [];
  }
  Object.assign(settings.plex, address, {
    machineId,
    name: status?.MediaContainer?.friendlyName ?? '',
    webAppUrl: body.webAppUrl ?? settings.plex.webAppUrl,
    connected: true,
    signIn: body.signIn ?? settings.plex.signIn !== false,
  });
  return true;
};

/** Signing in to a Jellyfin or Emby server as one of its administrators. */
const adminLogin = async (
  kind: JellyfinFamilyKind,
  hostname: string,
  body: ConnectBody
) => {
  const client = new JellyfinAPI(hostname, undefined, OWNER_DEVICE_ID, kind);
  const account = await client.login(body.username, body.password);
  if (!account.User.Policy?.IsAdministrator) {
    throw new ApiError(403, ApiErrorCode.NotAdmin);
  }
  // An API key of Seerr's own, made with the administrator's sign-in.
  const apiKey = await new JellyfinAPI(
    hostname,
    account.AccessToken,
    OWNER_DEVICE_ID,
    kind
  ).createApiToken('Seerr');
  return {
    apiKey,
    serverId: account.User.ServerId,
    name: await client.getServerName(),
    admin: { id: account.User.Id, name: account.User.Name },
    authToken: account.AccessToken as string | null,
  };
};

/** An API key given by hand, and the administrator chosen to read as. */
const apiKeyAdmin = async (
  kind: JellyfinFamilyKind,
  hostname: string,
  body: ConnectBody
) => {
  const client = new JellyfinAPI(hostname, body.apiKey, undefined, kind);
  const info = await client.getSystemInfo();
  if (!info?.Id) {
    throw new ApiError(400, ApiErrorCode.InvalidUrl);
  }
  const admin = await client.getAccount(body.adminUserId ?? '');
  if (!admin?.Policy?.IsAdministrator || admin.Policy.IsDisabled) {
    throw new ApiError(403, ApiErrorCode.NotAdmin);
  }
  return {
    apiKey: body.apiKey as string,
    serverId: info.Id as string,
    name: (info.ServerName as string) ?? '',
    admin: { id: admin.Id, name: admin.Name },
    authToken: null,
  };
};

/** The address of a Jellyfin or Emby server from what was typed. */
const familyAddress = (body: ConnectBody) => ({
  ip: body.hostname ?? '',
  port: Number(body.port ?? 8096),
  useSsl: !!body.useSsl,
  urlBase: body.urlBase ?? '',
});

/*
 * Connecting Jellyfin or Emby: signing in as one of its administrators
 * (Seerr makes itself an API key), or an API key and the administrator to
 * read libraries as. "This is my account" links that administrator to the
 * owner. Libraries are then synced and chosen at /settings/{kind}/library.
 */
const connectJellyfinFamily = async (
  req: Request,
  kind: JellyfinFamilyKind,
  body: ConnectBody,
  next: NextFunction
): Promise<boolean> => {
  if (body.linkOwner && !isOwner(req)) {
    next({
      status: 403,
      message: 'Only the owner can link their own account.',
    });
    return false;
  }
  if (!body.hostname || !(body.username || (body.apiKey && body.adminUserId))) {
    next({
      status: 400,
      message:
        'A hostname, and an administrator to sign in as or an API key and administrator, are required.',
    });
    return false;
  }

  const address = familyAddress(body);
  const hostname = hostnameOf(address);
  let found;
  try {
    found = body.username
      ? await adminLogin(kind, hostname, body)
      : await apiKeyAdmin(kind, hostname, body);
  } catch (e) {
    next({
      status: e instanceof ApiError ? e.statusCode : 502,
      message:
        e instanceof ApiError ? e.errorCode : ApiErrorCode.ConnectionError,
    });
    return false;
  }

  const settings = getSettings();
  const other: JellyfinFamilyKind = kind === 'emby' ? 'jellyfin' : 'emby';
  if (
    settings[other].connected &&
    settings[other].serverId === found.serverId
  ) {
    next({
      status: 409,
      message: `This server is already connected as ${serverName(other)}.`,
    });
    return false;
  }

  if (body.linkOwner) {
    const holder = (await linkedJellyfinUsers([found.admin.id], kind)).get(
      normalizeJellyfinGuid(found.admin.id) ?? ''
    );
    if (holder && holder.id !== 1) {
      next({
        status: 409,
        message: `This ${serverName(kind)} account is already linked to someone else.`,
      });
      return false;
    }
    const userRepository = getRepository(User);
    const owner = await userRepository.findOneOrFail({
      where: { id: 1 },
      select: ['id', 'userType'],
    });
    await userRepository.update(1, {
      ...jellyfinAccountColumns(kind, {
        userId: found.admin.id,
        username: found.admin.name,
        deviceId: OWNER_DEVICE_ID,
        authToken: found.authToken,
      }),
      ...(owner.userType === UserType.LOCAL
        ? { userType: USER_TYPE[kind] }
        : {}),
    });
  }

  // Another server's libraries are not this one's.
  if (settings[kind].serverId && settings[kind].serverId !== found.serverId) {
    settings[kind].libraries = [];
    settings[kind].musicLibraries = [];
  }
  Object.assign(settings[kind], address, {
    externalHostname: body.externalHostname ?? settings[kind].externalHostname,
    apiKey: found.apiKey,
    serverId: found.serverId,
    name: found.name,
    adminUserId: found.admin.id,
    connected: true,
    signIn: body.signIn ?? settings[kind].signIn !== false,
  });
  return true;
};

mediaServerRoutes.post<{ kind: string }>(
  '/:kind/connect',
  async (req, res, next) => {
    const kind = kindParam(req);
    if (!kind) {
      return next({ status: 404, message: 'No such media server.' });
    }
    if (connectedServers().includes(kind)) {
      return next({
        status: 409,
        message: `${serverName(kind)} is already connected.`,
      });
    }
    try {
      const body = req.body as ConnectBody;
      const done =
        kind === 'plex'
          ? await connectPlex(req, body, next)
          : await connectJellyfinFamily(req, kind, body, next);
      if (!done) return;
      await connected(kind);
      return await listed(res);
    } catch (e) {
      return failed(next, e);
    }
  }
);

/*
 * The administrators of a Jellyfin or Emby server, for choosing whom Seerr
 * reads libraries as when it is connected with an API key.
 */
mediaServerRoutes.post<{ kind: string }>(
  '/:kind/admins',
  async (req, res, next) => {
    const kind = kindParam(req);
    if (!isJellyfinFamily(kind)) {
      return next({ status: 404, message: 'No such media server.' });
    }
    const body = req.body as ConnectBody;
    if (!body.hostname || !body.apiKey) {
      return next({
        status: 400,
        message: 'A hostname and an API key are required.',
      });
    }
    try {
      const accounts = await new JellyfinAPI(
        hostnameOf(familyAddress(body)),
        body.apiKey,
        undefined,
        kind
      ).getAccounts();
      return res
        .status(200)
        .json(
          accounts
            .filter(
              (account) =>
                account.Policy?.IsAdministrator && !account.Policy.IsDisabled
            )
            .map((account) => ({ id: account.Id, name: account.Name }))
        );
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      return next({
        status: status === 401 || status === 403 ? 401 : 502,
        message:
          status === 401 || status === 403
            ? ApiErrorCode.InvalidAuthToken
            : ApiErrorCode.ConnectionError,
      });
    }
  }
);

/** How many people removing this server would leave with fewer ways in. */
mediaServerRoutes.get<{ kind: string }>(
  '/:kind/removal',
  async (req, res, next) => {
    const kind = kindParam(req);
    if (!kind) {
      return next({ status: 404, message: 'No such media server.' });
    }
    try {
      return res.status(200).json(await removalImpact(kind));
    } catch (e) {
      return failed(next, e);
    }
  }
);

mediaServerRoutes.delete<{ kind: string }>('/:kind', async (req, res, next) => {
  const kind = kindParam(req);
  if (!kind) {
    return next({ status: 404, message: 'No such media server.' });
  }
  try {
    await removeServer(kind);
    return await listed(res);
  } catch (e) {
    return failed(next, e);
  }
});

mediaServerRoutes.post<{ kind: string }>(
  '/:kind/primary',
  async (req, res, next) => {
    const kind = kindParam(req);
    if (!kind) {
      return next({ status: 404, message: 'No such media server.' });
    }
    try {
      await makePrimary(kind);
      return await listed(res);
    } catch (e) {
      return failed(next, e);
    }
  }
);

mediaServerRoutes.post<{ kind: string }>(
  '/:kind/sign-in',
  async (req, res, next) => {
    const kind = kindParam(req);
    if (!kind) {
      return next({ status: 404, message: 'No such media server.' });
    }
    const { signIn } = req.body as { signIn?: unknown };
    if (typeof signIn !== 'boolean') {
      return next({ status: 400, message: 'signIn must be true or false.' });
    }
    try {
      await setSignIn(kind, signIn);
      return await listed(res);
    } catch (e) {
      return failed(next, e);
    }
  }
);

export default mediaServerRoutes;
