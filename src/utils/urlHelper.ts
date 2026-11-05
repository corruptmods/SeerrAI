export function getHostAndPort(): string {
  let host = process.env.HOST || 'localhost';
  // Bracket IPv6 literals; only they contain a colon. No parsing library, as
  // this ships in the page bundle.
  if (host.includes(':') && !host.startsWith('[')) {
    host = `[${host}]`;
  }

  const port = Number(process.env.PORT) || 5055;
  return `${host}:${port}`;
}
