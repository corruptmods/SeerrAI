import useSettings from '@app/hooks/useSettings';
import type { SubtitlesKind } from '@app/hooks/useSubtitles';
import defineMessages from '@app/utils/defineMessages';
import { SERVER_NAMES } from '@app/utils/mediaServerAccounts';
import { formatOf, formatSize, providerName } from '@app/utils/subtitles';
import { ArrowPathIcon, TrashIcon } from '@heroicons/react/24/outline';
import type {
  SubtitleError,
  SubtitleTrack,
} from '@server/interfaces/api/subtitlesInterfaces';
import { isAxiosError } from 'axios';
import type { ReactNode } from 'react';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';

/*
 * The pieces the Subtitles card and an episode's subtitle panel share, so a
 * movie, a series and one episode look and read the same.
 */

export const messages = defineMessages('components.Subtitles', {
  ai: 'AI',
  missingTag: 'MISSING',
  sdh: 'SDH',
  forced: 'FORCED',
  yourDefault: 'Your default',
  notInProfile: 'Not in profile',
  besideTheMovie: 'File beside the movie',
  besideTheEpisode: 'File beside the episode',
  withSize: '{detail} · {size}',
  inTheVideo: 'Inside the video file',
  transcribed: 'AI transcribed from the audio by Whisper',
  downloadedFrom: 'Downloaded from {provider}',
  uploaded: 'Uploaded by hand',
  translated: 'Translated from another subtitle',
  replace: 'Replace',
  replaceNamed: 'Replace the {language} subtitle',
  addInstead: 'Add a {language} subtitle file to play instead',
  deleteNamed: 'Delete the {language} subtitle file',
  reasonOff: 'Subtitles are not set up.',
  reasonNotInRadarr: 'This movie is not in Radarr.',
  reasonNotInSonarr: 'This series is not in Sonarr.',
  reasonNotInBazarr: 'Bazarr does not have it yet.',
  reasonNotOnDisk: 'That subtitle file is not there.',
  reasonWhisperOff:
    'WhisperAI is not turned on in Bazarr (Settings → Providers).',
  reasonWhisperPaused:
    'Bazarr paused WhisperAI after an error ({error}). Whisper may be busy with another job.',
  reasonWhisperPausedRetry:
    'Bazarr paused WhisperAI after an error ({error}), and tries again {retry}. Whisper may be busy with another job.',
  reasonNoWhisper: 'Bazarr offered no Whisper transcription for it.',
  reasonBazarrFailed: 'Bazarr did not answer.',
  reasonBazarrStuck: 'Bazarr hadn’t finished it after a day.',
  reasonNoSubtitleSaved: 'Bazarr finished without saving a subtitle.',
  reasonNotInPlex: 'This is not in Plex.',
  reasonPlexFailed: 'Plex did not answer.',
  reasonNotOffered: 'Plex did not offer that.',
  reasonNoPlexSignIn: 'There is no Plex sign-in to use for you.',
});

/**
 * The connected media servers' names, for wording that is not Plex's
 * alone: "Plex", or "Plex and Jellyfin" with both connected, since each
 * picks up a subtitle file beside the title.
 */
export const useMediaServerName = (): string => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  return intl.formatList(
    currentSettings.mediaServers.map((server) => SERVER_NAMES[server.kind]),
    { type: 'conjunction' }
  );
};

/**
 * Why something to do with a title's subtitles did not work, in the
 * viewer's language. The server answers with a code for that; anything
 * without one (no answer at all) reads as Bazarr not answering.
 */
export const useSubtitleReasons = (kind: SubtitlesKind) => {
  const intl = useIntl();
  const describe = (problem?: Partial<SubtitleError>): string => {
    switch (problem?.code) {
      case 'off':
        return intl.formatMessage(messages.reasonOff);
      case 'notInArr':
        return intl.formatMessage(
          kind === 'movie'
            ? messages.reasonNotInRadarr
            : messages.reasonNotInSonarr
        );
      case 'notInBazarr':
        return intl.formatMessage(messages.reasonNotInBazarr);
      case 'notOnDisk':
        return intl.formatMessage(messages.reasonNotOnDisk);
      case 'whisperOff':
        return intl.formatMessage(messages.reasonWhisperOff);
      case 'whisperPaused':
        return problem.retry
          ? intl.formatMessage(messages.reasonWhisperPausedRetry, {
              error: problem.error,
              retry: problem.retry,
            })
          : intl.formatMessage(messages.reasonWhisperPaused, {
              error: problem.error,
            });
      case 'noWhisper':
        return intl.formatMessage(messages.reasonNoWhisper);
      case 'notInPlex':
        return intl.formatMessage(messages.reasonNotInPlex);
      case 'plexFailed':
        return intl.formatMessage(messages.reasonPlexFailed);
      case 'notOffered':
        return intl.formatMessage(messages.reasonNotOffered);
      case 'noPlexSignIn':
        return intl.formatMessage(messages.reasonNoPlexSignIn);
      case 'bazarrStuck':
        return intl.formatMessage(messages.reasonBazarrStuck);
      case 'noSubtitleSaved':
        return intl.formatMessage(messages.reasonNoSubtitleSaved);
      default:
        return intl.formatMessage(messages.reasonBazarrFailed);
    }
  };
  return {
    describe,
    /** The reason in a failed request's answer. */
    reasonOf: (e: unknown) =>
      describe(
        isAxiosError(e)
          ? (e.response?.data as Partial<SubtitleError> | undefined)
          : undefined
      ),
  };
};

