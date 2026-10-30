import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import MusicImage from '@app/components/Music/MusicImage';
import { albumCoverUrl, trackLength } from '@app/components/Music/musicHelpers';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type {
  PlaylistSongShown,
  PlaylistSongView,
  PlaylistView,
} from '@server/lib/playlists/view';
import Link from 'next/link';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaLists.PlaylistSongs', {
  linkedTo: 'Linked to {name} on {service}',
  readAt: 'read {time}',
  unlink: 'Unlink',
  readProblem: 'It couldn’t be read last time: {problem}',
  empty:
    'No songs yet. Import a Spotify or Apple Music playlist’s share link to bring its songs in, and they’re requested for you.',
  notLinked:
    'Import a Spotify or Apple Music playlist’s share link to bring its songs in.',
  matching: 'Finding it…',
  queued: 'About to be requested',
  limit: 'Waiting for your limit',
  limitTip:
    'Requested by itself once your song limit allows it, the next day or after.',
  approval: 'Waiting for approval',
  requested: 'Requested',
  here: 'Here or on its way',
  declined: 'Declined',
  failed: 'Can’t be requested',
  unmatched: 'Not found',
  unmatchedTip:
    'MusicBrainz doesn’t know this song, so it can’t be requested yet. Music that’s only on Spotify or YouTube often isn’t there. It’s looked for again each week.',
  notFoundTitle: 'Not found on MusicBrainz',
  notFoundIntro:
    'These can’t be requested yet: MusicBrainz, where songs are found for Lidarr, doesn’t know them. Songs released only on Spotify or YouTube often aren’t there. Each is looked for again every week, or now with Try again.',
  tryAgain: 'Try again',
  remove: 'Take off the playlist',
  summary:
    '{requested} requested · {waiting} waiting · {finding} being found · {notFound} not found',
});

const BADGE: Record<
  PlaylistSongShown,
  'default' | 'primary' | 'danger' | 'warning' | 'success'
> = {
  matching: 'default',
  queued: 'default',
  limit: 'warning',
  approval: 'warning',
  requested: 'primary',
  here: 'success',
  declined: 'danger',
  failed: 'danger',
  unmatched: 'danger',
};

interface PlaylistSongsProps {
  playlist: PlaylistView;
  isOwner: boolean;
  onUnlink: () => void;
  onRemove: (song: PlaylistSongView) => void;
  onRetry: (song: PlaylistSongView) => void;
}

const SERVICE_NAMES: Record<string, string> = {
  spotify: 'Spotify',
  apple: 'Apple Music',
};

/**
 * A playlist's songs, each with where its request is, and its link to
 * Spotify or Apple Music. Songs MusicBrainz doesn't know are set apart at
 * the end: they can't be requested until it does.
 */
const PlaylistSongs = ({
  playlist,
  isOwner,
  onUnlink,
  onRemove,
  onRetry,
}: PlaylistSongsProps) => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const found = playlist.songs.filter((s) => s.state !== 'unmatched');
  const notFound = playlist.songs.filter((s) => s.state === 'unmatched');
  const count = (states: PlaylistSongShown[]) =>
    playlist.songs.filter((s) => states.includes(s.state)).length;

  const row = (song: PlaylistSongView) => {
    const label = intl.formatMessage(messages[song.state]);
    const tip =
      song.state === 'limit'
        ? intl.formatMessage(messages.limitTip)
        : song.state === 'unmatched'
          ? intl.formatMessage(messages.unmatchedTip)
          : (song.problem ?? undefined);
    return (
      <li
        key={song.id}
        className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-gray-800/60"
      >
        <div className="relative h-11 w-11 flex-none overflow-hidden rounded">
          <MusicImage
            src={
              song.albumMbid
                ? albumCoverUrl(song.albumMbid, !!currentSettings.cacheImages)
                : undefined
            }
            fallback="album"
            sizes="2.75rem"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-strong">
            {song.title}
          </div>
          <div className="truncate text-xs text-muted">
            {song.artistMbid ? (
              <Link
                href={`/music/artist/${song.artistMbid}`}
                className="hover:underline"
              >
                {song.artistName}
              </Link>
            ) : (
              song.artistName
            )}
            {song.length ? ` · ${trackLength(song.length)}` : ''}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {tip ? (
            <Tooltip content={tip}>
              <span>
                <Badge badgeType={BADGE[song.state]}>{label}</Badge>
              </span>
            </Tooltip>
          ) : (
            <Badge badgeType={BADGE[song.state]}>{label}</Badge>
          )}
          {(song.state === 'unmatched' || song.state === 'failed') && (
            <Tooltip content={intl.formatMessage(messages.tryAgain)}>
              <button
                type="button"
                className="rounded p-1 text-gray-400 hover:text-strong"
                aria-label={intl.formatMessage(messages.tryAgain)}
                onClick={() => onRetry(song)}
              >
                <ArrowPathIcon className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
          <Tooltip content={intl.formatMessage(messages.remove)}>
            <button
              type="button"
              className="rounded p-1 text-gray-400 hover:text-red-400"
              aria-label={intl.formatMessage(messages.remove)}
              onClick={() => onRemove(song)}
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </li>
    );
  };

  return (
    <div>
      {playlist.sourceUrl ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
          <LinkIcon className="h-4 w-4 flex-none" />
          <a
            href={playlist.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {intl.formatMessage(messages.linkedTo, {
              name: playlist.sourceName ?? '',
              service: SERVICE_NAMES[playlist.sourceService ?? ''] ?? '',
            })}
          </a>
          {playlist.sourceReadAt && (
            <span>
              {intl.formatMessage(messages.readAt, {
                time: intl.formatRelativeTime(
                  Math.round(
                    (new Date(playlist.sourceReadAt).getTime() - Date.now()) /
                      3_600_000
                  ),
                  'hours',
                  { numeric: 'auto' }
                ),
              })}
            </span>
          )}
          {isOwner && (
            <Button buttonSize="sm" onClick={onUnlink}>
              {intl.formatMessage(messages.unlink)}
            </Button>
          )}
        </div>
      ) : (
        playlist.songs.length > 0 &&
        isOwner && (
          <p className="mb-4 text-sm text-muted">
            {intl.formatMessage(messages.notLinked)}
          </p>
        )
      )}
      {playlist.sourceProblem && (
        <p className="mb-4 flex items-center gap-2 text-sm text-yellow-400 light:text-warning-text">
          <ExclamationTriangleIcon className="h-4 w-4 flex-none" />
          {intl.formatMessage(messages.readProblem, {
            problem: playlist.sourceProblem,
          })}
        </p>
      )}

      {!playlist.songs.length ? (
        <p className="text-muted">{intl.formatMessage(messages.empty)}</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">
            {intl.formatMessage(messages.summary, {
              requested: count(['requested', 'approval', 'here']),
              waiting: count(['limit', 'queued']),
              finding: count(['matching']),
              notFound: notFound.length,
            })}
          </p>
          <ul className="mb-8 space-y-1">{found.map(row)}</ul>
          {notFound.length > 0 && (
            <>
              <h2 className="mb-1 text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.notFoundTitle)}
              </h2>
              <p className="mb-3 text-sm text-muted">
                {intl.formatMessage(messages.notFoundIntro)}
              </p>
              <ul className="space-y-1">{notFound.map(row)}</ul>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default PlaylistSongs;
