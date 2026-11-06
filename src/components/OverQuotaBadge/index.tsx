import Badge from '@app/components/Common/Badge';
import defineMessages from '@app/utils/defineMessages';
import { MediaRequestStatus } from '@server/constants/media';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.OverQuotaBadge', {
  overLimit: 'Over Limit',
});

interface OverQuotaBadgeProps {
  request: { status: MediaRequestStatus; overQuota?: boolean };
  className?: string;
}

/** Marks a pending request made over its requester's limit. */
const OverQuotaBadge = ({ request, className }: OverQuotaBadgeProps) => {
  const intl = useIntl();
  if (!request.overQuota || request.status !== MediaRequestStatus.PENDING) {
    return null;
  }
  return (
    <span className={className}>
      <Badge badgeType="warning">
        {intl.formatMessage(messages.overLimit)}
      </Badge>
    </span>
  );
};

export default OverQuotaBadge;
