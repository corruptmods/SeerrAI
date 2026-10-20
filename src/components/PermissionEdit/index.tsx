import type { PermissionItem } from '@app/components/PermissionOption';
import PermissionOption from '@app/components/PermissionOption';
import useSettings from '@app/hooks/useSettings';
import type { User } from '@app/hooks/useUser';
import { Permission } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { SERVER_NAMES } from '@app/utils/mediaServerAccounts';
import { useIntl } from 'react-intl';

export const messages = defineMessages('components.PermissionEdit', {
  admin: 'Admin',
  adminDescription: 'Full access. Skips all other permission checks.',
  users: 'Manage Users',
  usersDescription: 'Can manage users, except admins. Can’t grant Admin.',
  managerequests: 'Manage Requests',
  managerequestsDescription:
    'Can manage requests. Their own requests are approved automatically.',
  request: 'Request',
  requestDescription: 'Can request in non-4K.',
  requestMovies: 'Request Movies',
  requestMoviesDescription: 'Can request movies in non-4K.',
  requestTv: 'Request Series',
  requestTvDescription: 'Can request series in non-4K.',
  requestMusic: 'Request Music',
  requestMusicDescription: 'Can request albums, sent to Lidarr.',
  autoapprove: 'Auto-Approve',
  autoapproveDescription: 'All non-4K requests are approved automatically.',
  autoapproveMovies: 'Auto-Approve Movies',
  autoapproveMoviesDescription:
    'Non-4K movie requests are approved automatically.',
  autoapproveSeries: 'Auto-Approve Series',
  autoapproveSeriesDescription:
    'Non-4K series requests are approved automatically.',
  autoapproveMusic: 'Auto-Approve Music',
  autoapproveMusicDescription: 'Music requests are approved automatically.',
  autoapprove4k: 'Auto-Approve 4K',
  autoapprove4kDescription: 'All 4K requests are approved automatically.',
  autoapprove4kMovies: 'Auto-Approve 4K Movies',
  autoapprove4kMoviesDescription:
    '4K movie requests are approved automatically.',
  autoapprove4kSeries: 'Auto-Approve 4K Series',
  autoapprove4kSeriesDescription:
    '4K series requests are approved automatically.',
  request4k: 'Request 4K',
  request4kDescription: 'Can request in 4K.',
  request4kMovies: 'Request 4K Movies',
  request4kMoviesDescription: 'Can request movies in 4K.',
  request4kTv: 'Request 4K Series',
  request4kTvDescription: 'Can request series in 4K.',
  advancedrequest: 'Advanced Requests',
  advancedrequestDescription: 'Can change advanced request options.',
  autorequest: 'Auto-Request',
  autorequestDescription:
    'Titles on their watchlist can be requested automatically, in non-4K.',
  autorequestMovies: 'Auto-Request Movies',
  autorequestMoviesDescription:
    'Movies on their watchlist can be requested automatically, in non-4K.',
  autorequestSeries: 'Auto-Request Series',
  autorequestSeriesDescription:
    'Series on their watchlist can be requested automatically, in non-4K.',
  viewrequests: 'View Requests',
  viewrequestsDescription: 'Can see other users’ requests.',
  manageissues: 'Manage Issues',
  manageissuesDescription: 'Can manage issues.',
  createissues: 'Report Issues',
  createissuesDescription: 'Can report issues.',
  viewissues: 'View Issues',
  viewissuesDescription: 'Can see issues others reported.',
  viewrecent: 'View Recently Added',
  viewrecentDescription: 'Can see recently added titles.',
  viewwatchlists: 'View {mediaServerName} Watchlists',
  viewwatchlistsDescription:
    'Can see other users’ {mediaServerName} Watchlists.',
  manageblocklist: 'Manage Blocklist',
  manageblocklistDescription: 'Can manage the blocklist.',
  blocklistedItems: 'Blocklist media.',
  blocklistedItemsDescription: 'Can blocklist titles.',
  viewblocklistedItems: 'View blocklisted media.',
  viewblocklistedItemsDescription: 'Can see blocklisted titles.',
});

interface PermissionEditProps {
  actingUser?: User;
  currentUser?: User;
  currentPermission: number;
  onUpdate: (newPermissions: number) => void;
}

