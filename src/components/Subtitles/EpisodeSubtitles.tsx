import Badge from '@app/components/Common/Badge';
import Modal from '@app/components/Common/Modal';
import { SearchDialog } from '@app/components/Subtitles/dialogs';
import {
  GroupLabel,
  Tag,
  TrackRow,
  messages as partMessages,
} from '@app/components/Subtitles/parts';
import {
  subtitlesKey,
  useSeriesSubtitles,
  useSubtitleRights,
  useSubtitlesOn,
  useTranscription,
} from '@app/hooks/useSubtitles';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { formatOf, isCovered, isTranscribed } from '@app/utils/subtitles';
import { Transition } from '@headlessui/react';
import {
  MagnifyingGlassIcon,
  SpeakerWaveIcon,
} from '@heroicons/react/24/outline';
import type {
  EpisodeSubtitles,
  SubtitleTrack,
  TranscriptionStatus,
} from '@server/interfaces/api/subtitlesInterfaces';
import axios, { isAxiosError } from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

/*
 * Subtitles in a series' season list: a count on each season, a tag on
 * each episode, and the episode's own panel under it when the tag is
 * tapped. All of them read the one copy of the series' subtitles the
 * Subtitles card loads.
 */

const messages = defineMessages('components.Subtitles.EpisodeSubtitles', {
  seasonCount: 'Subtitles {covered} / {total}',
  tagLabel: 'Subtitles for episode {episode}: {state}',
  missingHere:
    '{count, plural, one {# episode is} other {# episodes are}} missing a subtitle',
  searchMissing: 'Search for the Missing',
  onDisk: 'On disk',
  searchResults: 'Search results',
  missingWanted: 'Your profile wants it · nothing for this episode yet',
  search: 'Search',
  transcribe: 'Transcribe',
  transcribing: 'Transcribing this episode…',
  queued: 'Queued to transcribe',
  episodeName: 'S{season} E{episode} · {title}',
  replaceHeading: 'Replace the {language} Subtitle',
  searchHeading: 'Search for a Subtitle',
  searchingMissing:
    'Bazarr is searching for the missing subtitles. They show here as they arrive.',
  searchingThenTranscribe:
    'Bazarr is searching for the missing subtitles. They show here as they arrive, and whatever no provider has is then transcribed from the audio.',
  transcribeStarted:
    'Transcribing. It shows here when Whisper is done, which can take a while.',
  couldNot: 'That did not work: {reason}',
  failed: 'Bazarr did not answer.',
  deleteTitle: 'Delete Subtitle File',
  deleteConfirm:
    'Delete {file}? Plex and Bazarr stop offering it, and it cannot be undone.',
  deleted: 'Subtitle file deleted.',
});

