import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.ListView', {
  selected: '{count} selected',
  selectAll: 'Select all shown',
  clear: 'Clear',
  request: 'Request {count}',
  confirm:
    'Request {count, plural, one {# title} other {# titles}}? Series get every season.',
  back: 'Back',
  requesting: 'Requesting {done} of {count}…',
});

interface BulkRequestBarProps {
  count: number;
  /** Titles shown that could still be selected. */
  selectable: number;
  progress?: { done: number; count: number };
  onSelectAll: () => void;
  onClear: () => void;
  onRequest: () => void;
}

/**
 * Along the bottom while choosing titles: how many are chosen, and the one
 * action. Requesting asks once more first, as it may be a lot at once.
 */
const BulkRequestBar = ({
  count,
  selectable,
  progress,
  onSelectAll,
  onClear,
  onRequest,
}: BulkRequestBarProps) => {
  const intl = useIntl();
  const [confirming, setConfirming] = useState(false);

  return (
    // Clear of the sidebar on a wide screen, and above the tab bar on a phone.
    <div className="safe-shift-edit-menu fixed left-0 right-0 z-50 border-t border-gray-700 bg-gray-800/90 p-3 backdrop-blur sm:bottom-0 lg:left-64">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
        {progress ? (
          <span className="w-full text-center text-sm text-gray-200">
            {intl.formatMessage(messages.requesting, progress)}
          </span>
        ) : confirming ? (
          <>
            <span className="flex-1 text-sm text-gray-200">
              {intl.formatMessage(messages.confirm, { count })}
            </span>
            <div className="flex gap-2">
              <Button buttonSize="sm" onClick={() => setConfirming(false)}>
                {intl.formatMessage(messages.back)}
              </Button>
              <Button
                buttonType="primary"
                buttonSize="sm"
                onClick={() => {
                  setConfirming(false);
                  onRequest();
                }}
              >
                {intl.formatMessage(messages.request, { count })}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="text-sm font-semibold text-gray-100">
              {intl.formatMessage(messages.selected, { count })}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                buttonSize="sm"
                disabled={selectable === 0}
                onClick={onSelectAll}
              >
                {intl.formatMessage(messages.selectAll)}
              </Button>
              <Button buttonSize="sm" disabled={!count} onClick={onClear}>
                {intl.formatMessage(messages.clear)}
              </Button>
              <Button
                buttonType="primary"
                buttonSize="sm"
                disabled={!count}
                onClick={() => setConfirming(true)}
              >
                {intl.formatMessage(messages.request, { count })}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default BulkRequestBar;
