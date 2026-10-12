/*
 * The Networks row on Discover: by default a fixed list, which an admin can
 * replace with their own (Customize Discover). The list is kept as JSON in
 * the row's data. The same rules are used by the server when saving and by
 * the page when reading, so a list one accepts the other does too.
 *
 * Shared with the page, so it imports nothing: a validation library here
 * would be downloaded by everyone who opens Discover.
 */

export const MAX_DISCOVER_NETWORKS = 50;
export const MAX_DISCOVER_NETWORK_NAME_LENGTH = 100;

/**
 * A TMDB logo file, as TMDB names them ("/wwemzKWzjKYJFfCeiB57q3r4Bcm.png"),
 * and as the image proxy will fetch them: one file name, no folders.
 */
export const DISCOVER_NETWORK_LOGO_PATH =
  /^\/[\w-]{1,100}\.(?:png|svg|jpe?g|webp)$/i;

export interface DiscoverNetwork {
  /** TMDB's network id. */
  id: number;
  name: string;
  logoPath: string;
}

/** One network as it is kept, or undefined if anything about it is wrong. */
export const readDiscoverNetwork = (
  value: unknown
): DiscoverNetwork | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const { id, name, logoPath } = value as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    return undefined;
  }
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_DISCOVER_NETWORK_NAME_LENGTH) {
    return undefined;
  }
  if (
    typeof logoPath !== 'string' ||
    !DISCOVER_NETWORK_LOGO_PATH.test(logoPath)
  ) {
    return undefined;
  }
  return { id, name: trimmed, logoPath };
};

/**
 * A whole list, in order, with a network listed twice kept once. A list is
 * taken whole or not at all: it is refused if it is not a list, if any
 * entry is wrong, or if it has more networks than the limit.
 */
export const checkDiscoverNetworks = (
  value: unknown
):
  | { networks: DiscoverNetwork[] }
  | { refused: 'invalid' | 'tooMany'; networks?: undefined } => {
  if (!Array.isArray(value)) return { refused: 'invalid' };
  const seen = new Set<number>();
  const networks: DiscoverNetwork[] = [];
  for (const item of value) {
    const network = readDiscoverNetwork(item);
    if (!network) return { refused: 'invalid' };
    if (seen.has(network.id)) continue;
    seen.add(network.id);
    networks.push(network);
  }
  return networks.length > MAX_DISCOVER_NETWORKS
    ? { refused: 'tooMany' }
    : { networks };
};

/** The list, or undefined if it would be refused. */
export const readDiscoverNetworks = (
  value: unknown
): DiscoverNetwork[] | undefined => checkDiscoverNetworks(value).networks;
