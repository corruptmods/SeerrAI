import axios from 'axios';

/**
 * What to tell someone when something done to a request failed: the
 * server's reason where it gave one (such as "Only pending requests can be
 * approved or declined." when someone else got there first), or else the
 * message given.
 */
export const requestActionError = (e: unknown, fallback: string): string => {
  if (axios.isAxiosError(e)) {
    const message = (e.response?.data as { message?: unknown } | undefined)
      ?.message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  return fallback;
};

/**
 * Does something to each request in turn, starting the next only once the
 * last is done, and returns the errors of those that failed. Never two at
 * once: declined together, each of a title's requests still saw the others
 * as waiting, and the title was never reset.
 */
export const oneAfterAnother = async <T>(
  items: readonly T[],
  act: (item: T) => Promise<unknown>
): Promise<unknown[]> => {
  const errors: unknown[] = [];
  for (const item of items) {
    try {
      await act(item);
    } catch (e) {
      errors.push(e);
    }
  }
  return errors;
};
