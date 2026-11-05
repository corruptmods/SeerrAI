import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import type { IntlShape, MessageDescriptor } from 'react-intl';

const messages = defineMessages('components.Settings.arrTestFailure', {
  hostRefused:
    '{app} doesn’t answer to “{host}”. Add {host} to Allowed Hosts in {app} (Settings → General), or connect to it by a name it allows.',
});

/**
 * Toast text for a failed *arr connection test: the Allowed Hosts refusal
 * (Radarr 7+) if the server reported one, else `otherwise`.
 */
export const arrTestFailure = (
  intl: IntlShape,
  e: unknown,
  app: string,
  otherwise: MessageDescriptor
): string => {
  const host = axios.isAxiosError<{ hostRefused?: string }>(e)
    ? e.response?.data?.hostRefused
    : undefined;
  return host
    ? intl.formatMessage(messages.hostRefused, { app, host })
    : intl.formatMessage(otherwise);
};
