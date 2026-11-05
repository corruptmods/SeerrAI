// Discover's streaming service filters: services a page or custom row is
// limited to ("on Netflix") and those it excludes ("not on Netflix", TMDB's
// without_watch_providers). The server (querying TMDB) and the page (reading
// the URL or a row) share these rules, so neither asks for what the other
// wouldn't.
//
// Shared with the page, so it imports nothing.

/** More services than TMDB lists for any country. */
export const MAX_STREAMING_SERVICES = 100;

/** A TMDB service id: a positive integer. */
const SERVICE_ID = /^[0-9]{1,9}$/;

/** A TMDB country code (ISO 3166-1 alpha-2). */
const REGION = /^[A-Za-z]{2}$/;

/**
 * TMDB service ids from "8|9" (or "8,9"): each once, in order. Non-ids are
 * dropped rather than passed on.
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
 * The services to exclude. One also among those shown stays shown: excluding it
 * too would show nothing.
 */
export const leftOutServices = (
  on?: string | null,
  notOn?: string | null
): number[] => {
  const shown = readServiceIds(on);
  return readServiceIds(notOn).filter((id) => !shown.includes(id));
};

export interface StreamingServices {
  /** The country, since TMDB's lists differ by country. */
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
 * Parses a streaming services row's data: "US,8|9" (country, then shown
 * services), with excluded services after a second comma ("US,8|9,337") only
 * when there are any, so rows without exclusions keep the original format older
 * versions read.
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
 * The query string for these services, as Discover pages and the API take it
 * ("watchRegion=US&watchProviders=8|9&excludeWatchProviders=337"). Empty
 * without services: a country alone filters nothing.
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
