import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import { requestActionError } from '@app/utils/requestActions';
import { useCallback, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';

/**
 * Runs a request action (approve, delete) with a busy state that always
 * clears, and an error toast on failure. Resolves to success.
 */
const useRequestAction = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isBusy, setIsBusy] = useState(false);

  const run = useCallback(
    async (
      action: () => Promise<unknown>,
      failed: MessageDescriptor = globalMessages.error
    ): Promise<boolean> => {
      setIsBusy(true);
      try {
        await action();
        return true;
      } catch (e) {
        addToast(requestActionError(e, intl.formatMessage(failed)), {
          appearance: 'error',
          autoDismiss: true,
        });
        return false;
      } finally {
        setIsBusy(false);
      }
    },
    [addToast, intl]
  );

  return { run, isBusy };
};

export default useRequestAction;
