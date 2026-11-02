import Badge from '@app/components/Common/Badge';
import CachedImage from '@app/components/Common/CachedImage';
import MusicImage from '@app/components/Music/MusicImage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import useNearScreen, { NearScreen } from '@app/hooks/useNearScreen';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { albumCoverUrl } from '@server/api/coverartarchive';
import { MediaStatus } from '@server/constants/media';
import type { PlaylistRequestGroup } from '@server/interfaces/api/requestInterfaces';
import Link from 'next/link';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestCard.PlaylistRequestCard', {
  playlistImport: 'Playlist import',
  songs: '{count, plural, one {# song} other {# songs}}',
  here: '{count} here',
  onTheWay: '{count} on the way',
  approval: '{count} waiting for approval',
  waiting: '{count} still to request',
  failed: '{count} couldn’t be downloaded',
});

/**
 * Where a playlist's songs stand, as one pill, as a request's: here, partly
 * here, on their way, waiting for approval, or failed when every song
 * requested failed.
 */
export const playlistStatus = (
  group: Pick<
    PlaylistRequestGroup,
    'here' | 'onTheWay' | 'approval' | 'waiting' | 'failed'
  >
): MediaStatus | 'failed' => {
  if (group.here > 0) {
    return group.onTheWay + group.approval + group.waiting > 0
      ? MediaStatus.PARTIALLY_AVAILABLE
      : MediaStatus.AVAILABLE;
  }
  if (group.onTheWay > 0) return MediaStatus.PROCESSING;
  if (group.approval > 0 || group.waiting > 0) return MediaStatus.PENDING;
  return group.failed > 0 ? 'failed' : MediaStatus.PENDING;
};

/**
 * The song requests made from one playlist, as one card in a row of
 * requests (Recent Requests), rather than a card for each.
 */
const PlaylistRequestCard = ({ group }: { group: PlaylistRequestGroup }) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { ref, nearness } = useNearScreen();
  // Lists are private: someone who can't open it goes to the requests.
  const href = group.canOpen
    ? `/lists/${group.listId}`
    : `/users/${group.requestedBy.id}/requests`;
  const progress = (
    [
      ['here', messages.here],
      ['onTheWay', messages.onTheWay],
      ['approval', messages.approval],
      ['waiting', messages.waiting],
      ['failed', messages.failed],
    ] as const
  )
    .filter(([key]) => group[key] > 0)
    .map(([key, message]) => intl.formatMessage(message, { count: group[key] }))
    .join(' · ')
    // A part written in lower case may come first.
    .replace(/^./, (first) => first.toLocaleUpperCase(intl.locale));
  const covers = group.albums.slice(0, 4);
  const status = playlistStatus(group);

  return (
    // As tall as a film's or a series' card, whose poster is 2:3.
    <div
      className="relative flex min-h-[9.5rem] w-72 overflow-hidden rounded-xl bg-surface p-4 text-muted shadow ring-1 ring-subtle sm:min-h-[12.5rem] sm:w-96"
      data-testid="request-card"
      ref={ref}
    >
      {covers[0] && (
        <div className="absolute inset-0 z-0" aria-hidden>
          <div className="absolute inset-0 scale-110 blur-md">
            <NearScreen.Provider value={nearness}>
              <MusicImage
                src={albumCoverUrl(covers[0])}
                fallback="none"
                sizes="384px"
              />
            </NearScreen.Provider>
          </div>
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(135deg, rgb(var(--page) / var(--title-fade)) 0%, rgb(var(--page)) 75%)',
            }}
          />
        </div>
      )}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col pr-4">
        {/* The playlist's own name stays on its page. */}
        <div className="truncate text-xs font-medium text-strong">
          {intl.formatMessage(messages.songs, { count: group.songs })}
        </div>
        <Link
          href={href}
          className="line-clamp-2 whitespace-normal break-words text-base font-bold leading-tight text-strong hover:underline sm:text-lg sm:leading-snug"
        >
          {intl.formatMessage(messages.playlistImport)}
        </Link>
        {hasPermission([Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW], {
          type: 'or',
        }) && (
          <div className="card-field truncate">
            <Link
              href={`/users/${group.requestedBy.id}`}
              className="group flex items-center"
            >
              <span className="avatar-sm">
                <CachedImage
                  type="avatar"
                  src={group.requestedBy.avatar}
                  alt=""
                  className="avatar-sm object-cover"
                  width={20}
                  height={20}
                />
              </span>
              <span className="truncate font-semibold group-hover:text-strong group-hover:underline">
                {group.requestedBy.displayName}
              </span>
            </Link>
          </div>
        )}
        {/* As a music request's albums and songs: on a phone, the status
            alone, so the card is as tall as the others in the row. */}
        {progress && (
          <div className="my-0.5 hidden whitespace-normal text-sm sm:my-1 sm:block">
            {progress}
          </div>
        )}
        <div className="mt-2 flex items-center text-sm sm:mt-1">
          <span className="mr-2 hidden font-bold sm:block">
            {intl.formatMessage(globalMessages.status)}
          </span>
          {status === 'failed' ? (
            <Badge badgeType="danger" href={href}>
              {intl.formatMessage(globalMessages.failed)}
            </Badge>
          ) : (
            <MusicStatusBadge status={status} plain />
          )}
        </div>
      </div>
      <Link
        href={href}
        className="relative z-10 w-20 flex-shrink-0 scale-100 transform-gpu self-center overflow-hidden rounded-md shadow-sm transition duration-300 hover:scale-105 hover:shadow-md sm:w-28"
        // The title on the card is the same link.
        tabIndex={-1}
        aria-hidden
      >
        <NearScreen.Provider value={nearness}>
          {covers.length >= 4 ? (
            <div className="grid grid-cols-2">
              {covers.map((album) => (
                <div
                  key={album}
                  className="relative w-full"
                  style={{ paddingBottom: '100%' }}
                >
                  <MusicImage
                    src={albumCoverUrl(album, 250)}
                    fallback="album"
                    sizes="3.5rem"
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="relative w-full" style={{ paddingBottom: '100%' }}>
              <MusicImage
                src={covers[0] ? albumCoverUrl(covers[0]) : undefined}
                fallback="album"
                sizes="7rem"
              />
            </div>
          )}
        </NearScreen.Provider>
      </Link>
    </div>
  );
};

export default PlaylistRequestCard;
