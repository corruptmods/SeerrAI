/*
 * Settings pages never send a saved API key or password to the browser. A
 * blank one on save or test uses the saved one, but only for the same service
 * at the same address: otherwise changing the host, leaving the key blank and
 * pressing Test would send the saved key to whatever is at the new address.
 */

export interface ServiceAddress {
  hostname?: string;
  port?: number;
  useSsl?: boolean;
  urlBase?: string;
}

// "/tautulli", "tautulli/" and "/tautulli/" are equal, as are "" and "/";
// host names are case-insensitive.
const baseOf = (urlBase?: string) =>
  (urlBase ?? '').trim().replace(/^\/*/, '/').replace(/\/+$/, '');

export const sameAddress = (a: ServiceAddress, b: ServiceAddress): boolean =>
  (a.hostname ?? '').trim().toLowerCase() ===
    (b.hostname ?? '').trim().toLowerCase() &&
  Number(a.port) === Number(b.port) &&
  !!a.useSsl === !!b.useSsl &&
  baseOf(a.urlBase) === baseOf(b.urlBase);

/**
 * The secret to use: the entered one, else the saved one when the address is
 * unchanged. Empty otherwise.
 */
export const keptSecret = (
  entered: string | undefined,
  address: ServiceAddress,
  saved: ServiceAddress | undefined,
  savedSecret: string | undefined
): string => {
  if (entered) return entered;
  if (!saved || !sameAddress(saved, address)) return '';
  return savedSecret ?? '';
};
