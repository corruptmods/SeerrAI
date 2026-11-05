import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { oneAfterAnother } from '@app/utils/requestActions';
import { Transition } from '@headlessui/react';
import { DECLINE_REASON_MAX_LENGTH } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import axios from 'axios';
import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { mutate } from 'swr';

const messages = defineMessages('components.DeclineRequestModal', {
  title:
    '{requestCount, plural, one {Decline Request} other {Decline {requestCount} Requests}}',
  reason: 'Reason',
  reasonPlaceholder: 'Reason (optional), such as “Already on Netflix”',
  reasonHint:
    '{requestCount, plural, one {Whoever asked sees it} other {Everyone who asked sees it}}, on the request and in the notification.',
  declining: 'Declining…',
  failed:
    '{requestCount, plural, one {The request could not be declined.} other {Not every request could be declined.}} Try again.',
});

interface DeclineRequestModalProps {
  show: boolean;
  /** One request, or all pending requests for a title. */
  requests: Pick<NonFunctionProperties<MediaRequest>, 'id'>[];
  /** Their title, if known. */
  subTitle?: string;
  onCancel: () => void;
  /** Called once all requests are declined. */
  onComplete: () => void;
}

/**
 * Declines requests with an optional reason for the requester. Sent as typed;
 * the server trims it and stores plain text.
 */
const DeclineRequestModal = ({
  show,
  requests,
  subTitle,
  onCancel,
  onComplete,
}: DeclineRequestModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [reason, setReason] = useState('');
  const [isDeclining, setIsDeclining] = useState(false);
  const reasonId = useId();
  const hintId = useId();

  useEffect(() => {
    // Reset on open so a reason never carries over to the next request.
    if (show) {
      setReason('');
    }
  }, [show]);

  const decline = async () => {
    setIsDeclining(true);
    const declineReason = reason.trim();

    // Sequential: in parallel each sees the others as pending, so the title
    // never resets to not requested.
    const failed = (
      await oneAfterAnother(requests, (request) =>
        axios.post(
          `/api/v1/request/${request.id}/decline`,
          declineReason ? { declineReason } : {}
        )
      )
    ).length;

    setIsDeclining(false);
    mutate('/api/v1/request/count');

    if (failed > 0) {
      addToast(
        intl.formatMessage(messages.failed, { requestCount: requests.length }),
        { appearance: 'error', autoDismiss: true }
      );
    }

    // Stay open with the reason if nothing was declined; otherwise show the result.
    if (failed < requests.length) {
      onComplete();
    }
  };

  return (
    <Transition
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show={show}
    >
      <Modal
        title={intl.formatMessage(messages.title, {
          requestCount: requests.length,
        })}
        subTitle={subTitle}
        onCancel={onCancel}
        onOk={() => decline()}
        okText={
          isDeclining
            ? intl.formatMessage(messages.declining)
            : intl.formatMessage(globalMessages.decline)
        }
        okButtonType="danger"
        okDisabled={isDeclining || requests.length === 0}
        // Don't lose a typed reason to a stray tap outside.
        backgroundClickable={!reason.trim()}
      >
        <label htmlFor={reasonId} className="sr-only">
          {intl.formatMessage(messages.reason)}
        </label>
        <textarea
          id={reasonId}
          className="h-20"
          maxLength={DECLINE_REASON_MAX_LENGTH}
          placeholder={intl.formatMessage(messages.reasonPlaceholder)}
          aria-describedby={hintId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p id={hintId} className="mt-2 text-sm text-gray-400">
          {intl.formatMessage(messages.reasonHint, {
            requestCount: requests.length,
          })}
        </p>
      </Modal>
    </Transition>
  );
};

export default DeclineRequestModal;
