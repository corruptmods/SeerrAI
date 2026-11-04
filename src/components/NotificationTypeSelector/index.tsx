import NotificationType from '@app/components/NotificationTypeSelector/NotificationType';
import useSettings from '@app/hooks/useSettings';
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import sortBy from 'lodash/sortBy';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.NotificationTypeSelector', {
  notificationTypes: 'Notification Types',
  mediarequested: 'Request Pending Approval',
  mediarequestedDescription: 'When requests need approval.',
  usermediarequestedDescription: 'When other users’ requests need approval.',
  mediaapproved: 'Request Approved',
  mediaapprovedDescription: 'When requests are approved by hand.',
  usermediaapprovedDescription: 'When your requests are approved.',
  mediaAutoApproved: 'Request Automatically Approved',
  mediaAutoApprovedDescription: 'When requests are approved automatically.',
  usermediaAutoApprovedDescription:
    'When other users’ requests are approved automatically.',
  listactivity: 'List Activity',
  listactivityDescription:
    'When someone adds to or removes from a list shared with you.',
  mediaavailable: 'Request Available',
  mediaavailableDescription: 'When requests become available.',
  usermediaavailableDescription: 'When your requests become available.',
  mediafailed: 'Request Processing Failed',
  mediafailedDescription: 'When requests can’t be added to Radarr or Sonarr.',
  usermediafailedDescription: 'When other users’ requests fail.',
  requestFailed: 'Request Failed',
  requestFailedDescription: 'When a request of yours fails.',
  playlistUpdate: 'Playlist Updates',
  playlistUpdateDescription:
    'When songs from a playlist you imported can’t be got, or the playlist can no longer be read.',
  leavingSoon: 'Leaving Soon',
  leavingSoonDescription:
    'When something you requested is about to be deleted.',
  turnedOff: 'Turned off for everyone in Settings → Notifications.',
  mediadeclined: 'Request Declined',
  mediadeclinedDescription: 'When requests are declined.',
  usermediadeclinedDescription: 'When your requests are declined.',
  issuecreated: 'Issue Reported',
  issuecreatedDescription: 'When issues are reported.',
  userissuecreatedDescription: 'When other users report issues.',
  issuecomment: 'Issue Comment',
  issuecommentDescription: 'When issues get new comments.',
  userissuecommentDescription: 'When issues you reported get new comments.',
  adminissuecommentDescription: 'When other users comment on issues.',
  issueresolved: 'Issue Resolved',
  issueresolvedDescription: 'When issues are resolved.',
  userissueresolvedDescription: 'When issues you reported are resolved.',
  adminissueresolvedDescription: 'When other users resolve issues.',
  issuereopened: 'Issue Reopened',
  issuereopenedDescription: 'When issues are reopened.',
  userissuereopenedDescription: 'When issues you reported are reopened.',
  adminissuereopenedDescription: 'When other users reopen issues.',
  mediaautorequested: 'Request Automatically Submitted',
  mediaautorequestedDescription:
    'When titles on your watchlist are requested automatically.',
  backfill: 'Backfill',
  backfillDescription:
    'When Backfill has a pack to approve, or a backfill finishes or fails.',
  userbackfillDescription:
    'When Backfill has a pack for you to approve, or a backfill finishes or fails.',
  health: 'Health',
  healthDescription:
    'When a connected service has a new problem, like being down or a full disk.',
  userhealthDescription:
    'When a connected service has a new problem, like being down or a full disk.',
  wrongMatch: 'Wrong Match',
  wrongMatchDescription:
    'When a media server matches a new import to the wrong title.',
  userwrongMatchDescription:
    'When a media server matches a new import to the wrong title.',
});

export const hasNotificationType = (
  types: Notification | Notification[],
  value: number
): boolean => {
  let total: number;

  // If we are not checking any notifications, bail out and return true
  if (types === 0) {
    return true;
  }

  if (Array.isArray(types)) {
    // Combine all notification values into one
    total = types.reduce((a, v) => a + v, 0);
  } else {
    total = types;
  }

  // Test notifications don't need to be enabled
  if (!(value & Notification.TEST_NOTIFICATION)) {
    value += Notification.TEST_NOTIFICATION;
  }

  return !!(value & total);
};