/** A small tag: the subtitle's format, or AI, SDH, FORCED, MISSING. */
export const Tag = ({
  tone = 'plain',
  children,
}: {
  tone?: 'plain' | 'ai' | 'missing';
  children: ReactNode;
}) => (
  <span
    className={
      tone === 'ai'
        ? 'rounded border border-indigo-500 px-1 text-[10px] font-bold leading-4 tracking-wide text-indigo-200 light:text-accent-text'
        : tone === 'missing'
          ? 'rounded border border-yellow-600 px-1 text-[10px] font-bold leading-4 tracking-wide text-yellow-200 light:text-warning-text'
          : 'rounded border border-gray-500 px-1 text-[10px] font-bold leading-4 tracking-wide text-gray-200'
    }
  >
    {children}
  </span>
);

export const Pill = ({
  tone,
  children,
}: {
  tone: 'default' | 'muted';
  children: ReactNode;
}) => (
  <span
    className={
      tone === 'default'
        ? 'rounded-full bg-accent px-2 text-[11px] font-semibold leading-4 text-indigo-50'
        : 'rounded-full bg-gray-700 px-2 text-[11px] font-semibold leading-4 text-gray-300'
    }
  >
    {children}
  </span>
);

/** "ON DISK", "MISSING": what the rows under it are. */
export const GroupLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-4 pb-0.5 pt-2.5 text-[11px] font-bold uppercase tracking-wider text-gray-400">
    {children}
  </div>
);

/** The tags after a subtitle's language: format or AI, SDH, FORCED. */
export const TrackTags = ({ track }: { track: SubtitleTrack }) => {
  const intl = useIntl();
  return (
    <>
      {track.ai ? (
        <Tag tone="ai">{intl.formatMessage(messages.ai)}</Tag>
      ) : (
        <Tag>{formatOf(track)}</Tag>
      )}
      {track.hi && <Tag>{intl.formatMessage(messages.sdh)}</Tag>}
      {track.forced && <Tag>{intl.formatMessage(messages.forced)}</Tag>}
    </>
  );
};

/**
 * Where a subtitle file came from, as Bazarr recorded it: transcribed by
 * Whisper, downloaded from a provider, uploaded, translated; or, with no
 * record, simply the file beside the video.
 */
export const originOf = (
  intl: IntlShape,
  track: SubtitleTrack,
  where: 'movie' | 'episode'
): string => {
  if (track.ai || track.origin === 'transcribed') {
    return intl.formatMessage(messages.transcribed);
  }
  switch (track.origin) {
    case 'downloaded':
      return track.provider
        ? intl.formatMessage(messages.downloadedFrom, {
            provider: providerName(track.provider),
          })
        : intl.formatMessage(
            where === 'movie'
              ? messages.besideTheMovie
              : messages.besideTheEpisode
          );
    case 'uploaded':
      return intl.formatMessage(messages.uploaded);
    case 'translated':
      return intl.formatMessage(messages.translated);
    default:
      return intl.formatMessage(
        where === 'movie' ? messages.besideTheMovie : messages.besideTheEpisode
      );
  }
};

const withSize = (intl: IntlShape, detail: string, bytes?: number) => {
  const size = formatSize(bytes);
  return size
    ? intl.formatMessage(messages.withSize, { detail, size })
    : detail;
};

export const iconButtonClass =
  'inline-flex h-10 w-10 flex-none items-center justify-center rounded-md border border-gray-600 bg-gray-700 text-gray-200 transition hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50';

export const deleteButtonClass =
  'inline-flex h-10 w-10 flex-none items-center justify-center rounded-md border border-gray-600 bg-gray-700 text-red-300 light:text-danger-text transition hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50';

/**
 * One subtitle on disk, with Replace and Delete when allowed. A track
 * inside the video has no Delete: replacing it adds a file that plays
 * instead.
 */
export const TrackRow = ({
  track,
  where,
  isDefault,
  notInProfile,
  onReplace,
  onDelete,
}: {
  track: SubtitleTrack;
  where: 'movie' | 'episode';
  isDefault?: boolean;
  notInProfile?: boolean;
  onReplace?: () => void;
  onDelete?: () => void;
}) => {
  const intl = useIntl();
  const detail =
    track.kind === 'embedded'
      ? intl.formatMessage(messages.inTheVideo)
      : withSize(intl, originOf(intl, track, where), track.size);
  return (
    <li className="flex items-center gap-2.5 border-b border-gray-700 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold text-strong">{track.name}</span>
          <TrackTags track={track} />
          {isDefault && (
            <Pill tone="default">
              {intl.formatMessage(messages.yourDefault)}
            </Pill>
          )}
          {notInProfile && (
            <Pill tone="muted">
              {intl.formatMessage(messages.notInProfile)}
            </Pill>
          )}
        </div>
        <span className="text-xs text-gray-400">{detail}</span>
      </div>
      {onReplace && (
        <button
          type="button"
          className={iconButtonClass}
          onClick={onReplace}
          aria-label={intl.formatMessage(
            track.kind === 'embedded'
              ? messages.addInstead
              : messages.replaceNamed,
            { language: track.name }
          )}
          title={intl.formatMessage(messages.replace)}
        >
          <ArrowPathIcon className="h-[18px] w-[18px]" />
        </button>
      )}
      {onDelete && track.kind === 'file' && (
        <button
          type="button"
          className={deleteButtonClass}
          onClick={onDelete}
          aria-label={intl.formatMessage(messages.deleteNamed, {
            language: track.name,
          })}
        >
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      )}
    </li>
  );
};
