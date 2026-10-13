/*
 * Settings pages never send a saved API key or password back to the browser.
 * When one is left blank on saving or testing, the saved one is used instead,
 * but only for the same service at the same address: otherwise an admin who
 * changes the host, leaves the key blank and presses Test would send the
 * saved key to whatever is at the new address.
 */

export interface ServiceAddress {
  hostname?: string;
  port?: number;
  useSsl?: boolean;
  urlBase?: string;
}

// "/tautulli", "tautulli/" and "/tautulli/" are the same place, as are "" and
// "/"; host names are not case sensitive.
const baseOf = (urlBase?: string) =>
  (urlBase ?? '').trim().replace(/^\/*/, '/').replace(/\/+$/, '');

export const sameAddress = (a: ServiceAddress, b: ServiceAddress): boolean =>
  (a.hostname ?? '').trim().toLowerCase() ===
    (b.hostname ?? '').trim().toLowerCase() &&
  Number(a.port) === Number(b.port) &&
  !!a.useSsl === !!b.useSsl &&
  baseOf(a.urlBase) === baseOf(b.urlBase);

/**
 * The secret to use: the one entered, or else the saved one when the entered
 * address is the saved address. Empty when neither applies.
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