export const PermissionEdit = ({
  actingUser,
  currentUser,
  currentPermission,
  onUpdate,
}: PermissionEditProps) => {
  const intl = useIntl();
  const settings = useSettings();
  // Watchlists are kept on Plex for people with Plex and here for everyone
  // else, so they are named after every connected server.
  const watchlistServers = intl.formatList(
    settings.currentSettings.mediaServers.map(
      (server) => SERVER_NAMES[server.kind]
    ),
    { type: 'conjunction' }
  );
  // Music's permissions, once there is music to request. Request and
  // Auto-Approve cover music as they cover films and series.
  const musicReady = settings.currentSettings.musicReady;

  const permissionList: PermissionItem[] = [
    {
      id: 'admin',
      name: intl.formatMessage(messages.admin),
      description: intl.formatMessage(messages.adminDescription),
      permission: Permission.ADMIN,
    },
    {
      id: 'users',
      name: intl.formatMessage(messages.users),
      description: intl.formatMessage(messages.usersDescription),
      permission: Permission.MANAGE_USERS,
    },
    {
      id: 'managerequest',
      name: intl.formatMessage(messages.managerequests),
      description: intl.formatMessage(messages.managerequestsDescription),
      permission: Permission.MANAGE_REQUESTS,
      children: [
        {
          id: 'advancedrequest',
          name: intl.formatMessage(messages.advancedrequest),
          description: intl.formatMessage(messages.advancedrequestDescription),
          permission: Permission.REQUEST_ADVANCED,
        },
        {
          id: 'viewrequests',
          name: intl.formatMessage(messages.viewrequests),
          description: intl.formatMessage(messages.viewrequestsDescription),
          permission: Permission.REQUEST_VIEW,
        },
        {
          id: 'viewrecent',
          name: intl.formatMessage(messages.viewrecent),
          description: intl.formatMessage(messages.viewrecentDescription),
          permission: Permission.RECENT_VIEW,
        },
        {
          id: 'viewwatchlists',
          name: intl.formatMessage(messages.viewwatchlists, {
            mediaServerName: watchlistServers,
          }),
          description: intl.formatMessage(messages.viewwatchlistsDescription, {
            mediaServerName: watchlistServers,
          }),
          permission: Permission.WATCHLIST_VIEW,
        },
      ],
    },
    {
      id: 'request',
      name: intl.formatMessage(messages.request),
      description: intl.formatMessage(messages.requestDescription),
      permission: Permission.REQUEST,
      children: [
        {
          id: 'request-movies',
          name: intl.formatMessage(messages.requestMovies),
          description: intl.formatMessage(messages.requestMoviesDescription),
          permission: Permission.REQUEST_MOVIE,
        },
        {
          id: 'request-tv',
          name: intl.formatMessage(messages.requestTv),
          description: intl.formatMessage(messages.requestTvDescription),
          permission: Permission.REQUEST_TV,
        },
        ...(musicReady
          ? [
              {
                id: 'request-music',
                name: intl.formatMessage(messages.requestMusic),
                description: intl.formatMessage(
                  messages.requestMusicDescription
                ),
                permission: Permission.REQUEST_MUSIC,
              },
            ]
          : []),
      ],
    },
    {
      id: 'autoapprove',
      name: intl.formatMessage(messages.autoapprove),
      description: intl.formatMessage(messages.autoapproveDescription),
      permission: Permission.AUTO_APPROVE,
      requires: [{ permissions: [Permission.REQUEST] }],
      children: [
        {
          id: 'autoapprovemovies',
          name: intl.formatMessage(messages.autoapproveMovies),
          description: intl.formatMessage(
            messages.autoapproveMoviesDescription
          ),
          permission: Permission.AUTO_APPROVE_MOVIE,
          requires: [
            {
              permissions: [Permission.REQUEST, Permission.REQUEST_MOVIE],
              type: 'or',
            },
          ],
        },
        {
          id: 'autoapprovetv',
          name: intl.formatMessage(messages.autoapproveSeries),
          description: intl.formatMessage(
            messages.autoapproveSeriesDescription
          ),
          permission: Permission.AUTO_APPROVE_TV,
          requires: [
            {
              permissions: [Permission.REQUEST, Permission.REQUEST_TV],
              type: 'or',
            },
          ],
        },
        ...(musicReady
          ? [
              {
                id: 'autoapprovemusic',
                name: intl.formatMessage(messages.autoapproveMusic),
                description: intl.formatMessage(
                  messages.autoapproveMusicDescription
                ),
                permission: Permission.AUTO_APPROVE_MUSIC,
                requires: [
                  {
                    permissions: [Permission.REQUEST, Permission.REQUEST_MUSIC],
                    type: 'or' as const,
                  },
                ],
              },
            ]
          : []),
      ],
    },
    {
      id: 'autorequest',
      name: intl.formatMessage(messages.autorequest),
      description: intl.formatMessage(messages.autorequestDescription),
      permission: Permission.AUTO_REQUEST,
      requires: [{ permissions: [Permission.REQUEST] }],
      children: [
        {
          id: 'autorequestmovies',
          name: intl.formatMessage(messages.autorequestMovies),
          description: intl.formatMessage(
            messages.autorequestMoviesDescription
          ),
          permission: Permission.AUTO_REQUEST_MOVIE,
          requires: [
            {
              permissions: [Permission.REQUEST, Permission.REQUEST_MOVIE],
              type: 'or',
            },
          ],
        },
        {
          id: 'autorequesttv',
          name: intl.formatMessage(messages.autorequestSeries),
          description: intl.formatMessage(
            messages.autorequestSeriesDescription
          ),
          permission: Permission.AUTO_REQUEST_TV,
          requires: [
            {
              permissions: [Permission.REQUEST, Permission.REQUEST_TV],
              type: 'or',
            },
          ],
        },
      ],
    },
    {
      id: 'request4k',
      name: intl.formatMessage(messages.request4k),
      description: intl.formatMessage(messages.request4kDescription),
      permission: Permission.REQUEST_4K,
      children: [
        {
          id: 'request4k-movies',
          name: intl.formatMessage(messages.request4kMovies),
          description: intl.formatMessage(messages.request4kMoviesDescription),
          permission: Permission.REQUEST_4K_MOVIE,
        },
        {
          id: 'request4k-tv',
          name: intl.formatMessage(messages.request4kTv),
          description: intl.formatMessage(messages.request4kTvDescription),
          permission: Permission.REQUEST_4K_TV,
        },
      ],
    },
    {
      id: 'autoapprove4k',
      name: intl.formatMessage(messages.autoapprove4k),
      description: intl.formatMessage(messages.autoapprove4kDescription),
      permission: Permission.AUTO_APPROVE_4K,
      requires: [
        {
          permissions: [Permission.REQUEST_4K],
        },
      ],
      children: [
        {
          id: 'autoapprove4k-movies',
          name: intl.formatMessage(messages.autoapprove4kMovies),
          description: intl.formatMessage(
            messages.autoapprove4kMoviesDescription
          ),
          permission: Permission.AUTO_APPROVE_4K_MOVIE,
          requires: [
            {
              permissions: [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE],
              type: 'or',
            },
          ],
        },
        {
          id: 'autoapprove4k-tv',
          name: intl.formatMessage(messages.autoapprove4kSeries),
          description: intl.formatMessage(
            messages.autoapprove4kSeriesDescription
          ),
          permission: Permission.AUTO_APPROVE_4K_TV,
          requires: [
            {
              permissions: [Permission.REQUEST_4K, Permission.REQUEST_4K_TV],
              type: 'or',
            },
          ],
        },
      ],
    },
    {
      id: 'manageissues',
      name: intl.formatMessage(messages.manageissues),
      description: intl.formatMessage(messages.manageissuesDescription),
      permission: Permission.MANAGE_ISSUES,
      children: [
        {
          id: 'createissues',
          name: intl.formatMessage(messages.createissues),
          description: intl.formatMessage(messages.createissuesDescription),
          permission: Permission.CREATE_ISSUES,
        },
        {
          id: 'viewissues',
          name: intl.formatMessage(messages.viewissues),
          description: intl.formatMessage(messages.viewissuesDescription),
          permission: Permission.VIEW_ISSUES,
        },
      ],
    },
    {
      id: 'manageblocklist',
      name: intl.formatMessage(messages.manageblocklist),
      description: intl.formatMessage(messages.manageblocklistDescription),
      permission: Permission.MANAGE_BLOCKLIST,
      children: [
        {
          id: 'viewblocklisteditems',
          name: intl.formatMessage(messages.viewblocklistedItems),
          description: intl.formatMessage(
            messages.viewblocklistedItemsDescription
          ),
          permission: Permission.VIEW_BLOCKLIST,
        },
      ],
    },
  ];

  return (
    <>
      {permissionList.map((permissionItem) => (
        <PermissionOption
          key={`permission-option-${permissionItem.id}`}
          option={permissionItem}
          actingUser={actingUser}
          currentUser={currentUser}
          currentPermission={currentPermission}
          onUpdate={(newPermission) => onUpdate(newPermission)}
        />
      ))}
    </>
  );
};

export default PermissionEdit;
