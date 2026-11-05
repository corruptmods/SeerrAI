import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.DeclineReason', {
  reason: 'Reason',
});

interface DeclineReasonProps {
  reason: string;
  /** One truncated line beside the Declined badge, instead of a wrapping labelled field. */
  inline?: boolean;
  /** Show it in full; otherwise two lines. */
  whole?: boolean;
  className?: string;
}

/** The decline reason, as plain text; the full text is in a tooltip when truncated. */
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
          <span className="min-w-0 whitespace-pre-line break-words text-gray-300 sm:line-clamp-2">
            {reason}
          </span>
        </div>
      )}
    </Tooltip>
  );
};

export default DeclineReason;
