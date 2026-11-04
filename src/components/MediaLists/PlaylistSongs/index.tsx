import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import MusicImage from '@app/components/Music/MusicImage';
import { albumCoverUrl, trackLength } from '@app/components/Music/musicHelpers';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { SongProgress } from '@server/lib/music/songProgress';
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
  notGot: 'Couldn’t be downloaded',
  notGotTip:
    'No download of its album with this song could be got. Try again to look once more.',
  unmatched: 'Not found',
  unmatchedTip:
    'MusicBrainz doesn’t know this song, so it can’t be requested yet. Music that’s only on Spotify or YouTube often isn’t there. It’s looked for again each week.',
  notFoundTitle: 'Not found on MusicBrainz',
  notFoundIntro:
    'These can’t be requested yet: MusicBrainz, where songs are found for Lidarr, doesn’t know them. Songs released only on Spotify or YouTube often aren’t there. Each is looked for again every week, or now with Try again.',
  tryAgain: 'Try again',
  addToMusicBrainz: 'Add to MusicBrainz',
  addToMusicBrainzTip:
    'Opens Harmony with its album filled in from Deezer, ready to add to MusicBrainz. Once it’s added, Try again to request it.',
  remove: 'Take off the playlist',
  waitingToSearch:
    'Albums with nothing found yet, to be searched again later: {count}',
  searchAgain: 'Search again now',
  statWaiting: 'Waiting',
  statFinding: 'Being found',
  onTheirWay: 'On their way',
  beingSearched: 'Being searched for',
  searchedLater: 'Searched again later',
  stepSearching: 'Searching',
  stepWaiting: 'Nothing found yet',
  stepFound: 'Found',
  stepDownloading: 'Downloading',
  stepImporting: 'Importing',
  progressSingle: 'Lidarr is searching for the single “{release}”',
  progressPreparing: 'Getting “{release}” ready to search',
  progressSearching: 'Searching for “{release}”',
  progressWaiting: 'Nothing found on “{release}” yet. Searching again {time}.',
  progressSlot: 'Found on “{release}”, waiting for a free download slot',
  progressDownloading: 'Downloading from “{release}”, {percent}%',
  progressDownloadingStarted: 'Downloading from “{release}”',
  progressImporting: 'Importing from “{release}”',
});

/** The badge a song on its way shows instead of Requested. */
const STEP_LABEL = {
  single: 'stepSearching',
  preparing: 'stepSearching',
  searching: 'stepSearching',
  waiting: 'stepWaiting',
  slot: 'stepFound',
  downloading: 'stepDownloading',
  importing: 'stepImporting',
} as const satisfies Record<SongProgress['step'], keyof typeof messages>;

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
  notGot: 'danger',
  unmatched: 'danger',
};