export enum Notification {
  NONE = 0,
  MEDIA_PENDING = 2,
  MEDIA_APPROVED = 4,
  MEDIA_AVAILABLE = 8,
  MEDIA_FAILED = 16,
  TEST_NOTIFICATION = 32,
  MEDIA_DECLINED = 64,
  MEDIA_AUTO_APPROVED = 128,
  ISSUE_CREATED = 256,
  ISSUE_COMMENT = 512,
  ISSUE_RESOLVED = 1024,
  ISSUE_REOPENED = 2048,
  MEDIA_AUTO_REQUESTED = 4096,
  LIST_ACTIVITY = 8192,
  PLEX_REAUTH = 16384,
  BACKFILL = 32768,
  HEALTH = 65536,
  WRONG_MATCH = 131072,
  PLAYLIST_UPDATE = 262144,
  REQUEST_FAILED = 524288,
  LEAVING_SOON = 1048576,
}

export const ALL_NOTIFICATIONS = Object.values(Notification)
  .filter((v) => !isNaN(Number(v)))
  .reduce((a, v) => a + Number(v), 0);

/** What web push sends someone who hasn't chosen (as the server does). */
export const WEB_PUSH_STARTING_TYPES =
  Notification.MEDIA_AVAILABLE |
  Notification.MEDIA_FAILED |
  Notification.REQUEST_FAILED |
  Notification.LIST_ACTIVITY |
  Notification.PLAYLIST_UPDATE |
  Notification.LEAVING_SOON |
  Notification.PLEX_REAUTH |
  Notification.BACKFILL |
  Notification.HEALTH |
  Notification.WRONG_MATCH |
  Notification.TEST_NOTIFICATION;

export interface NotificationItem {
  id: string;
  name: string;
  description: string;
  value: Notification;
  hasNotifyUser: boolean;
  children?: NotificationItem[];
  hidden?: boolean;
  /** Only ever the person's own, never sent to a shared channel. */
  personal?: boolean;
  /** Shown, but turned off for everyone by the admin. */
  turnedOff?: boolean;
}

interface NotificationTypeSelectorProps {
  user?: User;
  enabledTypes?: number;
  currentTypes: number;
  onUpdate: (newTypes: number) => void;
  error?: string;
  /**
   * The person is told in a shared channel (Discord): their own types,
   * which never reach a channel, are left out, and those the admin turned
   * off are shown greyed rather than hidden.
   */
  channel?: boolean;
}

