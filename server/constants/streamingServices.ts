/*
 * Streaming services on Discover: the ones a page or a custom row shows only
 * titles on ("on Netflix"), and the ones it leaves out ("not on Netflix",
 * TMDB's without_watch_providers). The same rules are used by the server
 * when asking TMDB and by the page when reading the address or a row, so
 * one never asks for what the other would not.
 *
 * Shared with the page, so it imports nothing.
 */

/** More services than TMDB lists for any one country. */
export const MAX_STREAMING_SERVICES = 100;

/** TMDB's id for a service: a whole number above 0. */
const SERVICE_ID = /^[0-9]{1,9}$/;

/** Two letters, as TMDB names a country (ISO 3166-1). */
const REGION = /^[A-Za-z]{2}$/;

/**
 * Services as TMDB numbers them, from "8|9" (or "8,9"): each once, in order.
 * Anything that is not an id is dropped rather than sent on.
 */
export const readServiceIds = (value?: string | null): number[] => {
  if (typeof value !== 'string') return [];
  const ids: number[] = [];
  for (const part of value.split(/[|,]/)) {
    const text = part.trim();
    if (!SERVICE_ID.test(text)) continue;
    const id = Number(text);
    if (id > 0 && !ids.includes(id)) ids.push(id);
    if (ids.length === MAX_STREAMING_SERVICES) break;
  }
  return ids;
};

/**
 * The services to leave out. One that is also among those shown can't be
 * both, so it stays shown: leaving it out as well would show nothing.
 */
export const leftOutServices = (
  on?: string | null,
  notOn?: string | null
): number[] => {
  const shown = readServiceIds(on);
  return readServiceIds(notOn).filter((id) => !shown.includes(id));
};

export interface StreamingServices {
  /** Where the services are, as TMDB's lists differ by country. */
  region?: string;
  /** Only titles on one of these. */
  on: number[];
  /** No titles on any of these. */
  notOn: number[];
}

const regionOf = (value?: string): string | undefined => {
  const text = value?.trim();
  return text && REGION.test(text) ? text.toUpperCase() : undefined;
};

const tidy = (services: StreamingServices): StreamingServices => {
  const region = regionOf(services.region);
  const on = readServiceIds(services.on.join('|'));
  return {
    ...(region && { region }),
    on,
    notOn: readServiceIds(services.notOn.join('|')).filter(
      (id) => !on.includes(id)
    ),
  };
};

/**
 * A streaming services row's data. Rows have always kept "US,8|9" (the
 * country, then the services shown); the services left out follow a second
 * comma, "US,8|9,337", and only when there are any, so a row that leaves
 * nothing out is kept exactly as before and older versions still read it.
 */
export const readStreamingRow = (data?: string | null): StreamingServices => {
  const [region, on, notOn] = (data ?? '').split(',');
  return tidy({
    region,
    on: readServiceIds(on),
    notOn: readServiceIds(notOn),
  });
};

export const writeStreamingRow = (services: StreamingServices): string => {
  const { region, on, notOn } = tidy(services);
  const kept = `${region ?? ''},${on.join('|')}`;
  return notOn.length ? `${kept},${notOn.join('|')}` : kept;
};

/**
 * The address for these services, as Discover's pages and the API take it
 * ("watchRegion=US&watchProviders=8|9&excludeWatchProviders=337"). Without
 * any services it is empty: a country alone narrows nothing.
 */
export const streamingServiceQuery = (services: StreamingServices): string => {
  const { region, on, notOn } = tidy(services);
  if (!on.length && !notOn.length) return '';
  return [
    region && `watchRegion=${region}`,
    on.length && `watchProviders=${on.join('|')}`,
    notOn.length && `excludeWatchProviders=${notOn.join('|')}`,
  ]
    .filter(Boolean)
    .join('&');
};
