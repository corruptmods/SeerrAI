import SiloAPI, {
  SILO_REQUIRED_SCOPES,
  SiloError,
} from '@server/api/silo/client';
import { SiloIncompatibleError } from '@server/api/silo/compat';
import type {
  SiloAccount,
  SiloSystemInfo,
  SiloUserLibrary,
} from '@server/api/silo/types';
import { MEDIA_ID } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaLibraryItem from '@server/entity/MediaLibraryItem';
import SiloEpisode from '@server/entity/SiloEpisode';
import SiloPlay from '@server/entity/SiloPlay';
import { User } from '@server/entity/User';
import { refreshMediaServerJobs } from '@server/job/schedule';
import availabilitySync from '@server/lib/availabilitySync';
import cacheManager from '@server/lib/cache';
import matchWatch from '@server/lib/matchWatch';
import {
  MediaServerChangeError,
  signInWithout,
} from '@server/lib/mediaServerAdmin';
import { hostnameOf } from '@server/lib/mediaServers';
import {
  Permission,
  hasPermission,
  permissionsWithin,
} from '@server/lib/permissions';
import plexMatchCheck from '@server/lib/plexMatchCheck';
import { siloFullScanner, siloRecentScanner } from '@server/lib/scanners/silo';
import type {
  SiloOptionalScope,
  SiloResetPending,
  SiloSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { endSessions } from '@server/lib/signIn';
import {
  noteSiloResetMarked,
  siloDeviceId,
  siloLibraries,
} from '@server/lib/silo';
import { forgetSiloPictures } from '@server/lib/siloAccounts';
import { stopSiloHistory } from '@server/lib/siloHistory';
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

  // A different Silo than before: asked first, before any key is made. A
  // reset still pending is checked again, as saving now marks it afresh.
  const before = getSettings().silo;
  const different = await isDifferentSilo(serverId);
  if ((different || before.resetPending) && actingUserId !== undefined) {
    await refuseOwnerLockOut(actingUserId, !input.apiKey, {
      kept: !different && !!input.apiKey ? before.resetPending : undefined,
    });
    if (different && !confirmReset) {
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

/**
 * Whether the Silo with this id is a different one from the Silo links here
 * belong to: another id than the one saved, or, with none saved (settings
 * lost but the database kept), any link at all, as nothing then says which
 * Silo they name accounts on.
 */
const isDifferentSilo = async (serverId: string): Promise<boolean> => {
  const saved = getSettings().silo.serverId;
  if (saved) return saved !== serverId;
  return getRepository(User).exists({ where: { siloUserId: Not(IsNull()) } });
};

/** Said when connecting a different Silo than before reset its links. */
export const SILO_LINKS_RESET =
  "This is a different Silo from before, so every link to a Silo account was removed, along with what Seerr AI knew of the old Silo. People whose account here came from Silo, with no password and nothing beyond new users' permissions, are linked again if they sign in with Silo under the same username within 30 days; others link Silo again under Linked Accounts.";

/** What connecting a different Silo would remove. */
export interface SiloResetImpact {
  /** Users linked to a Silo account. */
  links: number;
  /** Plays in Seerr AI's copy of the old Silo's history. */
  plays: number;
  /** Titles with an id on the old Silo. */
  titles: number;
  /**
   * Linked users who sign in only with Silo, linked again when they next
   * sign in with Silo under the same username (see relinkableBySiloName).
   */
  relinked: number;
  /** Linked users left unable to sign in at all until given a password. */
  noSignIn: number;
  /**
   * No Silo was on record (settings lost, the database kept), so the
   * links can't be known to name this Silo's accounts.
   */
  unrecorded?: boolean;
}

/**
 * Connecting a different Silo would reset everything of the old one; the
 * admin confirms first (confirmReset). The message says what goes.
 */
export class SiloResetNeeded extends MediaServerChangeError {
  constructor(public readonly impact: SiloResetImpact) {
    const who = [
      impact.relinked
        ? ` ${impact.relinked} of them sign in only with Silo and are linked again if they sign in with the new Silo under the same username within ${SILO_RELINK_DAYS} days.`
        : '',
      impact.noSignIn
        ? ` ${impact.noSignIn} of them would be left unable to sign in until given a password.`
        : '',
    ].join('');
    super(
      409,
      `${
        impact.unrecorded
          ? "Seerr AI has no record of which Silo its users' Silo links belong to, so it treats this as a different Silo."
          : 'This is a different Silo from the one connected before.'
      } Connecting it removes every link to a Silo account (${impact.links}), Seerr AI's copy of the old Silo's watch history (${impact.plays} plays) and the old Silo's ids for ${impact.titles} titles.${who} Others link their Silo accounts again under Linked Accounts. Connect anyway?`
    );
  }
}

/** Who may change others' accounts here. */
const MANAGERS = [Permission.ADMIN, Permission.MANAGE_USERS];

/** How long an account a reset unlinked may be linked again by name. */
export const SILO_RELINK_DAYS = 30;

type RelinkFields = Pick<
  User,
  'id' | 'userType' | 'siloUsername' | 'permissions'
> & { password?: string | null };

/**
 * Whether an account a different Silo's reset unlinks may later be linked
 * again by its Silo name: its account came from Silo and kept the name, it
 * has no password, and it holds nothing beyond what new users get (never
 * the owner, an administrator or a user manager, whom a same-named stranger
 * must never become). Someone with another way to sign in (signInWithout)
 * links Silo again themselves, under Linked Accounts.
 */
const mayRelinkByName = (user: RelinkFields): boolean =>
  user.userType === UserType.SILO &&
  !user.password &&
  user.id !== 1 &&
  !hasPermission(MANAGERS, user.permissions, { type: 'or' }) &&
  permissionsWithin(user.permissions, getSettings().main.defaultPermissions) &&
  !!user.siloUsername;

/**
 * A Silo name as Silo tells names apart: case-insensitively (citext), in
 * any script, so compared here rather than with SQL's LOWER(), which
 * SQLite applies to ASCII letters only.
 */
export const siloNameKey = (name: string): string =>
  name.normalize('NFC').toLowerCase();

/**
 * Whether an unlinked account here may be linked to a Silo account of this
 * name when it signs in through Silo: only one a different Silo's reset
 * marked for it (siloRelinkUntil, for SILO_RELINK_DAYS) that still fits
 * mayRelinkByName.
 */
export const relinkableBySiloName = (
  user: RelinkFields & Pick<User, 'siloUserId' | 'siloRelinkUntil'>,
  username: string,
  now = Date.now()
): boolean =>
  !user.siloUserId &&
  !!user.siloRelinkUntil &&
  new Date(user.siloRelinkUntil).getTime() > now &&
  mayRelinkByName(user) &&
  siloNameKey(user.siloUsername ?? '') === siloNameKey(username);

/**
 * The account here a Silo account signing in may take back after a reset
 * (relinkableBySiloName, and still no other way to sign in), if exactly one
 * fits. Only for an account Silo just vouched for, on the Silo Seerr AI is
 * connected to.
 */
export const siloAccountToRelink = async (
  account: Pick<SiloAccount, 'username'>
): Promise<User | undefined> => {
  const found = await getRepository(User)
    .createQueryBuilder('user')
    .addSelect('user.password')
    .where('user.siloUserId IS NULL')
    .andWhere('user.userType = :type', { type: UserType.SILO })
    .andWhere('user.siloRelinkUntil IS NOT NULL')
    .andWhere('user.siloUsername IS NOT NULL')
    .getMany();
  const fits: User[] = [];
  for (const user of found) {
    if (
      relinkableBySiloName(user, account.username) &&
      !(await signInWithout('silo', user))
    ) {
      fits.push(user);
    }
  }
  return fits.length === 1 ? fits[0] : undefined;
};

const resetImpact = async (): Promise<SiloResetImpact> => {
  const media = getRepository(Media)
    .createQueryBuilder('media')
    .where(
      MEDIA_ID.silo.map((column) => `media.${column} IS NOT NULL`).join(' OR ')
    );
  const linked = await getRepository(User)
    .createQueryBuilder('user')
    .select([
      'user.id',
      'user.userType',
      'user.permissions',
      'user.plexId',
      'user.jellyfinUserId',
      'user.embyUserId',
      'user.siloUserId',
      'user.siloUsername',
    ])
    .addSelect('user.password')
    .where('user.siloUserId IS NOT NULL')
    .getMany();
  let relinked = 0;
  let noSignIn = 0;
  for (const user of linked) {
    if (await signInWithout('silo', user)) continue;
    // As the reset marks them (forgetPreviousSilo).
    if (mayRelinkByName(user)) {
      relinked += 1;
    } else {
      noSignIn += 1;
    }
  }
  return {
    ...(getSettings().silo.serverId ? {} : { unrecorded: true }),
    links: linked.length,
    plays: await getRepository(SiloPlay).count(),
    titles: await media.getCount(),
    relinked,
    noSignIn,
  };
};

/**
 * Refuses a reset that would leave the owner unable to sign in: an owner
 * linked to the old Silo with no other way in (another connected server
 * that allows sign-in, single sign-on, or a password), unless they are the
 * one connecting by signing in to the new Silo, which links them to it
 * again.
 */
const refuseOwnerLockOut = async (
  actingUserId: number,
  signingIn: boolean,
  {
    kept,
  }: {
    /** A pending reset's mark this connection keeps (see storeSilo). */
    kept?: SiloResetPending | null;
  } = {}
): Promise<void> => {
  if (actingUserId === 1 && signingIn) return;
  // The pending reset links the owner to the new Silo's account anyway.
  if (kept?.userId === 1 && kept.accountId) return;
  const owner = await getRepository(User)
    .createQueryBuilder('user')
    .select([
      'user.id',
      'user.plexId',
      'user.jellyfinUserId',
      'user.embyUserId',
      'user.siloUserId',
    ])
    .addSelect('user.password')
    .where('user.id = 1')
    .getOne();
  if (!owner?.siloUserId || (await signInWithout('silo', owner))) return;
  throw new MediaServerChangeError(
    409,
    actingUserId === 1
      ? "Connecting a different Silo would leave you unable to sign in: you can sign in only with the old Silo. Set a password for your account first (your profile's Password settings), then connect again."
      : "Connecting a different Silo would leave the owner unable to sign in: they can sign in only with the old Silo. The owner must set a password for their account first (their profile's Password settings)."
  );
};

/** Who is connecting, kept signed in and linked through a reset. */
export interface SiloResetActor {
  userId: number;
  /** Their session, which stays. */
  sessionId?: string;
  /** The new Silo's administrator they signed in as, linked to them. */
  account?: Pick<SiloAccount, 'id' | 'username'>;
}

/**
 * Forgets everything that belonged to the Silo connected before: Silo's
 * account ids are small numbers, so on another Silo account "2" is someone
 * else, and must never sign in as the person linked to the old one. Scans
 * and history reads under way stop first, so none writes an old id back.
 * Each user's Silo link goes (an account that came from Silo keeps the Silo
 * name, to be linked again by it: relinkableBySiloName), and sessions end
 * for those whose account came from Silo (keeping the connecting admin's own
 * session); the old Silo's title ids, episode list, play copy, library
 * places and Match Check findings go too. The connecting admin is linked to
 * the new Silo's administrator they signed in as. Returns how many users
 * were unlinked.
 */
export const forgetPreviousSilo = async (
  actor?: SiloResetActor
): Promise<number> => {
  // A history read under way stops before writing the old Silo's plays.
  stopSiloHistory();
  forgetSiloPictures();
  // So does a scan, before anything it would write is cleared.
  await Promise.all([siloFullScanner.stop(), siloRecentScanner.stop()]);
  const users = getRepository(User);
  const linked = await users
    .createQueryBuilder('user')
    .select([
      'user.id',
      'user.userType',
      'user.permissions',
      'user.plexId',
      'user.jellyfinUserId',
      'user.embyUserId',
      'user.siloUserId',
      'user.siloUsername',
    ])
    .addSelect('user.password')
    .where('user.siloUserId IS NOT NULL')
    .getMany();
  if (linked.length) {
    const fromSilo = linked.filter((user) => user.userType === UserType.SILO);
    const others = linked.filter((user) => user.userType !== UserType.SILO);
    // Who may be linked again by name, for a while (relinkableBySiloName).
    const byName: number[] = [];
    for (const user of fromSilo) {
      if (mayRelinkByName(user) && !(await signInWithout('silo', user))) {
        byName.push(user.id);
      }
    }
    const rest = fromSilo.filter((user) => !byName.includes(user.id));
    if (byName.length) {
      await users.update(
        { id: In(byName) },
        {
          siloUserId: null,
          siloProfileId: null,
          siloRelinkUntil: new Date(
            Date.now() + SILO_RELINK_DAYS * 24 * 60 * 60 * 1000
          ),
        }
      );
    }
    if (rest.length) {
      await users.update(
        { id: In(rest.map((user) => user.id)) },
        { siloUserId: null, siloProfileId: null, siloRelinkUntil: null }
      );
    }
    if (others.length) {
      await users.update(
        { id: In(others.map((user) => user.id)) },
        {
          siloUserId: null,
          siloUsername: null,
          siloProfileId: null,
          siloRelinkUntil: null,
        }
      );
    }
    for (const user of fromSilo) {
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
      siloRelinkUntil: null,
    });
  }
  const media = getRepository(Media);
  for (const column of MEDIA_ID.silo) {
    await media.update({ [column]: Not(IsNull()) }, { [column]: null });
  }
  await getRepository(MediaLibraryItem).delete({ server: 'silo' });
  await getRepository(SiloEpisode).clear();
  await getRepository(SiloPlay).clear();
  await plexMatchCheck.dropServer('Silo');
  await matchWatch.dropServer('Silo');
  // Who may see which of the old Silo's libraries no longer holds.
  cacheManager.getCache('libraryaccess').flush();
  // Scans start again on the new Silo's schedule.
  refreshMediaServerJobs();
  // Titles only the old Silo had are no longer available.
  availabilitySync.runSoon().catch((e) =>
    logger.error('Availability sync after replacing Silo failed', {
      label: 'Silo',
      errorMessage: e instanceof Error ? e.message : String(e),
    })
  );
  return linked.length;
};

let finishing: Promise<boolean> | undefined;

/**
 * Finishes a different Silo's reset once its connection is saved with
 * settings.silo.resetPending: forgets the old one (forgetPreviousSilo),
 * keeping who connected it linked and, with `sessionId`, signed in; then
 * clears the mark, so Silo is used again. Until then nothing signs in or is
 * read through Silo. Run by whatever connected it, and again at startup and
 * by the Silo history job if it failed or Seerr AI stopped part-way. Never
 * throws: a failure is logged and the reset stays pending. Resolves whether
 * no reset is pending any more.
 */
export const finishSiloReset = (
  keep: { sessionId?: string } = {}
): Promise<boolean> => {
  // One at a time; a call meanwhile runs after, for a reset begun since.
  if (finishing) {
    return finishing.then(() => finishSiloReset(keep));
  }
  const promise = (async () => {
    const settings = getSettings();
    if (!settings.silo.resetPending) return true;
    try {
      // Only a mark that is saved: whoever set one whose save then failed
      // puts the old Silo back (settings.restore), and the old Silo's links
      // must not be forgotten meanwhile.
      await settings.save();
      const pending = settings.silo.resetPending;
      if (!pending) return true;
      const unlinked = await forgetPreviousSilo(
        pending.userId
          ? {
              userId: pending.userId,
              sessionId: keep.sessionId,
              account: pending.accountId
                ? {
                    id: pending.accountId,
                    username: pending.accountUsername ?? '',
                  }
                : undefined,
            }
          : undefined
      );
      // A reset begun again meanwhile is finished by its own call.
      if (settings.silo.resetPending === pending) {
        settings.silo.resetPending = null;
        await settings.save();
      }
      logger.warn(
        'Connected a different Silo than before; links to the old one were removed',
        { label: 'Silo', unlinked }
      );
    } catch (e) {
      logger.error(
        "Couldn't finish forgetting the Silo connected before; Silo stays unused until it is, and Seerr AI tries again shortly",
        {
          label: 'Silo',
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
    return !settings.silo.resetPending;
  })();
  finishing = promise;
  return promise.finally(() => {
    if (finishing === promise) finishing = undefined;
  });
};

/**
 * Stores a working connection in the Silo settings (the caller saves), and
 * reads Silo's film and series libraries. A different Silo than before
 * starts with no libraries chosen, and is marked resetPending, with `by`
 * (who connected it), in the same change as the new connection: until
 * finishSiloReset has forgotten the old one, nothing signs in or is read
 * through Silo. `reset` then says so, and the caller, once everything is
 * saved, calls finishSiloReset.
 *
 * The new settings replace the old in one step, after Silo is read; if
 * saving them then fails, the caller puts `previous` back with
 * settings.restore, so no part of the new connection (its reset mark above
 * all) stays behind against the old Silo.
 */
export const storeSilo = async (
  input: SiloConnectInput & {
    externalHostname?: string;
    forgotPasswordUrl?: string;
  },
  connection: SiloConnection,
  {
    connect,
    by,
  }: {
    connect: boolean;
    /** Who is connecting; the account defaults to the one signed in as. */
    by?: { userId?: number; account?: Pick<SiloAccount, 'id' | 'username'> };
  }
): Promise<{ silo: SiloSettings; previous: SiloSettings; reset?: string }> => {
  let found: SiloUserLibrary[] | undefined;
  try {
    found = await new SiloAPI(
      hostnameOf(siloAddressOf(input)),
      connection.apiKey
    ).getUserLibraries();
  } catch {
    // Libraries can be read again from Settings → Silo.
  }
  const different = await isDifferentSilo(connection.serverId);
  const settings = getSettings();
  const previous = settings.silo;
  const silo: SiloSettings = structuredClone(previous);
  let reset: string | undefined;
  if (different || silo.resetPending) {
    silo.libraries = [];
    silo.keyId = '';
    // The old Silo's play history copy goes; the new one is read in full.
    silo.historyCopiedTo = '';
    const account = by?.account ?? connection.admin;
    const marked: SiloResetPending = {
      ...(by?.userId ? { userId: by.userId } : {}),
      ...(by?.userId && account
        ? { accountId: account.id, accountUsername: account.username }
        : {}),
    };
    // Saved again while this same Silo's reset is pending: whoever it keeps
    // linked stays so, unless this connection signs someone in to replace
    // them (refuseOwnerLockOut was asked first).
    const pendingHere =
      silo.resetPending && silo.serverId === connection.serverId
        ? silo.resetPending
        : undefined;
    silo.resetPending =
      pendingHere && !marked.accountId
        ? { ...pendingHere, userId: pendingHere.userId ?? marked.userId }
        : marked;
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
  if (found) {
    silo.libraries = siloLibraries(found, silo.libraries);
  }
  // Answers from the old Silo still on their way are dropped (siloEpoch).
  if (reset) noteSiloResetMarked();
  settings.restore('silo', silo);
  return { silo, previous, reset };
};
