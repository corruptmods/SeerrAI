export function getHostAndPort(): string {
  let host = process.env.HOST || 'localhost';
  // An IPv6 literal needs square brackets in a URL. Only an IPv6 address has
  // a colon in it (host names and IPv4 addresses never do); this runs in the
  // page bundle too, so no address-parsing library is pulled in for it.
  if (host.includes(':') && !host.startsWith('[')) {
    host = `[${host}]`;
  }

  const port = Number(process.env.PORT) || 5055;
  return `${host}:${port}`;
}
