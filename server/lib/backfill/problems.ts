import {
  IndexerLimitReached,
  limitMessage,
  limitOf,
} from '@server/lib/backfill/indexerLimit';
import { getSettings } from '@server/lib/settings';
import { isAxiosError } from 'axios';

/*
 * Puts Backfill errors in plain words and classifies them: an unreachable
 * app is waited out; only a problem with the release itself marks it dead.
 */

/** An error's message, or the thrown value as text. */
export const message = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

/** Network-level failures: no answer, or not in time. */
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
 * Whether an error only means Sonarr, Radarr or the download client is
 * unreachable for now: no answer, or a proxy reporting it down. Jobs wait
 * this out instead of counting it toward giving up.
 */
export const isUnreachable = (e: unknown, depth = 0): boolean => {
  if (!e || typeof e !== 'object' || depth > 3) return false;
  if (isAxiosError(e) && e.response) {
    return [502, 503, 504].includes(e.response.status);
  }
  const { code, cause } = e as { code?: unknown; cause?: unknown };
  // Sonarr and Radarr API wrappers put the original error in `cause`.
  return UNREACHABLE.has(String(code ?? '')) || isUnreachable(cause, depth + 1);
};

/** The HTTP request behind an error, searching wrapped causes. */
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
 * Which app an error came from, by request address: "Sonarr", "SABnzbd",
 * "Prowlarr".
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

/** An error already in plain words; its cause keeps the original for the log. */
export class SaidPlainly extends Error {}

/**
 * Plain words for common failures: a limit reached, an app not answering,
 * an API key refused. Anything else passes through. `indexer` is the
 * indexer a release was fetched from, if any.
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
 * A fault in the release itself, not Seerr, the apps or the download client:
 * only then is it marked dead when its job gives up.
 */
export class ReleaseProblem extends Error {}

/**
 * A Usenet post in archives or with scrambled names: its files can't be
 * listed before download.
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
