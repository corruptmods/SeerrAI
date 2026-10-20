import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import axios from 'axios';

/**
 * How long a notification waits for the service it goes to (Discord,
 * Telegram, a webhook…), and for a poster it sends along. Without a limit, a
 * service that never answers held its notification, and the Test button,
 * for good.
 */
export const NOTIFICATION_TIMEOUT_MS = 15_000;

/** Where a request went, without the path: tokens live in some of them. */
const hostOf = (url: string | undefined, baseURL: string | undefined) => {
  try {
    return new URL(url ?? '', baseURL).host;
  } catch {
    return 'the service';
  }
};

/**
 * The client every notification service is reached through: the server's
 * proxy settings, Seerr's user agent, and the time limit above. A request
 * that runs out of time fails with a message saying so, which each agent
 * logs as the reason its notification wasn't sent.
 */
const notificationHttp = axios.create({ timeout: NOTIFICATION_TIMEOUT_MS });
notificationHttp.interceptors.request.use(proxyRequestInterceptor);
notificationHttp.interceptors.request.use(userAgentRequestInterceptor);
notificationHttp.interceptors.response.use(undefined, (error) => {
  if (
    axios.isAxiosError(error) &&
    (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')
  ) {
    const seconds = (error.config?.timeout ?? NOTIFICATION_TIMEOUT_MS) / 1000;
    error.message = `No answer from ${hostOf(
      error.config?.url,
      error.config?.baseURL
    )} within ${seconds} seconds; gave up`;
  }
  return Promise.reject(error);
});

export default notificationHttp;
