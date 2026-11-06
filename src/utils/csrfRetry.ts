import type {
  AxiosError,
  AxiosInstance,
  InternalAxiosRequestConfig,
} from 'axios';

/** The server's answer to a change made without a valid CSRF token. */
const REFUSED = /csrf token/i;

type Retried = InternalAxiosRequestConfig & { csrfRetried?: boolean };

/**
 * Tries a change once more after a refused CSRF token, with a fresh token:
 * a page opened before CSRF protection was turned on has none yet. Any GET
 * gives the browser one, which axios then sends with the change.
 */
export const retryWithFreshCsrfToken = (client: AxiosInstance): void => {
  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error.config as Retried | undefined;
    const message = (error.response?.data as { message?: unknown } | undefined)
      ?.message;
    if (
      !config ||
      config.csrfRetried ||
      // Only changes are checked; reading never needs a token.
      ['get', 'head', 'options'].includes(config.method ?? 'get') ||
      error.response?.status !== 403 ||
      typeof message !== 'string' ||
      !REFUSED.test(message)
    ) {
      throw error;
    }
    config.csrfRetried = true;
    await client.get('/api/v1/status?checkUpdateAvailable=false');
    return client.request(config);
  });
};
