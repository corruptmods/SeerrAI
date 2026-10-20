import Alert from '@app/components/Common/Alert';
import defineMessages from '@app/utils/defineMessages';
import {
  messages as serverIssueMessages,
  serverIssueText,
} from '@app/utils/requestServerIssue';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import { useIntl } from 'react-intl';

/** What the request dialogs say when changing a failed request. */
export const failedMessages = defineMessages(
  'components.RequestModal.FailedRequest',
  {
    title: 'Failed Request',
    title4k: 'Failed 4K Request',
    couldNotSend: 'This request could not be sent.',
    changeAndRetry: 'Change where it goes if you need to, then save and retry.',
    saveAndRetry: 'Save and Retry',
    retried: 'Request for <strong>{title}</strong> saved and sent again.',
  }
);

/**
 * At the top of a failed request's dialog: why it could not be sent, where
 * that is for want of a server, and what to do.
 */
const FailedRequestAlert = ({
  request,
}: {
  request: Pick<NonFunctionProperties<MediaRequest>, 'is4k' | 'serverIssue'>;
}) => {
  const intl = useIntl();
  const issue = request.serverIssue;

  return (
    <div className="mt-4">
      <Alert
        type="warning"
        title={
          issue
            ? serverIssueText(intl, issue, request.is4k, false)
            : intl.formatMessage(failedMessages.couldNotSend)
        }
      >
        {intl.formatMessage(
          issue?.reason === 'none'
            ? serverIssueMessages.setUp
            : failedMessages.changeAndRetry
        )}
      </Alert>
    </div>
  );
};

export default FailedRequestAlert;
