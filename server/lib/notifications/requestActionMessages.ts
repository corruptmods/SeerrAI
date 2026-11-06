import { MediaRequestStatus } from '@server/constants/media';
import type { getIntl } from '@server/i18n';
import { defineMessages } from '@server/i18n';
import type {
  RequestAction,
  StatusChange,
} from '@server/lib/requestStatusChange';

/** Words for the Approve and Decline buttons on ntfy and Telegram. */
const requestActionMessages = defineMessages('notifications.requestActions', {
  approve: 'Approve',
  decline: 'Decline',
  approvedBy: 'Approved by {userName}',
  declinedBy: 'Declined by {userName}',
  alreadyApproved: 'Already approved',
  alreadyDeclined: 'Already declined',
  notFound: 'This request no longer exists',
  blocklisted: 'This title is blocklisted, so it can’t be approved',
  notLinked:
    'You can’t approve requests here: this Telegram account isn’t linked to a {applicationTitle} account that can manage requests',
  notAllowed: '{userName} can no longer manage requests',
  buttonExpired: 'This button has expired or no longer works',
  failed: 'Something went wrong. Try again in {applicationTitle}.',
  tooManyTries: 'Too many tries. Try again in a few minutes.',
  requestChanged:
    'This request changed since; open {applicationTitle} to review it',
  severalAccounts:
    'You can’t approve requests here: this Telegram account is linked to more than one {applicationTitle} account that can manage requests',
});

export default requestActionMessages;

/** What pressing a button did, in a few words, for the one who pressed it. */
export const statusChangeText = (
  change: StatusChange,
  action: RequestAction,
  actorName: string,
  intl: ReturnType<typeof getIntl>
): string => {
  switch (change.outcome) {
    case 'done':
      return intl.formatMessage(
        action === 'approve'
          ? requestActionMessages.approvedBy
          : requestActionMessages.declinedBy,
        { userName: actorName }
      );
    case 'notPending':
      return intl.formatMessage(
        change.request.status === MediaRequestStatus.DECLINED
          ? requestActionMessages.alreadyDeclined
          : requestActionMessages.alreadyApproved
      );
    case 'blocklisted':
      return intl.formatMessage(requestActionMessages.blocklisted);
    case 'notFound':
      return intl.formatMessage(requestActionMessages.notFound);
  }
};