const NotificationTypeSelector = ({
  user,
  enabledTypes = ALL_NOTIFICATIONS,
  currentTypes,
  onUpdate,
  error,
  channel = false,
}: NotificationTypeSelectorProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { hasPermission } = useUser({ id: user?.id });
  const [allowedTypes, setAllowedTypes] = useState(enabledTypes);

  const availableTypes = useMemo(() => {
    const allRequestsAutoApproved =
      user &&
      // Has Manage Requests perm, which grants all Auto-Approve perms
      (hasPermission(Permission.MANAGE_REQUESTS) ||
        // Cannot submit requests of any type
        !hasPermission(
          [
            Permission.REQUEST,
            Permission.REQUEST_MOVIE,
            Permission.REQUEST_TV,
            Permission.REQUEST_4K,
            Permission.REQUEST_4K_MOVIE,
            Permission.REQUEST_4K_TV,
          ],
          { type: 'or' }
        ) ||
        // Cannot submit non-4K movie requests OR has Auto-Approve perms for non-4K movies
        ((!hasPermission([Permission.REQUEST, Permission.REQUEST_MOVIE], {
          type: 'or',
        }) ||
          hasPermission(
            [Permission.AUTO_APPROVE, Permission.AUTO_APPROVE_MOVIE],
            { type: 'or' }
          )) &&
          // Cannot submit non-4K series requests OR has Auto-Approve perms for non-4K series
          (!hasPermission([Permission.REQUEST, Permission.REQUEST_TV], {
            type: 'or',
          }) ||
            hasPermission(
              [Permission.AUTO_APPROVE, Permission.AUTO_APPROVE_TV],
              { type: 'or' }
            )) &&
          // Cannot submit 4K movie requests OR has Auto-Approve perms for 4K movies
          (!settings.currentSettings.movie4kEnabled ||
            !hasPermission(
              [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE],
              { type: 'or' }
            ) ||
            hasPermission(
              [Permission.AUTO_APPROVE_4K, Permission.AUTO_APPROVE_4K_MOVIE],
              { type: 'or' }
            )) &&
          // Cannot submit 4K series requests OR has Auto-Approve perms for 4K series
          (!settings.currentSettings.series4kEnabled ||
            !hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_TV], {
              type: 'or',
            }) ||
            hasPermission(
              [Permission.AUTO_APPROVE_4K, Permission.AUTO_APPROVE_4K_TV],
              { type: 'or' }
            ))));

    const types: NotificationItem[] = [
      {
        id: 'media-auto-requested',
        name: intl.formatMessage(messages.mediaautorequested),
        description: intl.formatMessage(messages.mediaautorequestedDescription),
        value: Notification.MEDIA_AUTO_REQUESTED,
        hidden:
          !user ||
          (!user.settings?.watchlistSyncMovies &&
            !user.settings?.watchlistSyncTv) ||
          !hasPermission(
            [
              Permission.AUTO_REQUEST,
              Permission.AUTO_REQUEST_MOVIE,
              Permission.AUTO_REQUEST_TV,
            ],
            { type: 'or' }
          ),
        hasNotifyUser: true,
      },
      {
        id: 'media-requested',
        name: intl.formatMessage(messages.mediarequested),
        description: intl.formatMessage(
          user
            ? messages.usermediarequestedDescription
            : messages.mediarequestedDescription
        ),
        value: Notification.MEDIA_PENDING,
        hasNotifyUser: false,
        hidden: user && !hasPermission(Permission.MANAGE_REQUESTS),
      },
      {
        id: 'media-auto-approved',
        name: intl.formatMessage(messages.mediaAutoApproved),
        description: intl.formatMessage(
          user
            ? messages.usermediaAutoApprovedDescription
            : messages.mediaAutoApprovedDescription
        ),
        value: Notification.MEDIA_AUTO_APPROVED,
        hasNotifyUser: false,
        hidden: user && !hasPermission(Permission.MANAGE_REQUESTS),
      },
      {
        id: 'media-approved',
        name: intl.formatMessage(messages.mediaapproved),
        description: intl.formatMessage(
          user
            ? messages.usermediaapprovedDescription
            : messages.mediaapprovedDescription
        ),
        value: Notification.MEDIA_APPROVED,
        hasNotifyUser: true,
        hidden: allRequestsAutoApproved,
      },
      {
        id: 'media-declined',
        name: intl.formatMessage(messages.mediadeclined),
        description: intl.formatMessage(
          user
            ? messages.usermediadeclinedDescription
            : messages.mediadeclinedDescription
        ),
        value: Notification.MEDIA_DECLINED,
        hasNotifyUser: true,
        hidden: allRequestsAutoApproved,
      },
      {
        id: 'list-activity',
        name: intl.formatMessage(messages.listactivity),
        description: intl.formatMessage(messages.listactivityDescription),
        value: Notification.LIST_ACTIVITY,
        hasNotifyUser: true,
        // Only ever sent to the people a list is shared with, through their
        // own settings: a channel never gets it.
        hidden: !user,
        personal: true,
      },
      {
        id: 'playlist-update',
        name: intl.formatMessage(messages.playlistUpdate),
        description: intl.formatMessage(messages.playlistUpdateDescription),
        value: Notification.PLAYLIST_UPDATE,
        hasNotifyUser: true,
        hidden: !user,
        personal: true,
      },
      {
        id: 'leaving-soon',
        name: intl.formatMessage(messages.leavingSoon),
        description: intl.formatMessage(messages.leavingSoonDescription),
        value: Notification.LEAVING_SOON,
        hasNotifyUser: true,
        hidden: !user,
        personal: true,
      },
      {
        id: 'media-available',
        name: intl.formatMessage(messages.mediaavailable),
        description: intl.formatMessage(
          user
            ? messages.usermediaavailableDescription
            : messages.mediaavailableDescription
        ),
        value: Notification.MEDIA_AVAILABLE,
        hasNotifyUser: true,
      },
      {
        id: 'media-failed',
        name: intl.formatMessage(messages.mediafailed),
        description: intl.formatMessage(
          user
            ? messages.usermediafailedDescription
            : messages.mediafailedDescription
        ),
        value: Notification.MEDIA_FAILED,
        hidden: user && !hasPermission(Permission.MANAGE_REQUESTS),
        hasNotifyUser: false,
      },
      {
        id: 'request-failed',
        name: intl.formatMessage(messages.requestFailed),
        description: intl.formatMessage(messages.requestFailedDescription),
        value: Notification.REQUEST_FAILED,
        hasNotifyUser: true,
        hidden: !user,
        personal: true,
      },
      {
        id: 'issue-created',
        name: intl.formatMessage(messages.issuecreated),
        description: intl.formatMessage(
          user
            ? messages.userissuecreatedDescription
            : messages.issuecreatedDescription
        ),
        value: Notification.ISSUE_CREATED,
        hidden: user && !hasPermission(Permission.MANAGE_ISSUES),
        hasNotifyUser: false,
      },
      {
        id: 'issue-comment',
        name: intl.formatMessage(messages.issuecomment),
        description: intl.formatMessage(
          user
            ? hasPermission(Permission.MANAGE_ISSUES)
              ? messages.adminissuecommentDescription
              : messages.userissuecommentDescription
            : messages.issuecommentDescription
        ),
        value: Notification.ISSUE_COMMENT,
        hidden:
          user &&
          !hasPermission([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
            type: 'or',
          }),
        hasNotifyUser:
          !user || hasPermission(Permission.MANAGE_ISSUES) ? false : true,
      },
      {
        id: 'issue-resolved',
        name: intl.formatMessage(messages.issueresolved),
        description: intl.formatMessage(
          user
            ? hasPermission(Permission.MANAGE_ISSUES)
              ? messages.adminissueresolvedDescription
              : messages.userissueresolvedDescription
            : messages.issueresolvedDescription
        ),
        value: Notification.ISSUE_RESOLVED,
        hidden:
          user &&
          !hasPermission([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
            type: 'or',
          }),
        hasNotifyUser:
          !user || hasPermission(Permission.MANAGE_ISSUES) ? false : true,
      },
      {
        id: 'issue-reopened',
        name: intl.formatMessage(messages.issuereopened),
        description: intl.formatMessage(
          user
            ? hasPermission(Permission.MANAGE_ISSUES)
              ? messages.adminissuereopenedDescription
              : messages.userissuereopenedDescription
            : messages.issuereopenedDescription
        ),
        value: Notification.ISSUE_REOPENED,
        hidden:
          user &&
          !hasPermission([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
            type: 'or',
          }),
        hasNotifyUser:
          !user || hasPermission(Permission.MANAGE_ISSUES) ? false : true,
      },
      {
        id: 'backfill',
        name: intl.formatMessage(messages.backfill),
        description: intl.formatMessage(
          user ? messages.userbackfillDescription : messages.backfillDescription
        ),
        value: Notification.BACKFILL,
        hidden: user && !hasPermission(Permission.ADMIN),
        hasNotifyUser: false,
      },
      {
        id: 'health',
        name: intl.formatMessage(messages.health),
        description: intl.formatMessage(
          user ? messages.userhealthDescription : messages.healthDescription
        ),
        value: Notification.HEALTH,
        hidden: user && !hasPermission(Permission.ADMIN),
        hasNotifyUser: false,
      },
      {
        id: 'wrong-match',
        name: intl.formatMessage(messages.wrongMatch),
        description: intl.formatMessage(
          user
            ? messages.userwrongMatchDescription
            : messages.wrongMatchDescription
        ),
        value: Notification.WRONG_MATCH,
        hidden: user && !hasPermission(Permission.ADMIN),
        hasNotifyUser: false,
      },
    ];

    const shown = types.filter((type) => !type.hidden);
    const filteredTypes = (
      channel ? shown.filter((type) => !type.personal) : shown
    ).flatMap((type) =>
      hasNotificationType(type.value, enabledTypes)
        ? [type]
        : channel
          ? [{ ...type, turnedOff: true }]
          : []
    );

    const newAllowedTypes = filteredTypes
      .filter((type) => !type.turnedOff)
      .reduce((a, v) => a + v.value, 0);
    if (newAllowedTypes !== allowedTypes) {
      setAllowedTypes(newAllowedTypes);
    }

    // What the admin turned off goes last, after what can be chosen.
    return sortBy(
      filteredTypes,
      (type) => (type.turnedOff ? 1 : 0),
      ...(user ? [(type: NotificationItem) => type.hasNotifyUser] : [])
    );
  }, [
    user,
    hasPermission,
    settings,
    intl,
    allowedTypes,
    enabledTypes,
    channel,
  ]);

  if (!availableTypes.length) {
    return null;
  }

  return (
    <div role="group" aria-labelledby="group-label" className="form-group">
      <div className="form-row">
        <span id="group-label" className="group-label">
          {intl.formatMessage(messages.notificationTypes)}
          {!user && <span className="label-required">*</span>}
        </span>
        <div className="form-input-area">
          <div className="max-w-lg">
            {availableTypes.map((type) => (
              <NotificationType
                key={`notification-type-${type.id}`}
                option={type}
                currentTypes={currentTypes}
                onUpdate={onUpdate}
                turnedOffNote={intl.formatMessage(messages.turnedOff)}
              />
            ))}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  );
};

export default NotificationTypeSelector;
