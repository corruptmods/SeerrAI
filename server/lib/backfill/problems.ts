import {
  IndexerLimitReached,
  limitMessage,
  limitOf,
} from '@server/lib/backfill/indexerLimit';
import { getSettings } from '@server/lib/settings';
import { isAxiosError } from 'axios';

/*
 * What went wrong for Backfill, in plain words, and what kind of problem
 * it is: an app out of reach is waited out, and only a problem with the
 * release itself marks the release dead.
 */

/** An error's message, or what was thrown as text. */
export const message = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

/** Failures of the network itself: nothing answered, or not in time. */
const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_NETWORK',
]);

/**
 * Whether an error says only that Sonarr, Radarr or the download client
 * could not be reached for now: no answer at all, or a proxy in front of it
 * saying it is down. A job waits that out rather than counting it towards
 * giving up, since nothing is wrong with the download itself.
 */
export const isUnreachable = (e: unknown, depth = 0): boolean => {
  if (!e || typeof e !== 'object' || depth > 3) return false;
  if (isAxiosError(e) && e.response) {
    return [502, 503, 504].includes(e.response.status);
  }
  const { code, cause } = e as { code?: unknown; cause?: unknown };
  // Sonarr's and Radarr's own calls wrap what went wrong as the cause.
  return UNREACHABLE.has(String(code ?? '')) || isUnreachable(cause, depth + 1);
};

/** The HTTP request an error came from, looking into what it wraps. */
export const requestOf = (
  e: unknown,
  depth = 0
): { status?: number; url?: URL } | null => {
  if (!e || typeof e !== 'object' || depth > 3) return null;
  if (isAxiosError(e)) {
    let url: URL | undefined;
    try {
      url = new URL(e.config?.url ?? '', e.config?.baseURL);
    } catch {
      url = undefined;
    }
    return { status: e.response?.status, url };
  }
  return requestOf((e as { cause?: unknown }).cause, depth + 1);
};

/**
 * Which of the apps Backfill talks to an error came from, by the address
 * it was asking: "Sonarr", "SABnzbd", "Prowlarr".
 */
const appAsked = (e: unknown): string | undefined => {
  const url = requestOf(e)?.url;
  if (!url) return undefined;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const settings = getSettings();
  const at = (s: { hostname: string; port: number }) =>
    s.hostname.toLowerCase() === url.hostname.toLowerCase() &&
    Number(s.port) === port;
  if (at(settings.backfill.prowlarr)) return 'Prowlarr';
  return [
    ...settings.sonarr,
    ...settings.radarr,
    ...settings.lidarr,
    ...settings.downloadClients,
  ].find(at)?.name;
};

/**
 * A problem put in plain words already, carrying what came in as its
 * cause for the server's log.
 */
export class SaidPlainly extends Error {}

/**
 * What went wrong, in plain words, for the cases met often: a limit
 * reached, an app not answering, an API key refused. Anything else is
 * said as it came. `indexer` is the indexer a release was being fetched
 * from, when it was.
 */
export const plainProblem = (e: unknown, indexer?: string): string => {
  if (e instanceof IndexerLimitReached || e instanceof SaidPlainly) {
    return e.message;
  }
  if (limitOf(e)) {
    return limitMessage(indexer ?? appAsked(e) ?? 'The indexer', 'download');
  }
  if (isUnreachable(e)) {
    return `${appAsked(e) ?? 'An app Backfill uses'} did not answer`;
  }
  const status = requestOf(e)?.status;
  if (status === 401 || status === 403) {
    return `${indexer ?? appAsked(e) ?? 'An app Backfill uses'} refused the API key`;
  }
  return message(e);
};

/**
 * Something wrong with the release itself rather than with Seerr, the apps
 * or the download client: only then is it marked dead when its job gives up.
 */
export class ReleaseProblem extends Error {}

/**
 * A Usenet post in archives, or with scrambled file names: its files
 * cannot be listed before it is downloaded.
 */
export class PackedRelease extends Error {
  constructor(public readonly packing: 'archives' | 'scrambled') {
    super(
      packing === 'archives'
        ? 'Packed in archives, so its files cannot be checked'
        : 'Its file names are scrambled (only its repair files are named), so its files cannot be checked'
    );
  }
}
