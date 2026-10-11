import Modal from '@app/components/Common/Modal';
import { subtitlesKey } from '@app/hooks/useSubtitles';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isTranscribed } from '@app/utils/subtitles';
import type {
  EpisodeSubtitles,
  TranscribeScope,
} from '@server/interfaces/api/subtitlesInterfaces';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Subtitles.TranscribeModal', {
  title: 'Transcribe Episodes',
  intro:
    'Whisper listens to each episode and writes its subtitles. It runs one episode at a time and can take several minutes each. Episodes it has already done are left out.',
  missing: 'Episodes with no subtitles',
  season: 'One season',
  everything: 'Every episode not transcribed yet',
  episodes: '{count, plural, one {# episode} other {# episodes}}',
  seasonName: 'Season {season}',
  start: 'Transcribe {count, plural, one {# Episode} other {# Episodes}}',
  started:
    'Transcribing {count, plural, one {# episode} other {# episodes}}. Each one shows here when it is done.',
  nothing: 'Those episodes were already queued or transcribed.',
  failed: 'Bazarr did not answer. Try again in a moment.',
});

export interface TranscribeModalProps {
  tmdbId: number;
  subTitle: string;
  episodes: EpisodeSubtitles[];
  onClose: () => void;
  onStarted: () => void;
}

const TranscribeModal = ({
  tmdbId,
  subTitle,
  episodes,
  onClose,
  onStarted,
}: TranscribeModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const todo = episodes.filter((episode) => !isTranscribed(episode));
  const seasons = [...new Set(todo.map((e) => e.seasonNumber))].sort(
    (a, b) => b - a
  );
  const missingCount = todo.filter((e) => e.missing.length > 0).length;
  const [scope, setScope] = useState<TranscribeScope>(
    missingCount > 0 ? 'missing' : 'notTranscribed'
  );
  const [season, setSeason] = useState(seasons[0] ?? 1);
  const [sending, setSending] = useState(false);

  const count =
    scope === 'missing'
      ? missingCount
      : scope === 'season'
        ? todo.filter((e) => e.seasonNumber === season).length
        : todo.length;

  const start = async () => {
    setSending(true);
    try {
      const { data } = await axios.post<{ added: number }>(
        `${subtitlesKey('tv', tmdbId)}/transcription`,
        scope === 'season' ? { scope, seasonNumber: season } : { scope }
      );
      addToast(
        data.added > 0
          ? intl.formatMessage(messages.started, { count: data.added })
          : intl.formatMessage(messages.nothing),
        { appearance: data.added > 0 ? 'success' : 'info', autoDismiss: true }
      );
      onStarted();
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSending(false);
    }
  };

  const option = (
    value: TranscribeScope,
    label: string,
    n: number,
    extra?: React.ReactNode
  ) => (
    <label
      className={
        scope === value
          ? 'flex min-h-[52px] cursor-pointer items-center gap-3 rounded-lg border border-indigo-500 bg-indigo-500/10 px-3 py-2'
          : 'flex min-h-[52px] cursor-pointer items-center gap-3 rounded-lg border border-gray-600 px-3 py-2 hover:border-gray-500'
      }
    >
      <input
        type="radio"
        name="transcribe-scope"
        value={value}
        checked={scope === value}
        disabled={n === 0 && value !== 'season'}
        onChange={() => setScope(value)}
        className="h-5 w-5 border-gray-500 bg-gray-700 text-indigo-600"
      />
      <span className="flex flex-1 flex-col">
        <span className="font-semibold text-white">{label}</span>
        <span className="text-xs text-gray-400">
          {intl.formatMessage(messages.episodes, { count: n })}
        </span>
      </span>
      {extra}
    </label>
  );

  return (
    <Modal
      title={intl.formatMessage(messages.title)}
      subTitle={subTitle}
      onCancel={onClose}
      cancelText={intl.formatMessage(globalMessages.cancel)}
      onOk={start}
      okText={intl.formatMessage(messages.start, { count })}
      okDisabled={count === 0 || sending}
      okButtonType="primary"
    >
      <p className="mb-4">{intl.formatMessage(messages.intro)}</p>
      <div className="flex flex-col gap-2">
        {option('missing', intl.formatMessage(messages.missing), missingCount)}
        {seasons.length > 0 &&
          option(
            'season',
            intl.formatMessage(messages.season),
            todo.filter((e) => e.seasonNumber === season).length,
            <select
              aria-label={intl.formatMessage(messages.season)}
              value={season}
              onChange={(e) => {
                setSeason(Number(e.target.value));
                setScope('season');
              }}
              className="rounded-md border border-gray-500 bg-gray-700 py-1.5 text-white"
            >
              {seasons.map((s) => (
                <option key={s} value={s}>
                  {intl.formatMessage(messages.seasonName, { season: s })}
                </option>
              ))}
            </select>
          )}
        {option(
          'notTranscribed',
          intl.formatMessage(messages.everything),
          todo.length
        )}
      </div>
    </Modal>
  );
};

export default TranscribeModal;
