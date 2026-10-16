/**
 * Also Trust These Proxies on Settings → Network is one line of text, with
 * entries separated by commas, spaces or both; the setting is a list. The
 * entries themselves are checked by the server when saving.
 */
export const proxyListFromText = (text: string | undefined): string[] =>
  (text ?? '').split(/[\s,]+/).filter((entry) => entry !== '');

/** The saved list as the field shows it, in the order it was entered. */
export const proxyListToText = (list: string[] | undefined): string =>
  (list ?? []).join(', ');

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const isIpv6 = (address: string): boolean => {
  if (!address.includes(':')) {
    return false;
  }
  // The browser's own address parser decides what an IPv6 address is.
  try {
    new URL(`http://[${address}]/`);
    return true;
  } catch {
    return false;
  }
};

// An IPv4 netmask such as 255.255.0.0: ones, then only zeros. All zeros
// would mean every address; Express refuses it, like a prefix of 0.
const isNetmask = (mask: string): boolean => {
  if (!IPV4.test(mask)) {
    return false;
  }
  const bits = mask
    .split('.')
    .map((part) => Number(part).toString(2).padStart(8, '0'))
    .join('');
  return /^1+0*$/.test(bits);
};

const isAddressOrRange = (entry: string): boolean => {
  const [address, range, ...rest] = entry.split('/');
  if (rest.length > 0) {
    return false;
  }
  const v4 = IPV4.test(address);
  if (!v4 && !isIpv6(address)) {
    return false;
  }
  if (range === undefined) {
    return true;
  }
  // A prefix of 0 would mean every address; Express refuses it too.
  if (/^\d{1,3}$/.test(range)) {
    return Number(range) >= 1 && Number(range) <= (v4 ? 32 : 128);
  }
  return v4 && isNetmask(range);
};

/**
 * The first entry in Also Trust These Proxies that is not an IPv4 or IPv6
 * address, with or without a range, so the page can say which one before
 * saving. The server checks again, exactly as it will read them.
 */
export const firstNonAddress = (text: string | undefined): string | undefined =>
  proxyListFromText(text).find((entry) => !isAddressOrRange(entry));
