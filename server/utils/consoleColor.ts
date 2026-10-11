/**
 * Whether console log lines get colour codes. Only for someone watching a
 * terminal: piped to a file or a container's log driver, escape codes are
 * noise that breaks log shippers. NO_COLOR (no-color.org) and TERM=dumb
 * always turn colour off; FORCE_COLOR turns it on, or off with 0/false,
 * whatever the output is.
 */
export const consoleColor = (
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean | undefined = process.stdout.isTTY
): boolean => {
  if (env.NO_COLOR) {
    return false;
  }
  if (env.FORCE_COLOR !== undefined) {
    return !['0', 'false'].includes(env.FORCE_COLOR.toLowerCase());
  }
  if (env.TERM === 'dumb') {
    return false;
  }
  return !!isTTY;
};
