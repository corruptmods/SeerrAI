/**
 * Whether console log lines get colour codes. Only for a terminal: in files or
 * container log drivers, escape codes are noise that breaks log shippers.
 * NO_COLOR (no-color.org) and TERM=dumb always disable colour; FORCE_COLOR
 * enables it (or disables with 0/false) regardless of output.
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