interface PlaylistSongsProps {
  playlist: PlaylistView;
  isOwner: boolean;
  onUnlink: () => void;
  onRemove: (song: PlaylistSongView) => void;
  onRetry: (song: PlaylistSongView) => void;
  onSearchAgain: () => void;
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
  onSearchAgain,
}: PlaylistSongsProps) => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const found = playlist.songs.filter((s) => s.state !== 'unmatched');
  const notFound = playlist.songs.filter((s) => s.state === 'unmatched');
  const count = (states: PlaylistSongShown[]) =>
    playlist.songs.filter((s) => states.includes(s.state)).length;

  /** Where a song on its way is, in words. */
  const progressText = (progress: SongProgress): string => {
    const release = progress.release;
    switch (progress.step) {
      case 'single':
        return intl.formatMessage(messages.progressSingle, { release });
      case 'preparing':
        return intl.formatMessage(messages.progressPreparing, { release });
      case 'searching':
        return intl.formatMessage(messages.progressSearching, { release });
      case 'waiting':
        return intl.formatMessage(messages.progressWaiting, {
          release,
          time: intl.formatDate(progress.searchAgainAt, {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit',
          }),
        });
      case 'slot':
        return intl.formatMessage(messages.progressSlot, { release });
      case 'downloading':
        return progress.percent === null
          ? intl.formatMessage(messages.progressDownloadingStarted, {
              release,
            })
          : intl.formatMessage(messages.progressDownloading, {
              release,
              percent: progress.percent,
            });
      case 'importing':
        return intl.formatMessage(messages.progressImporting, { release });
    }
  };

  const onItsWay = playlist.songs.filter(
    (song) => song.state === 'requested' && song.progress
  );
  const steps = (wanted: SongProgress['step'][]) =>
    onItsWay.filter((song) => wanted.includes(song.progress!.step)).length;

  const row = (song: PlaylistSongView) => {
    const progress = song.state === 'requested' ? song.progress : null;
    const label = intl.formatMessage(
      progress ? messages[STEP_LABEL[progress.step]] : messages[song.state]
    );
    const tip =
      song.state === 'limit'
        ? intl.formatMessage(messages.limitTip)
        : song.state === 'unmatched'
          ? intl.formatMessage(messages.unmatchedTip)
          : song.state === 'notGot'
            ? intl.formatMessage(messages.notGotTip)
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
          <div className="break-words text-sm font-semibold text-strong">
            {song.title}
          </div>
          <div className="break-words text-xs text-muted">
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
          {progress && (
            <div className="mt-0.5 break-words text-xs text-muted">
              {progressText(progress)}
            </div>
          )}
          {song.addToMusicBrainz && (
            <Tooltip content={intl.formatMessage(messages.addToMusicBrainzTip)}>
              <a
                href={song.addToMusicBrainz}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 inline-flex items-center gap-1 text-xs text-gray-400 hover:text-strong hover:underline"
              >
                {intl.formatMessage(messages.addToMusicBrainz)}
                <ArrowTopRightOnSquareIcon className="h-3 w-3" />
              </a>
            </Tooltip>
          )}
          {/* Why, in words: a tooltip can't be read on a phone. */}
          {(song.state === 'failed' || song.state === 'notGot') && tip && (
            <div className="mt-0.5 break-words text-xs text-red-300 light:text-danger-text">
              {tip}
            </div>
          )}
        </div>
        <div className="flex flex-none items-center gap-2">
          {tip ? (
            <Tooltip content={tip}>
              <span>
                <Badge badgeType={BADGE[song.state]}>{label}</Badge>
              </span>
            </Tooltip>
          ) : (
            <Badge
              badgeType={
                progress?.step === 'downloading' ||
                progress?.step === 'importing'
                  ? 'success'
                  : progress?.step === 'waiting'
                    ? 'warning'
                    : BADGE[song.state]
              }
            >
              {label}
            </Badge>
          )}
          {(song.state === 'unmatched' ||
            song.state === 'failed' ||
            song.state === 'notGot') && (
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

  // The songs on their way, by step: their share of the bar, and its key.
  const way = [
    {
      key: 'downloading',
      count: steps(['slot', 'downloading', 'importing']),
      label: messages.stepDownloading,
      bar: 'bg-green-500',
    },
    {
      key: 'searching',
      count: steps(['single', 'preparing', 'searching']),
      label: messages.beingSearched,
      bar: 'bg-indigo-500',
    },
    {
      key: 'later',
      count: steps(['waiting']),
      label: messages.searchedLater,
      bar: 'bg-yellow-500',
    },
  ];
  const stats = [
    {
      key: 'requested',
      count: count(['requested', 'approval', 'here']),
      label: messages.requested,
      tone: 'text-strong',
    },
    {
      key: 'waiting',
      count: count(['limit', 'queued']),
      label: messages.statWaiting,
      tone: 'text-strong',
    },
    {
      key: 'finding',
      count: count(['matching']),
      label: messages.statFinding,
      tone: 'text-strong',
    },
    {
      key: 'notFound',
      count: notFound.length,
      label: messages.unmatched,
      tone: notFound.length
        ? 'text-red-400 light:text-danger-text'
        : 'text-strong',
    },
  ];

  return (
    <div>
      {playlist.sourceUrl ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-subtle bg-surface px-4 py-3">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-gray-700/60">
            <LinkIcon className="h-4 w-4 text-gray-300" />
          </span>
          <div className="min-w-0 flex-1">
            <a
              href={playlist.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="block break-words font-semibold text-strong hover:underline"
            >
              {intl.formatMessage(messages.linkedTo, {
                name: playlist.sourceName ?? '',
                service: SERVICE_NAMES[playlist.sourceService ?? ''] ?? '',
              })}
            </a>
            {playlist.sourceReadAt && (
              <span className="text-xs text-muted">
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
          </div>
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
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats.map((stat) => (
              <div
                key={stat.key}
                className="rounded-lg border border-subtle bg-surface px-4 py-3"
              >
                <div className={`text-2xl font-bold ${stat.tone}`}>
                  {intl.formatNumber(stat.count)}
                </div>
                <div className="text-xs text-muted">
                  {intl.formatMessage(stat.label)}
                </div>
              </div>
            ))}
          </div>
          {(onItsWay.length > 0 || playlist.waitingToSearch > 0) && (
            <div className="mb-6 rounded-lg border border-subtle bg-surface px-4 py-3">
              {onItsWay.length > 0 && (
                <>
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold text-strong">
                      {intl.formatMessage(messages.onTheirWay)}
                    </span>
                    <span className="text-xs text-muted">
                      {intl.formatNumber(onItsWay.length)}
                    </span>
                  </div>
                  <div className="flex h-2 overflow-hidden rounded-full bg-gray-700">
                    {way
                      .filter((part) => part.count)
                      .map((part) => (
                        <div
                          key={part.key}
                          className={part.bar}
                          style={{
                            width: `${(part.count / onItsWay.length) * 100}%`,
                          }}
                        />
                      ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    {way.map((part) => (
                      <span
                        key={part.key}
                        className="flex items-center gap-1.5"
                      >
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${part.bar}`}
                        />
                        {intl.formatMessage(part.label)}{' '}
                        <span className="font-semibold text-strong">
                          {intl.formatNumber(part.count)}
                        </span>
                      </span>
                    ))}
                  </div>
                </>
              )}
              {playlist.waitingToSearch > 0 && (
                <div
                  className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm text-muted ${
                    onItsWay.length > 0
                      ? 'mt-3 border-t border-subtle pt-3'
                      : ''
                  }`}
                >
                  <span>
                    {intl.formatMessage(messages.waitingToSearch, {
                      count: playlist.waitingToSearch,
                    })}
                  </span>
                  <Button buttonSize="sm" onClick={onSearchAgain}>
                    <ArrowPathIcon />
                    <span>{intl.formatMessage(messages.searchAgain)}</span>
                  </Button>
                </div>
              )}
            </div>
          )}
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
