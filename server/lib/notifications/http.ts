import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import axios from 'axios';

/**
 * Timeout for notification services and poster fetches; without it an
 * unresponsive service hangs the send and the Test button.
 */
export const NOTIFICATION_TIMEOUT_MS = 15_000;

/** Host only: some paths contain tokens. */
const hostOf = (url: string | undefined, baseURL: string | undefined) => {
  try {
    return new URL(url ?? '', baseURL).host;
  } catch {
    return 'the service';
  }
};

/** HTTP client for notification services: proxy, user agent, timeout. */
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
