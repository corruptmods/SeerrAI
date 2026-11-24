import SiloAPI from '@server/api/silo/client';
import { contractChanged } from '@server/api/silo/compat';
import type {
  SiloCatalogVersion,
  SiloSystemInfo,
  SiloUserLibrary,
} from '@server/api/silo/types';
import { siloResolutionHeight } from '@server/lib/mediaQuality';
import { hostnameFor } from '@server/lib/mediaServers';
import type { Library, SiloSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * Seerr AI's side of Silo: its settings, a client with the saved key, and how
 * Silo's libraries and files map onto Seerr's. Silo's API itself is only
 * spoken in server/api/silo.
 */

export const siloSettings = (): SiloSettings => getSettings().silo;

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
