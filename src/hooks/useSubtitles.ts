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

/** Bazarr is set up and the Subtitles switch is on for this person. */
export const useSubtitlesOn = (): boolean => {
  const { currentSettings } = useSettings();
  const on = useFeature('subtitles');
  return currentSettings.subtitlesReady && on;
};

/** What this person may do with subtitles, beyond seeing them. */
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

/**
 * Checked often only while Bazarr is searching, or a transcription is
 * queued or under way.
 */
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
        latest && (latest.searching || latest.running || latest.queued > 0)
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
