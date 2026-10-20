import useToasts from '@app/hooks/useToasts';
import { retryErrorMessage } from '@app/utils/requestServerIssue';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import axios from 'axios';
import { useCallback, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';

type Request = NonFunctionProperties<MediaRequest>;

/**
 * Retrying a failed request. When it is refused for want of a server to send
 * it to, the toast says so in the person's language and what to do: edit
 * the request to choose one, or add one in Settings.
 */
const useRetryRequest = (
  request: Pick<Request, 'id' | 'is4k'>,
  onRetried: (request: Request) => void,
  failed: MessageDescriptor
) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isRetrying, setIsRetrying] = useState(false);

  const retry = useCallback(async (): Promise<boolean> => {
    setIsRetrying(true);
    try {
      const result = await axios.post<Request>(
        `/api/v1/request/${request.id}/retry`
      );
      onRetried(result.data);
      return true;
    } catch (e) {
      addToast(
        retryErrorMessage(e, intl, request.is4k, intl.formatMessage(failed)),
        { autoDismiss: true, appearance: 'error' }
      );
      return false;
    } finally {
      setIsRetrying(false);
    }
  }, [request.id, request.is4k, onRetried, failed, intl, addToast]);

  return { retry, isRetrying };
};

export default useRetryRequest;
