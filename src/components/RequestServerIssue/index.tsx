import Tooltip from '@app/components/Common/Tooltip';
import { Permission, useUser } from '@app/hooks/useUser';
import { serverIssueParts } from '@app/utils/requestServerIssue';
import { ExclamationTriangleIcon } from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import { useIntl } from 'react-intl';

interface RequestServerIssueProps {
  request: Pick<
    NonFunctionProperties<MediaRequest>,
    'status' | 'is4k' | 'serverIssue'
  >;
  /**
   * On a request card, where room is short: what happened, on at most two
   * lines, with what to do about it in its tooltip (and read out with it).
   */
  compact?: boolean;
  className?: string;
}

/**
 * Why a failed request could not be sent, when it is for want of a server
 * ("Its Radarr server was removed."), and, for a request manager, what to
 * do about it: retry, edit it to choose a server, or add one in Settings.
 * Nothing otherwise.
 */
const RequestServerIssue = ({
  request,
  compact,
  className,
}: RequestServerIssueProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();

  if (request.status !== MediaRequestStatus.FAILED || !request.serverIssue) {
    return null;
  }

  const { fact, hint } = serverIssueParts(
    intl,
    request.serverIssue,
    request.is4k
  );
  const manages = hasPermission(Permission.MANAGE_REQUESTS);

  const line = (
    <p
      className={`flex min-w-0 flex-shrink-0 items-start gap-1.5 whitespace-normal text-sm text-red-300 light:text-danger-text ${
        className ?? ''
      }`}
      data-testid="request-server-issue"
    >
      <ExclamationTriangleIcon
        className="mt-0.5 h-4 w-4 flex-none"
        aria-hidden
      />
      {compact ? (
        <>
          <span className="min-w-0 break-words sm:line-clamp-2">{fact}</span>
          {manages && <span className="sr-only">{hint}</span>}
        </>
      ) : (
        <span className="min-w-0 break-words">
          {manages ? `${fact} ${hint}` : fact}
        </span>
      )}
    </p>
  );

  return compact && manages ? (
    <Tooltip content={`${fact} ${hint}`} className="max-w-xs">
      {line}
    </Tooltip>
  ) : (
    line
  );
};

export default RequestServerIssue;
