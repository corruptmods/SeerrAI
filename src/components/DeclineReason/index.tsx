import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.DeclineReason', {
  reason: 'Reason',
});

interface DeclineReasonProps {
  reason: string;
  /**
   * Beside the Declined badge on one line, cut short where it does not fit,
   * rather than a labelled field of its own that wraps.
   */
  inline?: boolean;
  /** All of it, however long, where there is room; otherwise two lines. */
  whole?: boolean;
  className?: string;
}

/**
 * Why a request was declined, as written by whoever declined it. Always shown
 * as text. Where it is cut short, the whole reason is in its tooltip.
 */
const DeclineReason = ({
  reason,
  inline,
  whole,
  className,
}: DeclineReasonProps) => {
  const intl = useIntl();
  const label = intl.formatMessage(messages.reason);

  if (whole) {
    return (
      <div className={`flex min-w-0 items-start text-sm ${className ?? ''}`}>
        <span className="card-field-name">{label}</span>
        <span className="min-w-0 whitespace-pre-line break-words">
          {reason}
        </span>
      </div>
    );
  }

  return (
    <Tooltip
      content={
        <span className="whitespace-pre-line break-words">{reason}</span>
      }
      className="max-w-xs"
    >
      {inline ? (
        <span className={`min-w-0 truncate text-gray-300 ${className ?? ''}`}>
          <span className="sr-only">{label}: </span>
          {reason}
        </span>
      ) : (
        <div className={`flex min-w-0 items-start text-sm ${className ?? ''}`}>
          <span className="card-field-name">{label}</span>
          <span className="line-clamp-2 min-w-0 whitespace-pre-line break-words text-gray-300">
            {reason}
          </span>
        </div>
      )}
    </Tooltip>
  );
};

export default DeclineReason;
