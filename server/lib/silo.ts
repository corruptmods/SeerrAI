import SiloAPI from '@server/api/silo/client';
import { contractChanged } from '@server/api/silo/compat';
import type {
  SiloCatalogVersion,
  SiloSystemInfo,
  SiloUserLibrary,
} from '@server/api/silo/types';
import { siloResolutionHeight } from '@server/lib/mediaQuality';
import { hostnameFor } from '@server/lib/mediaServers';
import type {
  Library,
  SiloOptionalScope,
  SiloSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * Seerr AI's side of Silo: its settings, a client with the saved key, and how
 * Silo's libraries and files map onto Seerr's. Silo's API itself is only
 * spoken in server/api/silo.
 */

export const siloSettings = (): SiloSettings => getSettings().silo;

/** Whether Seerr AI's key was found to hold an optional scope. */
export const siloHasScope = (scope: SiloOptionalScope): boolean =>
  (siloSettings().optionalScopes ?? []).includes(scope);

/** Why library sharing and switching accounts off are unavailable. */
export const SILO_NEEDS_USERS_SCOPE =
  "Seerr AI's Silo key lacks the admin:users scope, so Silo accounts can't be changed from here. In Silo, make a key with it, then paste it under Settings → Silo.";

/** Why Match Check and Match Watch skip Silo. */
export const SILO_NEEDS_PATHS_SCOPE =
  "Silo isn't checked: Seerr AI's Silo key lacks the admin:catalog:paths scope it needs to see each title's folder. In Silo, make a key with it, then paste it under Settings → Silo.";

/**
 * A different Silo was connected and the old one's links aren't all gone
 * yet (settings.silo.resetPending): nobody signs in, links or is matched
 * through Silo until they are.
 */
export const siloResetPending = (): boolean => !!siloSettings().resetPending;

/** Why Silo is refused while a different Silo's reset finishes. */
export const SILO_RESETTING =
  'A different Silo was just connected, and Seerr AI is still forgetting the old one. Try again in a moment.';

/** A client for the connected Silo, with its saved key. */
export const siloClient = (options?: { timeout?: number }): SiloAPI =>
  new SiloAPI(hostnameFor('silo'), siloSettings().apiKey, options);

/**
 * Keeps the build and contract digest Silo reported, logging once when the
 * contract changes. Saves only on change.
 */
export const recordSiloInfo = async (info: SiloSystemInfo): Promise<void> => {
  const settings = getSettings();
  const silo = settings.silo;
  if (contractChanged(silo.contractDigest, info)) {
    logger.info(
      'Silo now publishes a different API contract; Seerr AI keeps reading what it knows',
      {
        label: 'Silo',
        serverVersion: info.server_version,
        apiMajor: info.api_major,
      }
    );
  }
  if (
    silo.serverVersion === info.server_version &&
    silo.contractDigest === info.contract_digest
  ) {
    return;
  }
  silo.serverVersion = info.server_version;
  silo.contractDigest = info.contract_digest;
  await settings.save();
};

/**
 * The Seerr library type of a Silo library, by Silo's own vocabulary; none
 * for books, podcasts, manga and anything else Seerr doesn't request.
 */
export const siloLibraryType = (type: string): Library['type'] | undefined => {
  switch (type.trim().toLowerCase()) {
    case 'movie':
    case 'movies':
      return 'movie';
    case 'series':
    case 'tv':
    case 'show':
    case 'tvshows':
      return 'show';
    case 'mixed':
      return 'mixed';
    default:
      return undefined;
  }
};

/**
 * Silo's film and series libraries as Seerr keeps them, sorted as Silo sorts
 * them; each keeps its on/off switch and last scan from `existing`.
 */
export const siloLibraries = (
  found: SiloUserLibrary[],
  existing: Library[]
): Library[] =>
  [...found]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .flatMap((library) => {
      const type = siloLibraryType(library.type ?? '');
      if (!type) return [];
      const saved = existing.find((l) => l.id === library.id);
      return [
        {
          id: library.id,
          name: library.name,
          enabled: saved?.enabled ?? false,
          type,
          lastScan: saved?.lastScan,
        },
      ];
    });

/** Whether a Silo file is 4K: 2160 lines or more. */
export const isSilo4k = (version: Pick<SiloCatalogVersion, 'resolution'>) =>
  siloResolutionHeight(version.resolution) >= 2160;

/**
 * The device id Seerr AI signs in to Silo with: the same on every sign-in, so
 * Silo lists one device for it.
 */
export const siloDeviceId = (): string => `seerr-ai-${getSettings().clientId}`;
