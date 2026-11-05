import useFeature from '@app/hooks/useFeature';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import type {
  MovieSubtitles,
  PlexSubtitleDefault,
  SeriesSubtitles,
  TranscriptionStatus,
} from '@server/interfaces/api/subtitlesInterfaces';
import useSWR from 'swr';

export type SubtitlesKind = 'movie' | 'tv';

/** Whether Bazarr is set up and Subtitles is on for this user. */
export const useSubtitlesOn = (): boolean => {
  const { currentSettings } = useSettings();
  const on = useFeature('subtitles');
  return currentSettings.subtitlesReady && on;
};

/** The user's subtitle permissions beyond viewing. */
export const useSubtitleRights = () => {
  const { hasPermission } = useUser();
  return {
    manage: hasPermission(Permission.MANAGE_REQUESTS),
    remove: hasPermission(Permission.ADMIN),
  };
};

const READ_OPTIONS = {
  revalidateOnFocus: false,
  shouldRetryOnError: false,
};

export const subtitlesKey = (kind: SubtitlesKind, tmdbId: number) =>
  `/api/v1/subtitles/${kind}/${tmdbId}`;

export const useMovieSubtitles = (tmdbId: number, on: boolean) =>
  useSWR<MovieSubtitles>(
    on ? subtitlesKey('movie', tmdbId) : null,
    READ_OPTIONS
  );

/** Shared by the card, the season headers and every episode's tag. */
export const useSeriesSubtitles = (tmdbId: number, on: boolean) =>
  useSWR<SeriesSubtitles>(on ? subtitlesKey('tv', tmdbId) : null, READ_OPTIONS);

/** Polls fast only while Bazarr is searching or a transcription is queued or running. */
export const useTranscription = (
  kind: SubtitlesKind,
  tmdbId: number,
  on: boolean
) =>
  useSWR<TranscriptionStatus>(
    on ? `${subtitlesKey(kind, tmdbId)}/transcription` : null,
    {
      ...READ_OPTIONS,
      refreshInterval: (latest) =>
        // 5s while active (matching Seerr AI's Bazarr queue polling); 10s while queued.
        latest && (latest.searching || latest.running)
          ? 5_000
          : latest && latest.queued > 0
            ? 10_000
            : 0,
    }
  );

export const usePlexDefault = (
  kind: SubtitlesKind,
  tmdbId: number,
  on: boolean
) =>
  useSWR<PlexSubtitleDefault>(
    on ? `${subtitlesKey(kind, tmdbId)}/plex-default` : null,
    READ_OPTIONS
  );
