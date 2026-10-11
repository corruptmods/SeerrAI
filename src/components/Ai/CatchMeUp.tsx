import AiPanel, { useAiAnswer } from '@app/components/Ai/AiPanel';
import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import useAi from '@app/hooks/useAi';
import defineMessages from '@app/utils/defineMessages';
import { SparklesIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.CatchMeUp', {
  catchUp: 'Catch Me Up',
  tip: 'A spoiler-free recap of everything before where you are',
  title: 'Catch Me Up',
  before: 'Recap everything before',
  season: 'Season',
  episode: 'Episode',
  fromHistory: 'From your watch history, you are up to this episode.',
  recap: 'Recap',
  endOfSeason: 'End of season',
});

interface Season {
  seasonNumber: number;
  episodeCount: number;
}

/**
 * A spoiler-free "previously on" for a series, up to the next episode this
 * person has not seen (from their watch history), or wherever they choose.
 */
const CatchMeUp = ({
  tmdbId,
  seasons,
}: {
  tmdbId: number;
  seasons: Season[];
}) => {
  const intl = useIntl();
  const { on } = useAi();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    season: number;
    episode: number;
  }>();
  const [known, setKnown] = useState(false);
  const recap = useAiAnswer<{ text: string }>();

  const regular = seasons
    .filter((s) => s.seasonNumber >= 1 && s.episodeCount > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber);

  // Nothing to recap in a first season's first episode.
  if (
    !on('aiRecap') ||
    !regular.length ||
    (regular.length === 1 && regular[0].episodeCount < 2)
  ) {
    return null;
  }

  const show = async () => {
    setOpen(true);
    if (position) {
      return;
    }
    // Where they are, if their history says; otherwise the start of the
    // latest season, the usual reason for wanting a recap.
    const latest = regular[regular.length - 1];
    let start = { season: latest.seasonNumber, episode: 1 };
    try {
      const response = await axios.get<{
        position: { season: number; episode: number } | null;
      }>(`/api/v1/ai/recap/${tmdbId}/position`);
      if (response.data.position) {
        const count =
          regular.find((s) => s.seasonNumber === response.data.position?.season)
            ?.episodeCount ?? 0;
        start = {
          season: response.data.position.season,
          episode: Math.min(response.data.position.episode, count + 1),
        };
        setKnown(true);
      }
    } catch {
      // Chosen by hand instead.
    }
    if (
      start.season === regular[0].seasonNumber &&
      start.episode === 1 &&
      regular[0].episodeCount > 1
    ) {
      start = { season: regular[0].seasonNumber, episode: 2 };
    }
    setPosition(start);
  };

  const episodes =
    regular.find((s) => s.seasonNumber === position?.season)?.episodeCount ?? 0;
  // One past the last episode recaps the whole season.
  const choices = Array.from({ length: episodes + 1 }, (_, i) => i + 1);

  return (
    <>
      <Tooltip content={intl.formatMessage(messages.tip)}>
        <Button buttonType="default" className="z-20" onClick={show}>
          <SparklesIcon />
          <span>{intl.formatMessage(messages.catchUp)}</span>
        </Button>
      </Tooltip>
      <AiPanel
        show={open}
        title={intl.formatMessage(messages.title)}
        onClose={() => setOpen(false)}
        busy={recap.busy}
        error={recap.error}
      >
        {position && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              recap.ask(async () => {
                const response = await axios.get<{ text: string }>(
                  `/api/v1/ai/recap/${tmdbId}`,
                  { params: position }
                );
                return response.data;
              });
            }}
          >
            <p className="text-gray-300">
              {intl.formatMessage(messages.before)}
            </p>
            <div className="flex gap-3">
              <label className="flex-1 space-y-1">
                <span className="block text-gray-400">
                  {intl.formatMessage(messages.season)}
                </span>
                <select
                  value={position.season}
                  onChange={(e) => {
                    setKnown(false);
                    setPosition({ season: Number(e.target.value), episode: 1 });
                  }}
                >
                  {regular.map((s) => (
                    <option key={s.seasonNumber} value={s.seasonNumber}>
                      {s.seasonNumber}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex-1 space-y-1">
                <span className="block text-gray-400">
                  {intl.formatMessage(messages.episode)}
                </span>
                <select
                  value={position.episode}
                  onChange={(e) => {
                    setKnown(false);
                    setPosition({
                      ...position,
                      episode: Number(e.target.value),
                    });
                  }}
                >
                  {choices.map((n) => (
                    <option key={n} value={n}>
                      {n > episodes
                        ? intl.formatMessage(messages.endOfSeason)
                        : n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {known && (
              <p className="text-xs text-gray-400">
                {intl.formatMessage(messages.fromHistory)}
              </p>
            )}
            <Button
              buttonType="primary"
              type="submit"
              disabled={
                recap.busy ||
                (position.season === regular[0].seasonNumber &&
                  position.episode === 1)
              }
            >
              <SparklesIcon />
              <span>{intl.formatMessage(messages.recap)}</span>
            </Button>
          </form>
        )}
        {recap.answer && (
          <p className="whitespace-pre-line leading-relaxed text-gray-200">
            {recap.answer.text}
          </p>
        )}
      </AiPanel>
    </>
  );
};

export default CatchMeUp;
