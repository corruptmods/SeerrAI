import type {
  CandidateView,
  JobStatus,
  SeriesStatus,
  TitleKind,
} from '@app/components/Backfill/types';
import Badge from '@app/components/Common/Badge';
import CachedImage from '@app/components/Common/CachedImage';
import defineMessages from '@app/utils/defineMessages';
import { FilmIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Backfill', {
  stuck: 'Stuck',
  searching: 'Searching…',
  found: 'Pack waiting for approval',
  none: 'Nothing found',
  downloading: 'Backfilling',
  ignored: 'Ignored',
  done: 'Complete',
  jobQueued: 'Waiting to start',
  jobDownloading: 'Downloading',
  jobPaused: 'Paused',
  jobImporting: 'Importing',
  jobFinishing: 'Finishing',
  jobWaitingOn: 'Waiting on {app}',
  jobDone: 'Finished',
  jobFailed: 'Failed',
  jobCancelled: 'Ended',
  anime: 'Anime',
  series: 'Series',
  movie: 'Movie',
  torrent: 'Torrent',
  usenet: 'Usenet',
  fills: 'fills {count} missing',
  upgrades: 'upgrades {count}',
  hasMovie: 'has the movie',
  upgradesMovie: 'upgrades the movie',
});

export const appName = (kind: TitleKind) =>
  kind === 'movie' ? 'Radarr' : 'Sonarr';

export const formatBytes = (bytes: number): string => {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
};

export const formatDuration = (seconds: number | null | undefined): string => {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
};

/** Episode label: "E202 · S05E23" for anime, "S05E23" otherwise. */
export const episodeLabel = (e: {
  absolute?: number;
  season?: number;
  episode?: number;
}): string => {
  const se =
    e.season !== undefined && e.episode !== undefined
      ? `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`
      : '';
  return e.absolute !== undefined && e.absolute !== null
    ? se
      ? `${e.absolute} · ${se}`
      : String(e.absolute)
    : se;
};

export const SeriesStatusBadge = ({ status }: { status: SeriesStatus }) => {
  const intl = useIntl();
  const type = (
    {
      stuck: 'warning',
      searching: 'primary',
      found: 'warning',
      none: 'danger',
      downloading: 'primary',
      ignored: 'default',
      done: 'success',
    } as const
  )[status];
  return <Badge badgeType={type}>{intl.formatMessage(messages[status])}</Badge>;
};

/**
 * A download's status pill. With its progress and its title's kind it says
 * more than the stored status: a download at 100% that is still
 * "downloading" is the client unpacking or running its script, and an
 * import is Sonarr's or Radarr's work, not Backfill's.
 */
export const JobStatusBadge = ({
  status,
  progress,
  kind,
}: {
  status: JobStatus;
  progress?: number;
  kind?: TitleKind;
}) => {
  const intl = useIntl();
  if (status === 'downloading' && (progress ?? 0) >= 100) {
    return (
      <Badge badgeType="warning">
        {intl.formatMessage(messages.jobFinishing)}
      </Badge>
    );
  }
  if (status === 'importing' && kind) {
    return (
      <Badge badgeType="primary">
        {intl.formatMessage(messages.jobWaitingOn, { app: appName(kind) })}
      </Badge>
    );
  }
  const map = {
    queued: ['default', messages.jobQueued],
    downloading: ['primary', messages.jobDownloading],
    paused: ['warning', messages.jobPaused],
    importing: ['primary', messages.jobImporting],
    done: ['success', messages.jobDone],
    failed: ['danger', messages.jobFailed],
    cancelled: ['default', messages.jobCancelled],
  } as const;
  const [type, text] = map[status];
  return <Badge badgeType={type}>{intl.formatMessage(text)}</Badge>;
};

export const TypeBadge = ({
  kind,
  seriesType,
}: {
  kind: TitleKind;
  seriesType: string;
}) => {
  const intl = useIntl();
  if (kind === 'movie') {
    return <Badge>{intl.formatMessage(messages.movie)}</Badge>;
  }
  return seriesType === 'anime' ? (
    <Badge badgeType="primary">{intl.formatMessage(messages.anime)}</Badge>
  ) : (
    <Badge>{intl.formatMessage(messages.series)}</Badge>
  );
};

export const ProtocolBadge = ({
  protocol,
}: {
  protocol: 'torrent' | 'usenet';
}) => {
  const intl = useIntl();
  return (
    <Badge badgeType="dark">
      {intl.formatMessage(
        protocol === 'torrent' ? messages.torrent : messages.usenet
      )}
    </Badge>
  );
};

/** "fills 80 missing · upgrades 103", or "has the movie". */
export const useCandidateLine = () => {
  const intl = useIntl();
  return (candidate: CandidateView, kind: TitleKind = 'series'): string => {
    const s = candidate.summary;
    if (!s) return '';
    if (kind === 'movie') {
      return intl.formatMessage(
        s.fill ? messages.hasMovie : messages.upgradesMovie
      );
    }
    return [
      s.fill ? intl.formatMessage(messages.fills, { count: s.fill }) : '',
      s.upgrade
        ? intl.formatMessage(messages.upgrades, { count: s.upgrade })
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };
};

const SIZES = {
  sm: 'h-[60px] w-10',
  md: 'h-[132px] w-[88px]',
  lg: 'h-[180px] w-[120px]',
} as const;

/**
 * A list that scrolls inside its section once it is long, so a page of
 * several lists stays one screen to move around in.
 */
export const SCROLL_LIST =
  'max-h-[min(60vh,40rem)] overflow-y-auto overscroll-contain';

export const SeriesPoster = ({
  src,
  title,
  size = 'sm',
}: {
  src?: string | null;
  title: string;
  size?: keyof typeof SIZES;
}) => (
  <div
    className={`relative flex-shrink-0 overflow-hidden rounded-md bg-gray-700 shadow ring-1 ring-gray-700 ${SIZES[size]}`}
  >
    {src ? (
      <CachedImage
        type="tvdb"
        src={src}
        alt=""
        fill
        sizes="120px"
        style={{ objectFit: 'cover' }}
      />
    ) : (
      <div className="flex h-full w-full items-center justify-center text-gray-500">
        <FilmIcon className="h-6 w-6" aria-label={title} />
      </div>
    )}
  </div>
);

export const ProgressBar = ({
  value,
  done = false,
  thick = false,
}: {
  value: number;
  done?: boolean;
  thick?: boolean;
}) => (
  <div
    className={`w-full overflow-hidden rounded-full bg-gray-900 ring-1 ring-gray-700 ${
      thick ? 'h-3' : 'h-2'
    }`}
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(value)}
  >
    <div
      className={`h-full rounded-full transition-[width] duration-700 ease-out ${
        done
          ? 'bg-gradient-to-r from-green-600 to-green-400'
          : 'bg-gradient-to-r from-indigo-500 to-purple-400'
      }`}
      style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
    />
  </div>
);

/** The Backfill page's header buttons: equal and level, however long. */
export const HEADER_BUTTON =
  'h-full w-full !whitespace-normal !px-1.5 text-center !text-[13px] !leading-tight sm:!px-4 sm:!text-sm lg:w-auto';
/** On a phone the names alone fit the row; the icons come back wider. */
export const HEADER_ICON = 'hidden sm:block';
