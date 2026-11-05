import Badge from '@app/components/Common/Badge';
import defineMessages from '@app/utils/defineMessages';
import {
  SERVER_NAMES,
  accountServers,
  mainServerOf,
} from '@app/utils/mediaServerAccounts';
import type { MediaServerKind } from '@server/constants/server';
import { useIntl } from 'react-intl';

// Kept under the UserList ids, which are already translated.
const messages = defineMessages('components.UserList', {
  plexuser: 'Plex User',
  localuser: 'Local User',
  mediaServerUser: '{mediaServerName} User',
});

const BADGE_TYPES = {
  plex: 'warning',
  jellyfin: 'default',
  emby: 'success',
} as const;

interface AccountTypeBadgesProps {
  user: { userType: number; linkedServers?: MediaServerKind[] };
}

/**
 * A badge per linked media server account, main one first (even before its
 * first sign-in), or Local User.
 */
const AccountTypeBadges = ({ user }: AccountTypeBadgesProps) => {
  const intl = useIntl();
  const main = mainServerOf(user);
  const servers = [
    ...(main ? [main] : []),
    ...accountServers(user).filter((kind) => kind !== main),
  ];

  if (!servers.length) {
    return (
      <Badge badgeType="default">
        {intl.formatMessage(messages.localuser)}
      </Badge>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {servers.map((kind) => (
        <Badge key={kind} badgeType={BADGE_TYPES[kind]}>
          {kind === 'plex'
            ? intl.formatMessage(messages.plexuser)
            : intl.formatMessage(messages.mediaServerUser, {
                mediaServerName: SERVER_NAMES[kind],
              })}
        </Badge>
      ))}
    </div>
  );
};

export default AccountTypeBadges;
