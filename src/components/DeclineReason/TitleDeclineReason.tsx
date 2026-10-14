import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ownDeclinedRequests } from '@app/utils/ownDeclinedRequests';
import { XCircleIcon } from '@heroicons/react/24/outline';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.DeclineReason.TitleDeclineReason', {
  declined: 'Your request was declined: {reason}',
  declined4k: 'Your 4K request was declined: {reason}',
});

/**
 * On a title's page, why the viewer's own latest request for it was
 * declined, when whoever declined it gave a reason.
 */
const TitleDeclineReason = ({ requests }: { requests?: MediaRequest[] }) => {
  const intl = useIntl();
  const { user } = useUser();

  const declined = ownDeclinedRequests(requests, user?.id);

  if (declined.length === 0) {
    return null;
  }

  return (
    <>
      {declined.map(({ reason, is4k }) => (
        <p
          key={is4k ? '4k' : 'standard'}
          className="mt-2 flex items-start justify-center gap-1.5 text-sm text-gray-300 2xl:justify-start"
        >
          <XCircleIcon className="mt-0.5 h-4 w-4 flex-none text-red-400" />
          <span className="min-w-0 whitespace-pre-line break-words">
            {intl.formatMessage(
              is4k ? messages.declined4k : messages.declined,
              {
                reason,
              }
            )}
          </span>
        </p>
      ))}
    </>
  );
};

export default TitleDeclineReason;
