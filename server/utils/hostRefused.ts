import { isAxiosError } from 'axios';

/*
 * Radarr 7 (and the apps built like it) can be told which host names to
 * answer to: Allowed Hosts, in its General settings, which it asks for on
 * first run. A request for any other name gets ASP.NET's own "Bad Request -
 * Invalid Hostname" page, which says nothing of where to fix it.
 */

/** ASP.NET's page for a host name it does not answer to. */
const REFUSED_PAGE = /Invalid Hostname|request hostname is invalid/i;

/**
 * The host name an app turned the request away for, when that is why it
 * failed (looking through the errors it was wrapped in), else undefined.
 */
export const refusedHost = (e: unknown): string | undefined => {
  let at: unknown = e;
  for (let depth = 0; at && depth < 5; depth++) {
    if (
      isAxiosError(at) &&
      at.response?.status === 400 &&
      typeof at.response.data === 'string' &&
      REFUSED_PAGE.test(at.response.data)
    ) {
      const config = at.config;
      try {
        return new URL(config?.url ?? '', config?.baseURL).hostname;
      } catch {
        return '';
      }
    }
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
};

/** What to do about it, in words. */
export const hostRefusedMessage = (app: string, host: string): string =>
  host
    ? `${app} doesn't answer to "${host}": add ${host} to Allowed Hosts in ${app} (Settings → General), or connect to it by a name it allows.`
    : `${app} doesn't answer to the name Seerr AI uses for it: add that name to Allowed Hosts in ${app} (Settings → General).`;
