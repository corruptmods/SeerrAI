import Modal from '@app/components/Common/Modal';
import {
  SearchDialog,
  TranscribeDialog,
} from '@app/components/Subtitles/dialogs';
import {
  GroupLabel,
  Pill,
  Tag,
  TrackRow,
  iconButtonClass,
  messages as partMessages,
  useMediaServerName,
  useSubtitleReasons,
} from '@app/components/Subtitles/parts';
import type { SubtitlesKind } from '@app/hooks/useSubtitles';
import {
  subtitlesKey,
  useMovieSubtitles,
  usePlexDefault,
  useSeriesSubtitles,
  useSubtitleRights,
  useSubtitlesOn,
  useTranscription,
} from '@app/hooks/useSubtitles';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { Where } from '@app/utils/subtitles';
import {
  groupMissing,
  groupTracks,
  isTranscribed,
  whereAre,
} from '@app/utils/subtitles';
import { Transition } from '@headlessui/react';
import {
  ChatBubbleBottomCenterTextIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
  SpeakerWaveIcon,
} from '@heroicons/react/24/outline';
import type {
  EpisodeSubtitles,
  MovieSubtitles,
  SeriesSubtitles,
  SubtitleTrack,
  TranscriptionStatus,
} from '@server/interfaces/api/subtitlesInterfaces';
import axios, { isAxiosError } from 'axios';
import { useEffect, useId, useRef, useState } from 'react';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Subtitles.SubtitlesCard', {
  subtitles: 'Subtitles',
  languageCount: '{name} ×{count}',
  nothingMissing: 'nothing missing',
  missingCount: '{count} missing',
  coverage: '{name} {covered} / {total}',
  noneOnDisk: 'No subtitles yet',
  failed: 'Bazarr did not answer.',
  yourDefaultLabel: 'Your default when you play it on Plex',
  noSubtitles: 'None',
  onDisk: 'On disk',
  missing: 'Missing',
  noneMissing: 'None · {languages} covered',
  noneMissingPlain: 'None',
  profileWants: 'Your profile wants it',
  episodesWhere:
    '{count, plural, one {# episode} other {# episodes}} · {where}',
  episodesWhereAi:
    '{count, plural, one {# episode} other {# episodes}} AI transcribed by Whisper · {where}',
  seasonsRange: 'Seasons {seasons}',
  seasonOne: 'Season {season}',
  someEpisodes: 'S{season} E{episodes}',
  showEpisodes: 'Show these episodes',
  search: 'Search',
  searchMissing: 'Search for the missing',
  transcribe: 'Transcribe',
  aboutTranscribe: 'Transcribe: AI subtitles from the audio, not done yet',
  aboutTranscribeSeries:
    'Transcribe: AI subtitles from the audio, {left} of {total} to do',
  transcribingNow: 'Transcribing now…',
  transcribingEpisode: 'Transcribing S{season} E{episode}…',
  transcribingQueued: '{count} more queued',
  searchingNow: 'Searching for the missing subtitles…',
  noneFoundMovie: 'no provider had one',
  noneFoundEpisodes:
    '{count, plural, one {# episode} other {# episodes}} no provider had',
  queuedToTranscribe: 'Queued to transcribe',
  transcribeFailed:
    '{count, plural, one {The transcription} other {# transcriptions}} did not finish: {reason}',
  transcribedDone:
    'Transcribed {done, plural, one {# episode} other {# episodes}}',
  profile: 'Profile: {profile}',
  searchHeading: 'Search for a Subtitle',
  replaceHeading: 'Replace the {language} Subtitle',
  searching:
    'Bazarr is searching for the missing subtitles. They show here as they arrive.',
  searchingThenTranscribe:
    'Bazarr is searching for the missing subtitles; any it can’t find are then transcribed.',
  defaultSet: 'Plex will start this with that subtitle for you.',
  defaultSetSeries:
    'Setting it on {count, plural, one {# episode} other {# episodes}} in Plex.',
  couldNot: 'That did not work: {reason}',
  deleteTitle: 'Delete Subtitle File',
  deleteConfirm:
    'Delete {file}? {mediaServerName} and Bazarr stop offering it, and it cannot be undone.',
  deleted: 'Subtitle file deleted.',
  transcribeStarted:
    'Transcribing. It shows here when Whisper is done, which can take a while.',
});