const useEpisode = (
  tvId: number,
  seasonNumber: number,
  episodeNumber: number
): EpisodeSubtitles | undefined => {
  const on = useSubtitlesOn();
  const { data } = useSeriesSubtitles(tvId, on);
  return data?.episodes.find(
    (e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber
  );
};

/** "Subtitles 11 / 20" on a season's header. */
export const SeasonSubtitleBadge = ({
  tvId,
  seasonNumber,
}: {
  tvId: number;
  seasonNumber: number;
}) => {
  const intl = useIntl();
  const on = useSubtitlesOn();
  const { data } = useSeriesSubtitles(tvId, on);
  const episodes =
    data?.episodes.filter((e) => e.seasonNumber === seasonNumber) ?? [];
  if (!episodes.length) {
    return null;
  }
  const covered = episodes.filter(isCovered).length;
  return (
    <Badge badgeType={covered === episodes.length ? 'success' : 'warning'}>
      {intl.formatMessage(messages.seasonCount, {
        covered,
        total: episodes.length,
      })}
    </Badge>
  );
};

/** One tag per language, saying what kind of subtitle it has, or MISSING. */
const tagsOf = (episode: EpisodeSubtitles) => {
  const byLanguage = new Map<string, SubtitleTrack>();
  for (const track of episode.tracks) {
    const kept = byLanguage.get(track.language);
    // A file over a track in the video; a real subtitle over a transcript.
    const better =
      !kept ||
      (kept.kind === 'embedded' && track.kind === 'file') ||
      (kept.ai && !track.ai && track.kind === 'file');
    if (better) {
      byLanguage.set(track.language, track);
    }
  }
  return {
    present: [...byLanguage.values()],
    missing: episode.missing.filter((m) => !byLanguage.has(m.language)),
  };
};

export const EpisodeSubtitleTag = ({
  tvId,
  seasonNumber,
  episodeNumber,
  open,
  onToggle,
}: {
  tvId: number;
  seasonNumber: number;
  episodeNumber: number;
  open: boolean;
  onToggle: () => void;
}) => {
  const intl = useIntl();
  const episode = useEpisode(tvId, seasonNumber, episodeNumber);
  if (!episode || (!episode.tracks.length && !episode.missing.length)) {
    return null;
  }
  const { present, missing } = tagsOf(episode);
  const state = [
    ...present.map(
      (t) =>
        `${t.name} ${t.ai ? intl.formatMessage(partMessages.ai) : formatOf(t)}`
    ),
    ...missing.map(
      (m) => `${m.name} ${intl.formatMessage(partMessages.missingTag)}`
    ),
  ].join(', ');
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={intl.formatMessage(messages.tagLabel, {
        episode: episodeNumber,
        state,
      })}
      className={
        open
          ? 'inline-flex min-h-[28px] items-center gap-1.5 self-start rounded-md border border-indigo-500 bg-gray-800 px-2 text-xs font-semibold text-white ring-2 ring-indigo-500 xl:self-auto'
          : 'inline-flex min-h-[28px] items-center gap-1.5 self-start rounded-md border border-gray-600 bg-gray-800 px-2 text-xs font-semibold text-white hover:border-gray-400 xl:self-auto'
      }
    >
      {present.map((track) => (
        <span key={track.language} className="inline-flex items-center gap-1">
          {track.language.toUpperCase()}
          {track.ai ? (
            <Tag tone="ai">{intl.formatMessage(partMessages.ai)}</Tag>
          ) : (
            <Tag>{formatOf(track)}</Tag>
          )}
        </span>
      ))}
      {missing.map((m) => (
        <span key={m.language} className="inline-flex items-center gap-1">
          {m.language.toUpperCase()}
          <Tag tone="missing">
            {intl.formatMessage(partMessages.missingTag)}
          </Tag>
        </span>
      ))}
    </button>
  );
};

