import Badge from '@app/components/Common/Badge';
import defineMessages from '@app/utils/defineMessages';
import {
  SERVER_NAMES,
  accountServers,
  mainServerOf,
} from '@app/utils/mediaServerAccounts';
import type { MediaServerKind } from '@server/constants/server';
import { useIntl } from 'react-intl';

// Under the user list's names, which are already translated.
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
 * What kind of account someone has: a badge for each media server they
 * have an account linked from, their main one first (also while it waits
 * for them to sign in with it for the first time), or Local User.
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
