import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import {
  Tag,
  messages as partMessages,
  useMediaServerName,
  useSubtitleReasons,
} from '@app/components/Subtitles/parts';
import type { SubtitlesKind } from '@app/hooks/useSubtitles';
import { subtitlesKey } from '@app/hooks/useSubtitles';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { providerName } from '@app/utils/subtitles';
import type {
  NoneFoundOutcome,
  SubtitleSearchResponse,
  SubtitleSearchResult,
} from '@server/interfaces/api/subtitlesInterfaces';
import axios from 'axios';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.Subtitles.SubtitleSearchModal', {
  asking: 'Asking Bazarr’s providers. This can take up to a minute.',
  none: 'No provider has a subtitle for this.',
  noneTranscribing:
    'No provider had the missing subtitle, so Whisper is transcribing it from the audio. It shows on the page when it is done.',
  noneQueued:
    'No provider had the missing subtitle. It is already queued to be transcribed from the audio.',
  noneNotMissing:
    'No provider has another subtitle for this. Nothing was transcribed, since that would replace the one you have. Tap Transcribe to do it anyway.',
  noneNotMissingPlain: 'No provider has another subtitle for this.',
  noneUnavailable:
    'No provider has the missing subtitle, and Bazarr has no Whisper to transcribe one.',
  failed: 'Bazarr did not answer. Try again in a moment.',
  language: 'Language',
  sdhOnly: 'SDH only',
  summary: '{count, plural, one {# result} other {# results}} · {providers}',
  providerCount: '{provider} {count}',
  match: 'match',
  use: 'Use this one',
  transcribe: 'Transcribe',
  aiTranscription: 'AI transcription',
  transcribeDetail: 'Transcribe the audio into subtitles',
  showAll: 'Show all {count}',
  downloaded:
    'Subtitle downloaded. {mediaServerName} shows it after its next library scan.',
  transcribing:
    'Transcribing. It shows here when Whisper is done, which can take a while.',
  couldNot: 'Could not get that subtitle: {reason}',
  title: 'Title',
  series: 'Series',
  year: 'Year',
  season: 'Season',
  episode: 'Episode',
  source: 'Source',
  resolution: 'Resolution',
  release_group: 'Release group',
  video_codec: 'Video codec',
  audio_codec: 'Audio codec',
});

/** How many results show before "Show all". */
const FIRST = 10;

type MatchField =
  | 'title'
  | 'series'
  | 'year'
  | 'season'
  | 'episode'
  | 'source'
  | 'resolution'
  | 'release_group'
  | 'video_codec'
  | 'audio_codec';

export interface SubtitleSearchModalProps {
  kind: SubtitlesKind;
  tmdbId: number;
  seasonNumber?: number;
  episodeNumber?: number;
  /** What is being searched for: the title, or the episode. */
  subTitle: string;
  heading: string;
  /** Show this language's results first, when there are any. */
  language?: string;
  onClose: () => void;
  /** After a subtitle was downloaded, or a transcription asked for. */
  onDone: () => void;
}

