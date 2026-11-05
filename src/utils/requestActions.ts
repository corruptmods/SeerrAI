import axios from 'axios';

/**
 * Error text for a failed request action: the server's reason if given (e.g.
 * "Only pending requests can be approved or declined."), else `fallback`.
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
 * Runs an action on each request sequentially; returns the failures. Never
 * in parallel: concurrent declines each see the others as pending, so the
 * title is never reset.
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
