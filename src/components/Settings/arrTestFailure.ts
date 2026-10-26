import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import type { IntlShape, MessageDescriptor } from 'react-intl';

const messages = defineMessages('components.Settings.arrTestFailure', {
  hostRefused:
    '{app} doesn’t answer to “{host}”. Add {host} to Allowed Hosts in {app} (Settings → General), or connect to it by a name it allows.',
});

/**
 * Why a Radarr, Sonarr or Lidarr connection test failed, for its toast:
 * turned away for the name it was reached by (Allowed Hosts, in Radarr 7),
 * or the usual failure.
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
