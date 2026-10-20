// Kept apart from the components, with nothing that needs the page around
// it, so it can be tested on its own.
import type {
  RequestServerIssue,
  RequestService,
} from '@server/lib/requestServers';
import { isAxiosError } from 'axios';
import type { IntlShape } from 'react-intl';
import defineMessages from './defineMessages';
import { requestActionError } from './requestActions';

/** Why a request has no Radarr, Sonarr or Lidarr server to go to. */
export const messages = defineMessages('utils.requestServerIssue', {
  removed: 'Its {service} server was removed.',
  noDefault: 'No {service} server is set as the default.',
  none: 'No {service} server is set up.',
  usesDefault: 'Retry sends it to the default {service} server.',
  choose: 'Edit it to choose another server, then retry.',
  setUp: 'Add one in Settings → Services, then retry.',
});

const SERVICE_NAMES: Record<RequestService, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  lidarr: 'Lidarr',
};

/** "Radarr", or "4K Radarr" for a 4K request. */
const serviceName = (service: RequestService, is4k: boolean) =>
  `${is4k && service !== 'lidarr' ? '4K ' : ''}${SERVICE_NAMES[service]}`;

/**
 * What happened ("Its Radarr server was removed."), and what someone who
 * manages requests can do about it: retry (it goes to the default server),
 * edit it to choose a server, or add one in Settings.
 */
export const serverIssueParts = (
  intl: IntlShape,
  issue: RequestServerIssue,
  is4k: boolean
): { fact: string; hint: string } => {
  const service = serviceName(issue.service, is4k);
  return {
    fact: intl.formatMessage(messages[issue.reason], { service }),
    hint: issue.usesDefault
      ? intl.formatMessage(messages.usesDefault, { service })
      : issue.reason === 'none'
        ? intl.formatMessage(messages.setUp)
        : intl.formatMessage(messages.choose),
  };
};

/** The issue as one text: what to do as well, for a request manager. */
export const serverIssueText = (
  intl: IntlShape,
  issue: RequestServerIssue,
  is4k: boolean,
  forManager: boolean
): string => {
  const { fact, hint } = serverIssueParts(intl, issue, is4k);
  return forManager ? `${fact} ${hint}` : fact;
};

/**
 * Why a retry was refused, in the person's language when it was for want of
 * a server to send it to; otherwise the server's reason, or the fallback.
 */
export const retryErrorMessage = (
  e: unknown,
  intl: IntlShape,
  is4k: boolean,
  fallback: string
): string => {
  const data = isAxiosError(e)
    ? (e.response?.data as
        | { code?: string; serverIssue?: RequestServerIssue }
        | undefined)
    : undefined;
  if (
    (data?.code === 'chooseServer' || data?.code === 'noServer') &&
    data.serverIssue
  ) {
    return serverIssueText(intl, data.serverIssue, is4k, true);
  }
  return requestActionError(e, fallback);
};
