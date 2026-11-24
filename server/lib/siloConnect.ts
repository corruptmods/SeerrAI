import SiloAPI, {
  SILO_REQUIRED_SCOPES,
  SiloError,
} from '@server/api/silo/client';
import { SiloIncompatibleError } from '@server/api/silo/compat';
import type { SiloAccount, SiloSystemInfo } from '@server/api/silo/types';
import { MEDIA_ID } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaLibraryItem from '@server/entity/MediaLibraryItem';
import SiloEpisode from '@server/entity/SiloEpisode';
import SiloPlay from '@server/entity/SiloPlay';
import { User } from '@server/entity/User';
import { MediaServerChangeError } from '@server/lib/mediaServerAdmin';
import { hostnameOf } from '@server/lib/mediaServers';
import type { SiloOptionalScope, SiloSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { endSessions } from '@server/lib/signIn';
import { siloDeviceId, siloLibraries } from '@server/lib/silo';
import logger from '@server/logger';
import { In, IsNull, Not } from 'typeorm';

/*
 * Connecting Silo: with an administrator's API key pasted in, or by signing
 * in as an administrator once so Seerr AI can create its own key. Either way
 * the key is tried on what Seerr AI reads, and the scopes it lacks are named.
 */

/** Silo's address as entered on the connect form or settings page. */
export interface SiloAddress {
  hostname?: string;
  port?: number;
  useSsl?: boolean;
  urlBase?: string;
}

/** What connecting needs: an address, and a key or an administrator. */
export interface SiloConnectInput extends SiloAddress {
  apiKey?: string;
  username?: string;
  password?: string;
}

/** What a working connection found. */
export interface SiloConnection {
  apiKey: string;
  serverId: string;
  name: string;
  info: SiloSystemInfo;
  optionalScopes: SiloOptionalScope[];
  /** The administrator who signed in to create the key, when one did. */
  admin?: SiloAccount;
  /** Silo's id for the key, when Seerr AI made it. */
  keyId?: string;
}

const KEY_LABEL = 'Seerr AI';

/** Refusals sign-in at setup tells apart. */
export const SILO_NOT_ADMIN = 'Sign in with a Silo administrator account.';
export const SILO_BAD_PASSWORD =
  "Silo didn't accept that username and password.";

export const siloAddressOf = (input: SiloAddress) => ({
  ip: (input.hostname ?? '').trim(),
  port: Number(input.port || 8090),
  useSsl: !!input.useSsl,
  urlBase: (input.urlBase ?? '').trim().replace(/\/+$/, ''),
});

/** A Silo failure as a refusal with a status and a plain message. */
const refusal = (e: unknown, fallback?: string): MediaServerChangeError => {
  if (e instanceof MediaServerChangeError) return e;
  if (e instanceof SiloIncompatibleError) {
    return new MediaServerChangeError(400, e.message);
  }
  if (e instanceof SiloError) {
    const status =
      e.status === 0 || e.status >= 500
        ? 502
        : e.status === 404
          ? 400
          : e.status;
    return new MediaServerChangeError(status, fallback ?? e.message);
  }
  return new MediaServerChangeError(
    502,
    "Seerr AI couldn't reach Silo at that address."
  );
};

/**
 * Signs in as an administrator once and creates Seerr AI's own key, with the
 * required scopes only (the optional ones come with a pasted key that has
 * them). `check` tries the new key while still signed in; if it fails, the
 * key is deleted again so no unused "Seerr AI" key is left behind. `vet`
 * refuses an administrator before any key is made; `previousKeyId`, a key
 * Seerr AI made on this Silo before, is deleted once the new one works.
 */
const createKey = async <T>(
  client: SiloAPI,
  username: string,
  password: string,
  check: (key: string, keyId: string, admin: SiloAccount) => Promise<T>,
  {
    vet,
    previousKeyId,
  }: {
    vet?: (admin: SiloAccount) => Promise<void>;
    previousKeyId?: string;
  } = {}
): Promise<{ key: string; keyId: string; admin: SiloAccount; checked: T }> => {
  let tokens;
  try {
    tokens = await client.login(username, password, siloDeviceId());
  } catch (e) {
    throw refusal(
      e,
      e instanceof SiloError && e.status === 401 ? SILO_BAD_PASSWORD : undefined
    );
  }
  try {
    if (tokens.user.role !== 'admin') {
      throw new MediaServerChangeError(403, SILO_NOT_ADMIN);
    }
    await vet?.(tokens.user);
    let created;
    try {
      created = await client.createApiKey(tokens.access_token, {
        label: KEY_LABEL,
        scopes: [...SILO_REQUIRED_SCOPES],
      });
    } catch (e) {
      throw keyRefusal(e);
    }
    let checked: T;
    try {
      checked = await check(created.key, created.id, tokens.user);
    } catch (e) {
      await client.deleteApiKey(tokens.access_token, created.id);
      throw e;
    }
    // The key it replaces would otherwise stay in Silo unused.
    if (previousKeyId && previousKeyId !== created.id) {
      await client.deleteApiKey(tokens.access_token, previousKeyId);
    }
    return { key: created.key, keyId: created.id, admin: tokens.user, checked };
  } finally {
    await client.logout(tokens.access_token);
  }
};

/** Why Silo wouldn't create a key. */
const keyRefusal = (e: unknown): MediaServerChangeError => {
  if (e instanceof SiloError && e.status === 403) {
    return new MediaServerChangeError(
      403,
      e.code === 'password_change_required'
        ? e.message
        : "Silo didn't let this sign-in create an API key. In Silo, create a key with the admin:monitor:read and libraries:read scopes and paste it here instead."
    );
  }
  return refusal(e);
};

/** What Seerr AI can do with a key; throws a plain refusal if not enough. */
const probeKey = async (hostname: string, apiKey: string) => {
  const keyed = new SiloAPI(hostname, apiKey, { timeout: 15_000 });
  let probe;
  try {
    probe = await keyed.probeScopes();
  } catch (e) {
    throw refusal(
      e,
      e instanceof SiloError && e.status === 401
        ? "Silo didn't accept this API key."
        : undefined
    );
  }
  if (probe.missing.length) {
    throw new MediaServerChangeError(
      403,
      `This API key can't read what Seerr AI needs. It needs the ${probe.missing.join(
        ' and '
      )} scope${probe.missing.length > 1 ? 's' : ''}, and must belong to a Silo administrator.`
    );
  }
  return { probe, name: (await keyed.getServerName()) || 'Silo' };
};

/**
 * Checks Silo at this address and the key (or creates one), without saving.
 * Throws MediaServerChangeError with a message people can act on.
 */
export const trySilo = async (
  input: SiloConnectInput,
  {
    vet,
    confirmReset,
    actingUserId,
    whileSignedIn,
  }: {
    /**
     * Refuses the administrator signing in before a key is made (or, with a
     * pasted key, the caller checks first).
     */
    vet?: (admin: SiloAccount) => Promise<void>;
    /**
     * The admin agreed that a different Silo than before resets everything
     * of the old one; without it, SiloResetNeeded is thrown first.
     */
    confirmReset?: boolean;
    /** The Seerr AI admin connecting, checked against owner lock-out. */
    actingUserId?: number;
    /**
     * Saves the connection. With a sign-in it runs while still signed in,
     * so a failure deletes the key just made before signing out.
     */
    whileSignedIn?: (connection: SiloConnection) => Promise<void>;
  } = {}
): Promise<SiloConnection> => {
  const address = siloAddressOf(input);
  if (!address.ip) {
    throw new MediaServerChangeError(400, "Enter Silo's address.");
  }
  if (!input.apiKey && !(input.username && input.password)) {
    throw new MediaServerChangeError(
      400,
      "Enter an API key, or a Silo administrator's username and password."
    );
  }
  const hostname = hostnameOf(address);
  const open = new SiloAPI(hostname, undefined, { timeout: 15_000 });
  let info: SiloSystemInfo;
  let serverId: string;
  try {
    info = await open.getCompatibleInfo();
    serverId = (await open.getIdentity()).server_id;
  } catch (e) {
    throw refusal(
      e,
      e instanceof SiloError && (e.status === 404 || e.status === 0)
        ? "Seerr AI couldn't find Silo at that address. Check the address, port and URL base."
        : undefined
    );
  }

  // A different Silo than before: asked first, before any key is made.
  const previous = getSettings().silo.serverId;
  if (previous && previous !== serverId && actingUserId !== undefined) {
    await refuseOwnerLockOut(actingUserId, !input.apiKey);
    if (!confirmReset) {
      throw new SiloResetNeeded(await resetImpact());
    }
  }

  if (input.apiKey) {
    const apiKey = input.apiKey.trim();
    const { probe, name } = await probeKey(hostname, apiKey);
    const connection: SiloConnection = {
      apiKey,
      serverId,
      name,
      info,
      optionalScopes: probe.optional,
    };
    await whileSignedIn?.(connection);
    return connection;
  }
  const saved = getSettings().silo;
  const made = await createKey(
    open,
    input.username ?? '',
    input.password ?? '',
    async (key, keyId, admin) => {
      const { probe, name } = await probeKey(hostname, key);
      const connection: SiloConnection = {
        apiKey: key,
        keyId,
        serverId,
        name,
        info,
        optionalScopes: probe.optional,
        admin,
      };
      await whileSignedIn?.(connection);
      return connection;
    },
    {
      vet,
      // Only a key Seerr AI made on this same Silo.
      previousKeyId:
        saved.serverId === serverId && saved.keyId ? saved.keyId : undefined,
    }
  );
  return made.checked;
};

/** Said when connecting a different Silo than before reset its links. */
export const SILO_LINKS_RESET =
  'This is a different Silo from before, so every link to a Silo account was removed, along with what Seerr AI knew of the old Silo. People link their Silo accounts again under Linked Accounts.';

/** What connecting a different Silo would remove. */
export interface SiloResetImpact {
  /** Users linked to a Silo account. */
  links: number;
  /** Plays in Seerr AI's copy of the old Silo's history. */
  plays: number;
  /** Titles with an id on the old Silo. */
  titles: number;
}

/**
 * Connecting a different Silo would reset everything of the old one; the
 * admin confirms first (confirmReset). The message says what goes.
 */
export class SiloResetNeeded extends MediaServerChangeError {
  constructor(public readonly impact: SiloResetImpact) {
    super(
      409,
      `This is a different Silo from the one connected before. Connecting it removes every link to a Silo account (${impact.links}), Seerr AI's copy of the old Silo's watch history (${impact.plays} plays) and the old Silo's ids for ${impact.titles} titles. People then link their Silo accounts again. Connect anyway?`
    );
  }
}

const resetImpact = async (): Promise<SiloResetImpact> => {
  const media = getRepository(Media)
    .createQueryBuilder('media')
    .where(
      MEDIA_ID.silo.map((column) => `media.${column} IS NOT NULL`).join(' OR ')
    );
  return {
    links: await getRepository(User).count({
      where: { siloUserId: Not(IsNull()) },
    }),
    plays: await getRepository(SiloPlay).count(),
    titles: await media.getCount(),
  };
};

/**
 * Refuses a reset that would leave the owner unable to sign in: an owner
 * who signs in only with the old Silo (no password, no other server), unless
 * they are the one connecting by signing in to the new Silo, which links
 * them to it again.
 */
const refuseOwnerLockOut = async (
  actingUserId: number,
  signingIn: boolean
): Promise<void> => {
  if (actingUserId === 1 && signingIn) return;
  const owner = await getRepository(User)
    .createQueryBuilder('user')
    .addSelect('user.password')
    .where('user.id = 1')
    .getOne();
  if (
    owner?.siloUserId &&
    owner.userType === UserType.SILO &&
    !owner.password &&
    !owner.plexId &&
    !owner.jellyfinUserId &&
    !owner.embyUserId
  ) {
    throw new MediaServerChangeError(
      409,
      actingUserId === 1
        ? 'Connecting a different Silo would leave you unable to sign in: your account signs in only with the old Silo. Connect by signing in with your new Silo administrator account instead of a key, or set a password for your account first.'
        : 'Connecting a different Silo would leave the owner unable to sign in: their account signs in only with the old Silo. The owner can connect it by signing in to the new Silo, or set a password for their account first.'
    );
  }
};

/** Who is connecting, kept signed in and linked through a reset. */
export interface SiloResetActor {
  userId: number;
  /** Their session, which stays. */
  sessionId?: string;
  /** The new Silo's administrator they signed in as, linked to them. */
  account?: SiloAccount;
}

/**
 * Forgets everything that belonged to the Silo connected before: Silo's
 * account ids are small numbers, so on another Silo account "2" is someone
 * else, and must never sign in as the person linked to the old one. Each
 * user's Silo link goes, and sessions end for those whose account came from
 * Silo (keeping the connecting admin's own session); the old Silo's title
 * ids, episode list, play copy and library places go too. The connecting
 * admin is linked to the new Silo's administrator they signed in as.
 * Returns how many users were unlinked.
 */
export const forgetPreviousSilo = async (
  actor?: SiloResetActor
): Promise<number> => {
  const users = getRepository(User);
  const linked = await users.find({
    select: { id: true, userType: true },
    where: { siloUserId: Not(IsNull()) },
  });
  if (linked.length) {
    await users.update(
      { id: In(linked.map((user) => user.id)) },
      { siloUserId: null, siloUsername: null, siloProfileId: null }
    );
    for (const user of linked) {
      if (user.userType !== UserType.SILO) continue;
      await endSessions(
        user.id,
        user.id === actor?.userId ? actor.sessionId : undefined
      );
    }
  }
  if (actor?.account) {
    await users.update(actor.userId, {
      siloUserId: actor.account.id,
      siloUsername: actor.account.username,
      siloProfileId: null,
    });
  }
  const media = getRepository(Media);
  for (const column of MEDIA_ID.silo) {
    await media.update({ [column]: Not(IsNull()) }, { [column]: null });
  }
  await getRepository(MediaLibraryItem).delete({ server: 'silo' });
  await getRepository(SiloEpisode).clear();
  await getRepository(SiloPlay).clear();
  return linked.length;
};

/**
 * After a different Silo's settings are saved: forgets the old one, keeping
 * the connecting admin signed in and linking them to the administrator they
 * signed in to the new Silo as, if they did.
 */
export const resetToNewSilo = async (
  connection: SiloConnection,
  by?: { userId?: number; sessionId?: string; account?: SiloAccount }
): Promise<void> => {
  const unlinked = await forgetPreviousSilo(
    by?.userId
      ? {
          userId: by.userId,
          sessionId: by.sessionId,
          account: by.account ?? connection.admin,
        }
      : undefined
  );
  logger.warn(
    'Connected a different Silo than before; links to the old one were removed',
    { label: 'Silo', unlinked }
  );
};

/**
 * Stores a working connection in the Silo settings (the caller saves), and
 * reads Silo's film and series libraries. A different Silo than before
 * starts with no libraries chosen; `reset` then says so, and the caller,
 * once everything is saved, forgets the old one (forgetPreviousSilo), so a
 * failure on the way leaves nothing half done.
 */
export const storeSilo = async (
  input: SiloConnectInput & {
    externalHostname?: string;
    forgotPasswordUrl?: string;
  },
  connection: SiloConnection,
  { connect }: { connect: boolean }
): Promise<{ silo: SiloSettings; reset?: string }> => {
  const silo = getSettings().silo;
  let reset: string | undefined;
  if (silo.serverId && silo.serverId !== connection.serverId) {
    silo.libraries = [];
    silo.keyId = '';
    reset = SILO_LINKS_RESET;
  }
  Object.assign(silo, siloAddressOf(input), {
    externalHostname: (
      input.externalHostname ??
      silo.externalHostname ??
      ''
    ).trim(),
    forgotPasswordUrl: (
      input.forgotPasswordUrl ??
      silo.forgotPasswordUrl ??
      ''
    ).trim(),
    apiKey: connection.apiKey,
    // A pasted key keeps the record of one Seerr AI made, to delete it on
    // the next sign-in.
    ...(connection.keyId ? { keyId: connection.keyId } : {}),
    serverId: connection.serverId,
    name: connection.name,
    serverVersion: connection.info.server_version,
    contractDigest: connection.info.contract_digest,
    optionalScopes: connection.optionalScopes,
    musicLibraries: [],
    ...(connect ? { connected: true } : {}),
  });
  try {
    const keyed = new SiloAPI(
      hostnameOf(siloAddressOf(input)),
      connection.apiKey
    );
    silo.libraries = siloLibraries(
      await keyed.getUserLibraries(),
      silo.libraries
    );
  } catch {
    // Libraries can be read again from Settings → Silo.
  }
  return { silo, reset };
};