/** At the top of an open season: how many episodes lack a subtitle. */
export const SeasonMissingBar = ({
  tvId,
  seasonNumber,
}: {
  tvId: number;
  seasonNumber: number;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const on = useSubtitlesOn();
  const rights = useSubtitleRights();
  const { data } = useSeriesSubtitles(tvId, on);
  const transcription = useTranscription('tv', tvId, on);
  const searching = !!transcription.data?.searching;
  const count =
    data?.episodes.filter(
      (e) => e.seasonNumber === seasonNumber && e.missing.length > 0
    ).length ?? 0;
  if (!count || !rights.manage) {
    return null;
  }
  const search = async () => {
    try {
      const { data: started } = await axios.post<
        TranscriptionStatus & { transcribeAfter?: boolean }
      >(`${subtitlesKey('tv', tvId)}/search-missing`);
      addToast(
        intl.formatMessage(
          started.transcribeAfter
            ? messages.searchingThenTranscribe
            : messages.searchingMissing
        ),
        { appearance: 'success', autoDismiss: true }
      );
      // The Subtitles card follows the search, and shows what it found.
      void transcription.mutate(started, { revalidate: false });
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };
  return (
    <div className="flex flex-col items-start justify-between gap-2 py-3 sm:flex-row sm:items-center">
      <p className="text-sm text-gray-400">
        {intl.formatMessage(messages.missingHere, { count })}
      </p>
      <button
        type="button"
        onClick={search}
        disabled={searching}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md bg-indigo-600 px-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        <MagnifyingGlassIcon className="h-4 w-4" />
        {intl.formatMessage(messages.searchMissing)}
      </button>
    </div>
  );
};

/** An episode's subtitles, under the episode, with what can be done. */
export const EpisodeSubtitlePanel = ({
  tvId,
  seasonNumber,
  episodeNumber,
  title,
}: {
  tvId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const on = useSubtitlesOn();
  const rights = useSubtitleRights();
  const { data, mutate } = useSeriesSubtitles(tvId, on);
  const transcription = useTranscription('tv', tvId, on);
  const [search, setSearch] = useState<{
    heading: string;
    language?: string;
  } | null>(null);
  const [toDelete, setToDelete] = useState<SubtitleTrack | null>(null);
  const episode = data?.episodes.find(
    (e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber
  );
  if (!episode) {
    return null;
  }
  const wanted = data?.wanted ?? [];
  const base = `${subtitlesKey('tv', tvId)}/season/${seasonNumber}/episode/${episodeNumber}`;
  const reasonOf = (e: unknown) =>
    (isAxiosError(e) && (e.response?.data as { message?: string })?.message) ||
    intl.formatMessage(messages.failed);
  const toast = (message: string, ok = true) =>
    addToast(message, {
      appearance: ok ? 'success' : 'error',
      autoDismiss: true,
    });

  const status = transcription.data;
  const thisOneRunning =
    status?.running &&
    status.current?.seasonNumber === seasonNumber &&
    status.current?.episodeNumber === episodeNumber;

  const transcribe = async () => {
    try {
      await axios.post(`${subtitlesKey('tv', tvId)}/transcription`, {
        scope: 'episode',
        seasonNumber,
        episodeNumber,
      });
      toast(intl.formatMessage(messages.transcribeStarted));
      void transcription.mutate();
    } catch (e) {
      toast(
        intl.formatMessage(messages.couldNot, { reason: reasonOf(e) }),
        false
      );
    }
  };

  const remove = async () => {
    if (!toDelete) {
      return;
    }
    try {
      await axios.delete(`${base}/subtitle/${toDelete.id}`);
      toast(intl.formatMessage(messages.deleted));
      void mutate();
    } catch (e) {
      toast(
        intl.formatMessage(messages.couldNot, { reason: reasonOf(e) }),
        false
      );
    } finally {
      setToDelete(null);
    }
  };

  const episodeName = intl.formatMessage(messages.episodeName, {
    season: seasonNumber,
    episode: episodeNumber,
    title,
  });

  return (
    <div className="mt-4 w-full overflow-hidden rounded-lg border border-gray-700 bg-gray-900 text-sm text-gray-300">
      <GroupLabel>{intl.formatMessage(messages.onDisk)}</GroupLabel>
      <ul>
        {episode.tracks.map((track) => (
          <TrackRow
            key={track.id}
            track={track}
            where="episode"
            notInProfile={wanted.length > 0 && !wanted.includes(track.language)}
            onReplace={
              rights.manage
                ? () =>
                    setSearch({
                      heading: intl.formatMessage(messages.replaceHeading, {
                        language: track.name,
                      }),
                      language: track.language,
                    })
                : undefined
            }
            onDelete={rights.remove ? () => setToDelete(track) : undefined}
          />
        ))}
        {episode.missing.map((missing) => (
          <li
            key={`${missing.language}-${missing.hi}-${missing.forced}`}
            className="flex items-center gap-2.5 border-b border-gray-700 px-4 py-2.5"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold text-white">{missing.name}</span>
                <Tag tone="missing">
                  {intl.formatMessage(partMessages.missingTag)}
                </Tag>
              </div>
              <span className="text-xs text-gray-400">
                {intl.formatMessage(messages.missingWanted)}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {rights.manage && (
        <div className="flex flex-col gap-2 px-4 py-3">
          <div
            className={
              isTranscribed(episode)
                ? 'grid grid-cols-1 gap-2'
                : 'grid grid-cols-2 gap-2'
            }
          >
            <button
              type="button"
              onClick={() =>
                setSearch({
                  heading: intl.formatMessage(messages.searchHeading),
                  language: episode.missing[0]?.language ?? wanted[0],
                })
              }
              className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              <MagnifyingGlassIcon className="h-4 w-4" />
              {intl.formatMessage(messages.search)}
            </button>
            {!isTranscribed(episode) && (
              <button
                type="button"
                onClick={transcribe}
                disabled={!!thisOneRunning}
                className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-md border border-indigo-500 bg-indigo-500/10 px-3 text-sm font-semibold text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-50"
              >
                <SpeakerWaveIcon className="h-4 w-4" />
                {intl.formatMessage(messages.transcribe)}
              </button>
            )}
          </div>
          {thisOneRunning && (
            <span className="text-xs text-indigo-200">
              {intl.formatMessage(messages.transcribing)}
            </span>
          )}
        </div>
      )}
      {rights.manage && (
        <SearchDialog
          open={!!search}
          kind="tv"
          tmdbId={tvId}
          seasonNumber={seasonNumber}
          episodeNumber={episodeNumber}
          subTitle={episodeName}
          heading={search?.heading ?? ''}
          language={search?.language}
          onClose={() => setSearch(null)}
          onDone={() => {
            setSearch(null);
            void mutate();
            void transcription.mutate();
          }}
        />
      )}
      <Transition
        as="div"
        show={!!toDelete}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          title={intl.formatMessage(messages.deleteTitle)}
          onCancel={() => setToDelete(null)}
          onOk={remove}
          okText={intl.formatMessage(globalMessages.delete)}
          okButtonType="danger"
        >
          {intl.formatMessage(messages.deleteConfirm, {
            file: toDelete?.fileName ?? '',
          })}
        </Modal>
      </Transition>
    </div>
  );
};