const SubtitleSearchModal = ({
  kind,
  tmdbId,
  seasonNumber,
  episodeNumber,
  subTitle,
  heading,
  language,
  onClose,
  onDone,
}: SubtitleSearchModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const mediaServerName = useMediaServerName();
  const { reasonOf } = useSubtitleReasons(kind);
  const base =
    kind === 'movie'
      ? subtitlesKey('movie', tmdbId)
      : `${subtitlesKey('tv', tmdbId)}/season/${seasonNumber}/episode/${episodeNumber}`;
  // Each opening is a new search: one that finds nothing may start a
  // transcription, and its answer is about that moment.
  const [opened] = useState(() => Date.now());
  const { data: answer, error } = useSWR<SubtitleSearchResponse>(
    `${base}/search?transcribeIfNone=true&at=${opened}`,
    (url: string) =>
      axios
        .get<SubtitleSearchResponse>(url.replace(/&at=\d+$/, ''))
        .then((res) => res.data),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    }
  );
  const data = answer?.results;
  const noneFound = answer?.noneFound;
  const { mutate } = useSWRConfig();
  const transcriptionKey = `${subtitlesKey(kind, tmdbId)}/transcription`;

  // When Whisper took over, the page follows it; with nothing else to
  // choose from, the dialog has done its job.
  const told = useRef(false);
  useEffect(() => {
    if (told.current || !noneFound) {
      return;
    }
    told.current = true;
    if (noneFound === 'started' || noneFound === 'alreadyQueued') {
      void mutate(transcriptionKey);
      if (!(data ?? []).some((result) => !result.ai)) {
        addToast(
          intl.formatMessage(
            noneFound === 'started'
              ? messages.noneTranscribing
              : messages.noneQueued
          ),
          { appearance: 'success', autoDismiss: true }
        );
        onDone();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noneFound]);

  const noneFoundNote: Record<NoneFoundOutcome, MessageDescriptor> = {
    started: messages.noneTranscribing,
    alreadyQueued: messages.noneQueued,
    notMissing: (data ?? []).some((result) => result.ai)
      ? messages.noneNotMissing
      : messages.noneNotMissingPlain,
    unavailable: messages.noneUnavailable,
  };
  const languages = useMemo(
    () => [...new Set((data ?? []).map((result) => result.language))].sort(),
    [data]
  );
  const [chosenLanguage, setChosenLanguage] = useState<string>();
  const [sdhOnly, setSdhOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string>();

  const shownLanguage =
    chosenLanguage ??
    (language && languages.includes(language) ? language : languages[0]);
  const results = (data ?? []).filter(
    (result) =>
      (!shownLanguage || result.language === shownLanguage) &&
      (!sdhOnly || result.hi)
  );
  const byProvider = new Map<string, number>();
  for (const result of results) {
    byProvider.set(result.provider, (byProvider.get(result.provider) ?? 0) + 1);
  }

  const choose = async (result: SubtitleSearchResult) => {
    setBusy(result.subtitle);
    try {
      if (result.ai) {
        await axios.post(
          `${subtitlesKey(kind, tmdbId)}/transcription`,
          kind === 'movie'
            ? undefined
            : { scope: 'episode', seasonNumber, episodeNumber }
        );
        addToast(intl.formatMessage(messages.transcribing), {
          appearance: 'success',
          autoDismiss: true,
        });
      } else {
        await axios.post(`${base}/download`, {
          provider: result.provider,
          subtitle: result.subtitle,
          hi: result.hi,
          forced: result.forced,
          originalFormat: result.originalFormat,
        });
        addToast(intl.formatMessage(messages.downloaded, { mediaServerName }), {
          appearance: 'success',
          autoDismiss: true,
        });
      }
      onDone();
    } catch (e) {
      addToast(intl.formatMessage(messages.couldNot, { reason: reasonOf(e) }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(undefined);
    }
  };

  const fieldName = (field: string) =>
    field in messages
      ? intl.formatMessage(messages[field as MatchField])
      : field;

  return (
    <Modal
      title={heading}
      subTitle={subTitle}
      onCancel={onClose}
      cancelText={intl.formatMessage(globalMessages.close)}
      showCloseButton
    >
      {!data && !error && (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <LoadingSpinner />
          <p>{intl.formatMessage(messages.asking)}</p>
        </div>
      )}
      {error && (
        <p className="py-6 text-center">
          {intl.formatMessage(messages.failed)}
        </p>
      )}
      {data && data.length === 0 && (
        <p className="py-6 text-center">
          {intl.formatMessage(
            noneFound ? noneFoundNote[noneFound] : messages.none
          )}
        </p>
      )}
      {data && data.length > 0 && (
        <div className="flex flex-col gap-3">
          {noneFound && (
            <p
              role="status"
              className={
                noneFound === 'started' || noneFound === 'alreadyQueued'
                  ? 'rounded-md border border-indigo-500 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-100'
                  : 'rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-200'
              }
            >
              {intl.formatMessage(noneFoundNote[noneFound])}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {languages.length > 1 && (
              <label className="flex items-center gap-2 text-gray-400">
                {intl.formatMessage(messages.language)}
                <select
                  value={shownLanguage}
                  onChange={(e) => {
                    setChosenLanguage(e.target.value);
                    setShowAll(false);
                  }}
                  className="rounded-md border border-gray-500 bg-gray-700 py-1.5 text-white"
                >
                  {languages.map((code) => (
                    <option key={code} value={code}>
                      {code.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex min-h-[40px] items-center gap-2 text-gray-200">
              <input
                type="checkbox"
                checked={sdhOnly}
                onChange={(e) => setSdhOnly(e.target.checked)}
                className="h-5 w-5 rounded border-gray-500 bg-gray-700 text-indigo-600"
              />
              {intl.formatMessage(messages.sdhOnly)}
            </label>
            <span className="text-xs text-gray-400 sm:ml-auto">
              {intl.formatMessage(messages.summary, {
                count: results.length,
                providers: [...byProvider]
                  .map(([provider, count]) =>
                    intl.formatMessage(messages.providerCount, {
                      provider: providerName(provider),
                      count,
                    })
                  )
                  .join(' · '),
              })}
            </span>
          </div>
          <ul className="divide-y divide-gray-700 border-y border-gray-700">
            {(showAll ? results : results.slice(0, FIRST)).map((result) => (
              <li
                key={`${result.provider}-${result.subtitle}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
              >
                <div className="flex w-14 flex-none flex-col items-center">
                  <span
                    className={
                      result.score >= 90
                        ? 'text-lg font-extrabold text-green-300'
                        : result.score >= 70
                          ? 'text-lg font-extrabold text-yellow-200'
                          : 'text-lg font-extrabold text-red-300'
                    }
                  >
                    {result.score}%
                  </span>
                  <span className="text-[11px] text-gray-400">
                    {intl.formatMessage(messages.match)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-white">
                      {providerName(result.provider)}
                    </span>
                    {result.ai && (
                      <Tag tone="ai">{intl.formatMessage(partMessages.ai)}</Tag>
                    )}
                    {result.hi && (
                      <Tag>{intl.formatMessage(partMessages.sdh)}</Tag>
                    )}
                    {result.forced && (
                      <Tag>{intl.formatMessage(partMessages.forced)}</Tag>
                    )}
                  </div>
                  <span className="break-all text-xs text-gray-300">
                    {result.ai
                      ? intl.formatMessage(messages.transcribeDetail)
                      : result.releases[0]}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {result.matched.map((field) => (
                      <span
                        key={`m-${field}`}
                        className="rounded bg-green-500/10 px-1.5 text-xs text-green-200"
                      >
                        ✓ {fieldName(field)}
                      </span>
                    ))}
                    {result.missed.map((field) => (
                      <span
                        key={`x-${field}`}
                        className="rounded bg-red-500/10 px-1.5 text-xs text-red-200"
                      >
                        ✗ {fieldName(field)}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => choose(result)}
                  disabled={!!busy}
                  className="min-h-[40px] flex-none rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busy === result.subtitle
                    ? intl.formatMessage(globalMessages.loading)
                    : intl.formatMessage(
                        result.ai ? messages.transcribe : messages.use
                      )}
                </button>
              </li>
            ))}
          </ul>
          {!showAll && results.length > FIRST && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="min-h-[40px] self-start rounded-md border border-gray-500 px-4 font-semibold text-gray-200 hover:bg-gray-700"
            >
              {intl.formatMessage(messages.showAll, { count: results.length })}
            </button>
          )}
        </div>
      )}
    </Modal>
  );
};

export default SubtitleSearchModal;
