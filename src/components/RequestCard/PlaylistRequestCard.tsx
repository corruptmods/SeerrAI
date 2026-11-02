import CachedImage from '@app/components/Common/CachedImage';
import MusicImage from '@app/components/Music/MusicImage';
import useNearScreen, { NearScreen } from '@app/hooks/useNearScreen';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { albumCoverUrl } from '@server/api/coverartarchive';
import type { PlaylistRequestGroup } from '@server/interfaces/api/requestInterfaces';
import Link from 'next/link';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestCard.PlaylistRequestCard', {
  playlist: 'Playlist',
  aPlaylist: 'A playlist',
  songs: '{count, plural, one {# song} other {# songs}}',
  here: '{count} here',
  onTheWay: '{count} on the way',
  approval: '{count} waiting for approval',
  waiting: '{count} still to request',
});

/**
 * The song requests made from one playlist, as one card in a row of
 * requests (Recent Requests), rather than a card for each.
 */
const PlaylistRequestCard = ({ group }: { group: PlaylistRequestGroup }) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { ref, nearness } = useNearScreen();
  // Lists are private: someone who can't open it goes to the requests.
  const href = group.name
    ? `/lists/${group.listId}`
    : `/users/${group.requestedBy.id}/requests`;
  const progress = (
    [
      ['here', messages.here],
      ['onTheWay', messages.onTheWay],
      ['approval', messages.approval],
      ['waiting', messages.waiting],
    ] as const
  )
    .filter(([key]) => group[key] > 0)
    .map(([key, message]) => intl.formatMessage(message, { count: group[key] }))
    .join(' · ')
    // A part written in lower case may come first.
    .replace(/^./, (first) => first.toLocaleUpperCase(intl.locale));
  const covers = group.albums.slice(0, 4);

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
        <div className="truncate text-xs font-medium text-strong">
          {intl.formatMessage(messages.playlist)}
        </div>
        <Link
          href={href}
          className="line-clamp-2 whitespace-normal break-words text-base font-bold leading-tight text-strong hover:underline sm:text-lg sm:leading-snug"
        >
          {group.name ?? intl.formatMessage(messages.aPlaylist)}
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
        <div className="mt-1 text-sm font-semibold text-strong">
          {intl.formatMessage(messages.songs, { count: group.songs })}
        </div>
        {progress && (
          <div className="mt-0.5 whitespace-normal text-sm">{progress}</div>
        )}
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
