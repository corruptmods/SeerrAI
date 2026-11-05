import { isAxiosError } from 'axios';
import type { Response } from 'express';

// Radarr 7 (and apps built like it) can restrict which host names it answers to
// (Allowed Hosts in General settings, asked on first run). Other names get
// ASP.NET's "Bad Request - Invalid Hostname" page, which doesn't say where to
// fix it.

/** ASP.NET's page for a host name it doesn't answer to. */
const REFUSED_PAGE = /Invalid Hostname|request hostname is invalid/i;

/**
 * The host name an app rejected the request for, if that's why it failed
 * (searching wrapped causes), else undefined.
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

/** How to fix it, in words. */
export const hostRefusedMessage = (app: string, host: string): string =>
  host
    ? `${app} doesn't answer to "${host}": add ${host} to Allowed Hosts in ${app} (Settings → General), or connect to it by a name it allows.`
    : `${app} doesn't answer to the name Seerr AI uses for it: add that name to Allowed Hosts in ${app} (Settings → General).`;

/**
 * If a connection test was rejected for its host name, answers 502 with how to
 * fix it and returns true. Otherwise returns false for the caller to answer.
 */
export const answerHostRefused = (
  res: Response,
  app: string,
  e: unknown
): boolean => {
  const host = refusedHost(e);
  if (host === undefined) return false;
  res
    .status(502)
    .json({ message: hostRefusedMessage(app, host), hostRefused: host });
  return true;
};