const OPEN_KEY = 'subtitles-card-open';

/** The card stays open or closed as its viewer last left it. */
const useRememberedOpen = (): [boolean, (open: boolean) => void] => {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(OPEN_KEY) === 'false') {
        setOpen(false);
      }
    } catch {
      // Storage refused: open, as it starts.
    }
  }, []);
  return [
    open,
    (next) => {
      setOpen(next);
      try {
        window.localStorage.setItem(OPEN_KEY, String(next));
      } catch {
        // Not remembered this time.
      }
    },
  ];
};

export const describeWhere = (intl: IntlShape, where: Where): string => {
  if (where.kind === 'episodes') {
    return intl.formatMessage(messages.someEpisodes, {
      season: where.season,
      episodes: where.episodes,
    });
  }
  if (where.seasons.length === 1) {
    return intl.formatMessage(messages.seasonOne, {
      season: where.seasons[0],
    });
  }
  const first = where.seasons[0];
  const last = where.seasons[where.seasons.length - 1];
  return intl.formatMessage(messages.seasonsRange, {
    seasons:
      last - first === where.seasons.length - 1
        ? `${first}–${last}`
        : where.seasons.join(', '),
  });
};

/** "English ×2, Spanish". */
const languagesOf = (intl: IntlShape, tracks: SubtitleTrack[]) => {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    counts.set(track.name, (counts.get(track.name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) =>
      count > 1
        ? intl.formatMessage(messages.languageCount, { name, count })
        : name
    )
    .join(', ');
};

interface SubtitlesCardProps {
  kind: SubtitlesKind;
  tmdbId: number;
  /** The title as dialogs name it: "10 Juniper Lane (2016)". */
  title: string;
}

const SubtitlesCard = ({ kind, tmdbId, title }: SubtitlesCardProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const on = useSubtitlesOn();
  const rights = useSubtitleRights();
  const mediaServerName = useMediaServerName();
  const { reasonOf, describe } = useSubtitleReasons(kind);
  const bodyId = useId();
  const [open, setOpen] = useRememberedOpen();

  const movie = useMovieSubtitles(tmdbId, on && kind === 'movie');
  const series = useSeriesSubtitles(tmdbId, on && kind === 'tv');
  const current = kind === 'movie' ? movie : series;
  const loaded = !!current.data;
  const transcription = useTranscription(kind, tmdbId, on && loaded);
  const plex = usePlexDefault(kind, tmdbId, on && loaded);

  const [search, setSearch] = useState<{
    heading: string;
    language?: string;
  } | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [toDelete, setToDelete] = useState<SubtitleTrack | null>(null);
  const [busy, setBusy] = useState(false);

  // A finished transcription is a new subtitle on disk.
  const done = transcription.data?.done ?? 0;
  const lastDone = useRef(done);
  useEffect(() => {
    if (done > lastDone.current) {
      void current.mutate();
    }
    lastDone.current = done;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  // So is whatever a finished search found.
  const searching = !!transcription.data?.searching;
  const wasSearching = useRef(searching);
  useEffect(() => {
    if (wasSearching.current && !searching) {
      void current.mutate();
    }
    wasSearching.current = searching;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching]);

  const notFound =
    isAxiosError(current.error) && current.error.response?.status === 404;
  if (!on || notFound || (!current.data && !current.error)) {
    return null;
  }

  const key = subtitlesKey(kind, tmdbId);
  const toast = (message: string, ok = true) =>
    addToast(message, {
      appearance: ok ? 'success' : 'error',
      autoDismiss: true,
    });

  const searchMissing = async () => {
    try {
      const { data } = await axios.post<
        TranscriptionStatus & { transcribeAfter?: boolean }
      >(`${key}/search-missing`);
      toast(
        intl.formatMessage(
          data.transcribeAfter
            ? messages.searchingThenTranscribe
            : messages.searching
        )
      );
      // Followed until Bazarr is done; what it found then shows.
      void transcription.mutate(data, { revalidate: false });
    } catch (e) {
      toast(
        intl.formatMessage(messages.couldNot, { reason: reasonOf(e) }),
        false
      );
    }
  };

  const transcribeMovie = async () => {
    try {
      await axios.post(`${key}/transcription`);
      toast(intl.formatMessage(messages.transcribeStarted));
      void transcription.mutate();
    } catch (e) {
      toast(
        intl.formatMessage(messages.couldNot, { reason: reasonOf(e) }),
        false
      );
    }
  };

  const deleteTrack = async () => {
    if (!toDelete) {
      return;
    }
    setBusy(true);
    try {
      await axios.delete(`${key}/subtitle/${toDelete.id}`);
      toast(intl.formatMessage(messages.deleted));
      void current.mutate();
    } catch (e) {
      toast(
        intl.formatMessage(messages.couldNot, { reason: reasonOf(e) }),
        false
      );
    } finally {
      setBusy(false);
      setToDelete(null);
    }
  };

  const setPlexDefault = async (value: string) => {
    try {
      if (kind === 'movie') {
        await axios.put(`${key}/plex-default`, { streamId: Number(value) });
        toast(intl.formatMessage(messages.defaultSet));
      } else {
        const { data } = await axios.put<{ episodes: number }>(
          `${key}/plex-default`,
          { language: value }
        );
        toast(
          intl.formatMessage(messages.defaultSetSeries, {
            count: data.episodes,
          })
        );
      }
      void plex.mutate();
    } catch (e) {
      toast(
        intl.formatMessage(messages.couldNot, { reason: reasonOf(e) }),
        false
      );
    }
  };

  // ---- What the header and rows say ----------------------------------------

  const movieData =
    kind === 'movie' ? (movie.data as MovieSubtitles) : undefined;
  const seriesData =
    kind === 'tv' ? (series.data as SeriesSubtitles | undefined) : undefined;
  const wanted = current.data?.wanted ?? [];
  const episodes: EpisodeSubtitles[] = seriesData?.episodes ?? [];
  const missingCount = movieData
    ? movieData.missing.length
    : episodes.filter((e) => e.missing.length > 0).length;

  const plexSelected = plex.data?.available ? plex.data.selected : undefined;
  const selectedOption = plex.data?.options.find((o) => o.id === plexSelected);
  /** The track Plex starts this with for the viewer, as best it can be told. */
  const isDefault = (track: SubtitleTrack) =>
    !!selectedOption &&
    !!track.language3 &&
    track.language3 === selectedOption.language &&
    (selectedOption.external
      ? track.kind === 'file'
      : track.kind === 'embedded');
  const defaultTrack = movieData?.tracks.find(isDefault);
  const groups = seriesData ? groupTracks(episodes, wanted) : [];
  /** A series is set by language: its first group in that language. */
  const defaultGroupKey =
    typeof plexSelected === 'string' && plexSelected
      ? groups.find(
          (group) =>
            !group.ai &&
            episodes
              .flatMap((e) => e.tracks)
              .find((t) => t.language === group.language)?.language3 ===
              plexSelected
        )?.key
      : undefined;

  let summary: string;
  if (current.error) {
    summary = intl.formatMessage(messages.failed);
  } else if (movieData) {
    summary = [
      movieData.tracks.length
        ? languagesOf(intl, movieData.tracks)
        : intl.formatMessage(messages.noneOnDisk),
      missingCount
        ? intl.formatMessage(messages.missingCount, { count: missingCount })
        : intl.formatMessage(messages.nothingMissing),
    ].join(' · ');
  } else {
    const names = new Map(
      episodes.flatMap((e) => e.tracks.map((t) => [t.language, t.name]))
    );
    const coverage = (wanted.length ? wanted : [...names.keys()]).map(
      (language) =>
        intl.formatMessage(messages.coverage, {
          name:
            names.get(language) ??
            episodes
              .flatMap((e) => e.missing)
              .find((m) => m.language === language)?.name ??
            language.toUpperCase(),
          covered: episodes.filter((e) =>
            e.tracks.some((t) => t.language === language)
          ).length,
          total: episodes.length,
        })
    );
    summary = [
      coverage.join(', ') || intl.formatMessage(messages.noneOnDisk),
      missingCount
        ? intl.formatMessage(messages.missingCount, { count: missingCount })
        : intl.formatMessage(messages.nothingMissing),
    ].join(' · ');
  }

  const toTranscribe = episodes.filter((e) => !isTranscribed(e)).length;
  const canTranscribe = movieData
    ? !movieData.tracks.some((t) => t.ai)
    : toTranscribe > 0;
  const status = transcription.data;
  const statusLine =
    [
      status?.searching ? intl.formatMessage(messages.searchingNow) : '',
      status?.running
        ? status.current
          ? intl.formatMessage(messages.transcribingEpisode, {
              season: status.current.seasonNumber,
              episode: status.current.episodeNumber,
            })
          : intl.formatMessage(messages.transcribingNow)
        : '',
      status?.running && status.queued
        ? intl.formatMessage(messages.transcribingQueued, {
            count: status.queued,
          })
        : '',
      !status?.running && status?.queued
        ? intl.formatMessage(messages.queuedToTranscribe)
        : '',
      status?.auto && (status.running || status.queued)
        ? kind === 'movie'
          ? intl.formatMessage(messages.noneFoundMovie)
          : intl.formatMessage(messages.noneFoundEpisodes, {
              count: status.auto,
            })
        : '',
    ]
      .filter(Boolean)
      .join(' · ') || undefined;

  const searchButton = (
    <button
      type="button"
      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-on-accent transition hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:opacity-50"
      disabled={(kind === 'tv' && missingCount === 0) || searching}
      onClick={() =>
        kind === 'movie'
          ? setSearch({ heading: intl.formatMessage(messages.searchHeading) })
          : searchMissing()
      }
      title={
        kind === 'tv' ? intl.formatMessage(messages.searchMissing) : undefined
      }
    >
      <MagnifyingGlassIcon className="h-[18px] w-[18px]" />
      {intl.formatMessage(messages.search)}
    </button>
  );

  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-subtle bg-page text-sm text-default shadow">
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="flex min-h-[52px] w-full items-center gap-2.5 px-4 py-2.5 text-left text-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        >
          <ChatBubbleBottomCenterTextIcon className="h-[18px] w-[18px] flex-none text-indigo-300 light:text-accent-text" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-bold">
              {intl.formatMessage(messages.subtitles)}
            </span>
            <span className="truncate text-xs font-normal text-muted">
              {summary}
            </span>
          </span>
          <ChevronDownIcon
            className={
              open
                ? 'h-[18px] w-[18px] flex-none text-muted transition-transform'
                : 'h-[18px] w-[18px] flex-none -rotate-90 text-muted transition-transform'
            }
          />
        </button>
      </h2>

      {open && current.data && (
        <div id={bodyId} className="border-t border-subtle">
          {plex.data?.available &&
            (kind === 'movie'
              ? plex.data.options.length > 0
              : (plex.data.languages ?? []).length > 0) && (
              <div className="flex flex-col gap-1.5 border-b border-subtle bg-surface px-4 py-3">
                <label
                  htmlFor={`${bodyId}-default`}
                  className="text-xs text-muted"
                >
                  {intl.formatMessage(messages.yourDefaultLabel)}
                </label>
                <select
                  id={`${bodyId}-default`}
                  value={String(plex.data.selected)}
                  onChange={(e) => setPlexDefault(e.target.value)}
                  className="rounded-md border border-field-border bg-field py-2 text-sm text-strong"
                >
                  {kind === 'movie' ? (
                    <>
                      {plex.data.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.title}
                        </option>
                      ))}
                      <option value="0">
                        {intl.formatMessage(messages.noSubtitles)}
                      </option>
                    </>
                  ) : (
                    <>
                      {(plex.data.languages ?? []).map((language) => (
                        <option key={language.code} value={language.code}>
                          {language.title}
                        </option>
                      ))}
                      <option value="">
                        {intl.formatMessage(messages.noSubtitles)}
                      </option>
                    </>
                  )}
                </select>
              </div>
            )}

          <GroupLabel>{intl.formatMessage(messages.onDisk)}</GroupLabel>
          <ul>
            {movieData &&
              movieData.tracks.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  where="movie"
                  isDefault={track === defaultTrack}
                  notInProfile={
                    wanted.length > 0 && !wanted.includes(track.language)
                  }
                  onReplace={
                    rights.manage
                      ? () =>
                          setSearch({
                            heading: intl.formatMessage(
                              messages.replaceHeading,
                              { language: track.name }
                            ),
                            language: track.language,
                          })
                      : undefined
                  }
                  onDelete={
                    rights.remove ? () => setToDelete(track) : undefined
                  }
                />
              ))}
            {seriesData &&
              groups.map((group) => (
                <li
                  key={group.key}
                  className="flex items-center gap-2.5 border-b border-subtle px-4 py-2.5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-strong">
                        {group.name}
                      </span>
                      {group.ai ? (
                        <Tag tone="ai">
                          {intl.formatMessage(partMessages.ai)}
                        </Tag>
                      ) : (
                        <Tag>{group.format}</Tag>
                      )}
                      {group.hi && (
                        <Tag>{intl.formatMessage(partMessages.sdh)}</Tag>
                      )}
                      {group.forced && (
                        <Tag>{intl.formatMessage(partMessages.forced)}</Tag>
                      )}
                      {group.key === defaultGroupKey && (
                        <Pill tone="default">
                          {intl.formatMessage(partMessages.yourDefault)}
                        </Pill>
                      )}
                    </div>
                    <span className="text-xs text-muted">
                      {intl.formatMessage(
                        group.ai
                          ? messages.episodesWhereAi
                          : messages.episodesWhere,
                        {
                          count: group.episodes.length,
                          where: describeWhere(
                            intl,
                            whereAre(group.episodes, episodes)
                          ),
                        }
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={iconButtonClass}
                    aria-label={intl.formatMessage(messages.showEpisodes)}
                    onClick={() =>
                      document
                        .getElementById('seasons')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }
                  >
                    <ChevronRightIcon className="h-[18px] w-[18px]" />
                  </button>
                </li>
              ))}
            {(movieData?.tracks.length === 0 ||
              (seriesData && episodes.every((e) => e.tracks.length === 0))) && (
              <li className="border-b border-subtle px-4 py-2.5 text-muted">
                {intl.formatMessage(messages.noneOnDisk)}
              </li>
            )}
          </ul>

          <GroupLabel>{intl.formatMessage(messages.missing)}</GroupLabel>
          <ul>
            {missingCount === 0 && (
              <li className="flex items-center gap-2 border-b border-subtle px-4 py-2.5 text-green-200 light:text-success-text">
                <CheckIcon className="h-4 w-4 flex-none" />
                {wanted.length
                  ? intl.formatMessage(messages.noneMissing, {
                      languages: [
                        ...new Set(
                          (
                            movieData?.tracks ??
                            episodes.flatMap((e) => e.tracks)
                          )
                            .filter((t) => wanted.includes(t.language))
                            .map((t) => t.name)
                        ),
                      ].join(', '),
                    })
                  : intl.formatMessage(messages.noneMissingPlain)}
              </li>
            )}
            {movieData?.missing.map((missing) => (
              <li
                key={`${missing.language}-${missing.hi}-${missing.forced}`}
                className="flex items-center gap-2.5 border-b border-subtle px-4 py-2.5"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-strong">
                      {missing.name}
                    </span>
                    <Tag tone="missing">
                      {intl.formatMessage(partMessages.missingTag)}
                    </Tag>
                  </div>
                  <span className="text-xs text-muted">
                    {intl.formatMessage(messages.profileWants)}
                  </span>
                </div>
                {rights.manage && (
                  <button
                    type="button"
                    onClick={searchMissing}
                    disabled={searching}
                    className="min-h-[40px] flex-none rounded-md bg-accent px-3 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50"
                  >
                    {intl.formatMessage(messages.search)}
                  </button>
                )}
              </li>
            ))}
            {seriesData &&
              groupMissing(episodes).map((group) => (
                <li
                  key={group.language}
                  className="flex items-center gap-2.5 border-b border-subtle px-4 py-2.5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-strong">
                        {group.name}
                      </span>
                      <Tag tone="missing">
                        {intl.formatMessage(partMessages.missingTag)}
                      </Tag>
                    </div>
                    <span className="text-xs text-muted">
                      {intl.formatMessage(messages.episodesWhere, {
                        count: group.episodes.length,
                        where: describeWhere(
                          intl,
                          whereAre(group.episodes, episodes)
                        ),
                      })}
                    </span>
                  </div>
                  {rights.manage && (
                    <button
                      type="button"
                      onClick={searchMissing}
                      disabled={searching}
                      className="min-h-[40px] flex-none rounded-md bg-accent px-3 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50"
                    >
                      {intl.formatMessage(messages.search)}
                    </button>
                  )}
                </li>
              ))}
          </ul>

          <div className="flex flex-col gap-2 px-4 py-3">
            {rights.manage && (
              <div
                className={
                  canTranscribe
                    ? 'grid grid-cols-2 gap-2'
                    : 'grid grid-cols-1 gap-2'
                }
              >
                {searchButton}
                {canTranscribe && (
                  <button
                    type="button"
                    disabled={
                      !!(status?.running || status?.queued) || searching
                    }
                    onClick={() =>
                      kind === 'movie'
                        ? transcribeMovie()
                        : setTranscribing(true)
                    }
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-indigo-500 bg-indigo-500/10 px-3 text-sm font-semibold text-indigo-200 transition hover:bg-indigo-500/20 focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:opacity-50 light:text-accent-text"
                  >
                    <SpeakerWaveIcon className="h-[18px] w-[18px]" />
                    {intl.formatMessage(messages.transcribe)}
                  </button>
                )}
              </div>
            )}
            {!statusLine &&
              rights.manage &&
              !!status?.failed &&
              status.error && (
                <span className="text-xs text-yellow-300 light:text-warning-text">
                  {intl.formatMessage(messages.transcribeFailed, {
                    count: status.failed,
                    reason: describe(status.error),
                  })}
                </span>
              )}
            {statusLine ? (
              <span className="text-xs text-indigo-200 light:text-accent-text">
                {statusLine}
              </span>
            ) : (
              rights.manage &&
              canTranscribe && (
                <span className="text-xs text-muted">
                  {movieData
                    ? intl.formatMessage(messages.aboutTranscribe)
                    : intl.formatMessage(messages.aboutTranscribeSeries, {
                        left: toTranscribe,
                        total: episodes.length,
                      })}
                </span>
              )
            )}
            {current.data.profile && (
              <span className="text-xs text-muted">
                {intl.formatMessage(messages.profile, {
                  profile: current.data.profile,
                })}
              </span>
            )}
          </div>
        </div>
      )}

      {rights.manage && kind === 'movie' && (
        <SearchDialog
          open={!!search}
          kind="movie"
          tmdbId={tmdbId}
          subTitle={title}
          heading={search?.heading ?? ''}
          language={search?.language}
          onClose={() => setSearch(null)}
          onDone={() => {
            setSearch(null);
            void current.mutate();
            void transcription.mutate();
          }}
        />
      )}
      {rights.manage && kind === 'tv' && (
        <TranscribeDialog
          open={transcribing}
          tmdbId={tmdbId}
          subTitle={title}
          episodes={episodes}
          onClose={() => setTranscribing(false)}
          onStarted={() => {
            setTranscribing(false);
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
          onOk={deleteTrack}
          okText={intl.formatMessage(globalMessages.delete)}
          okButtonType="danger"
          okDisabled={busy}
        >
          {intl.formatMessage(messages.deleteConfirm, {
            file: toDelete?.fileName ?? '',
            mediaServerName,
          })}
        </Modal>
      </Transition>
    </section>
  );
};

export default SubtitlesCard;
