import { checkDiscoverNetworks } from '@server/constants/discoverNetworks';
import { ApiErrorCode } from '@server/constants/error';

/** A Networks list refused; its message is the code the page translates. */
export class DiscoverNetworksError extends Error {
  constructor(
    code:
      | ApiErrorCode.InvalidNetworkList
      | ApiErrorCode.TooManyNetworks = ApiErrorCode.InvalidNetworkList
  ) {
    super(code);
    this.name = 'DiscoverNetworksError';
  }
}

/**
 * The Networks row's data as it is kept: null (or nothing) for the default
 * list, otherwise the list re-written from what was checked, never the text
 * as sent. An empty list is kept: it shows "No networks selected".
 */
export const sanitizeDiscoverNetworks = (
  data: string | null | undefined
): string | null => {
  if (data === null || data === undefined || data === '') {
    return null;
  }
  if (typeof data !== 'string') {
    throw new DiscoverNetworksError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new DiscoverNetworksError();
  }
  const checked = checkDiscoverNetworks(parsed);
  if (!checked.networks) {
    throw new DiscoverNetworksError(
      checked.refused === 'tooMany'
        ? ApiErrorCode.TooManyNetworks
        : ApiErrorCode.InvalidNetworkList
    );
  }
  return JSON.stringify(checked.networks);
};
