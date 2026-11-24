import SiloAPI, {
  SILO_REQUIRED_SCOPES,
  SiloError,
} from '@server/api/silo/client';
import { SiloIncompatibleError } from '@server/api/silo/compat';
import type { SiloAccount, SiloSystemInfo } from '@server/api/silo/types';
import { MediaServerChangeError } from '@server/lib/mediaServerAdmin';
import { hostnameOf } from '@server/lib/mediaServers';
import type { SiloOptionalScope, SiloSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { siloDeviceId, siloLibraries } from '@server/lib/silo';

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
}

const KEY_LABEL = 'Seerr AI';

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
 * key is deleted again so no unused "Seerr AI" key is left behind.
 */
const createKey = async <T>(
  client: SiloAPI,
  username: string,
  password: string,
  check: (key: string) => Promise<T>
): Promise<{ key: string; admin: SiloAccount; checked: T }> => {
  let tokens;
  try {
    tokens = await client.login(username, password, siloDeviceId());
  } catch (e) {
    throw refusal(
      e,
      e instanceof SiloError && e.status === 401
        ? "Silo didn't accept that username and password."
        : undefined
    );
  }
  try {
    if (tokens.user.role !== 'admin') {
      throw new MediaServerChangeError(
        403,
        'Sign in with a Silo administrator account.'
      );
    }
    let created;
    try {
      created = await client.createApiKey(tokens.access_token, {
        label: KEY_LABEL,
        scopes: [...SILO_REQUIRED_SCOPES],
      });
    } catch (e) {
      throw keyRefusal(e);
    }
    try {
      return {
        key: created.key,
        admin: tokens.user,
        checked: await check(created.key),
      };
    } catch (e) {
      await client.deleteApiKey(tokens.access_token, created.id);
      throw e;
    }
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
  input: SiloConnectInput
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

  if (input.apiKey) {
    const apiKey = input.apiKey.trim();
    const { probe, name } = await probeKey(hostname, apiKey);
    return { apiKey, serverId, name, info, optionalScopes: probe.optional };
  }
  const made = await createKey(
    open,
    input.username ?? '',
    input.password ?? '',
    (key) => probeKey(hostname, key)
  );
  return {
    apiKey: made.key,
    serverId,
    name: made.checked.name,
    info,
    optionalScopes: made.checked.probe.optional,
    admin: made.admin,
  };
};

/**
 * Stores a working connection in the Silo settings (the caller saves), and
 * reads Silo's film and series libraries. A different Silo than before
 * starts with no libraries chosen.
 */
export const storeSilo = async (
  input: SiloConnectInput & {
    externalHostname?: string;
    forgotPasswordUrl?: string;
  },
  connection: SiloConnection,
  { connect }: { connect: boolean }
): Promise<SiloSettings> => {
  const silo = getSettings().silo;
  if (silo.serverId && silo.serverId !== connection.serverId) {
    silo.libraries = [];
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
  return silo;
};
