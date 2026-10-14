import Badge from '@app/components/Common/Badge';
import globalMessages from '@app/i18n/globalMessages';
import { MediaStatus } from '@server/constants/media';
import { useIntl } from 'react-intl';

/** Whether Seerr has an album or artist yet, as a small badge. */
const MusicStatusBadge = ({ status }: { status?: MediaStatus }) => {
  const intl = useIntl();

  switch (status) {
    case MediaStatus.AVAILABLE:
      return (
        <Badge badgeType="success">
          {intl.formatMessage(globalMessages.available)}
        </Badge>
      );
    case MediaStatus.PARTIALLY_AVAILABLE:
      return (
        <Badge badgeType="success">
          {intl.formatMessage(globalMessages.partiallyavailable)}
        </Badge>
      );
    case MediaStatus.PROCESSING:
      return (
        <Badge badgeType="primary">
          {intl.formatMessage(globalMessages.requested)}
        </Badge>
      );
    case MediaStatus.PENDING:
      return (
        <Badge badgeType="warning">
          {intl.formatMessage(globalMessages.pending)}
        </Badge>
      );
    case MediaStatus.DELETED:
      return (
        <Badge badgeType="danger">
          {intl.formatMessage(globalMessages.deleted)}
        </Badge>
      );
    default:
      return null;
  }
};

export default MusicStatusBadge;
