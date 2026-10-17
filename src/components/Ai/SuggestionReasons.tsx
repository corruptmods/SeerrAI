import AiPanel, { useAiAnswer } from '@app/components/Ai/AiPanel';
import Button from '@app/components/Common/Button';
import useAi from '@app/hooks/useAi';
import defineMessages from '@app/utils/defineMessages';
import { SparklesIcon } from '@heroicons/react/24/outline';
import type { MovieResult, TvResult } from '@server/models/Search';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.SuggestionReasons', {
  why: 'Why These?',
  title: 'Why These Suggestions',
});

interface Reason {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  reason: string;
}

/**
 * Why each of the first page of suggestions was suggested, one line each,
 * from what this person has been watching.
 */
const SuggestionReasons = ({
  titles,
  mediaType,
}: {
  titles: (MovieResult | TvResult)[];
  mediaType: 'all' | 'movie' | 'tv';
}) => {
  const intl = useIntl();
  const { on } = useAi();
  const [open, setOpen] = useState(false);
  const { busy, answer, error, ask } = useAiAnswer<Reason[]>();

  if (!on('aiReasons') || !titles.length) {
    return null;
  }

  const show = () => {
    setOpen(true);
    if (!answer && !busy) {
      ask(async () => {
        const response = await axios.get<Reason[]>('/api/v1/ai/reasons', {
          params: { page: 1, mediaType },
        });
        return response.data;
      });
    }
  };

  const titleOf = (reason: Reason) =>
    titles.find(
      (t) => t.id === reason.tmdbId && t.mediaType === reason.mediaType
    );

  return (
    <>
      <Button
        buttonType="default"
        onClick={show}
        className="mb-2 sm:mb-0 sm:ml-2"
      >
        <SparklesIcon />
        <span>{intl.formatMessage(messages.why)}</span>
      </Button>
      <AiPanel
        show={open}
        title={intl.formatMessage(messages.title)}
        onClose={() => setOpen(false)}
        busy={busy}
        error={error}
      >
        <ul className="space-y-3">
          {(answer ?? [])
            .filter((reason) => reason.reason && titleOf(reason))
            .map((reason) => {
              const title = titleOf(reason)!;
              return (
                <li key={`${reason.mediaType}-${reason.tmdbId}`}>
                  <Link
                    href={`/${reason.mediaType}/${reason.tmdbId}`}
                    className="font-semibold text-strong hover:underline"
                  >
                    {title.mediaType === 'movie' ? title.title : title.name}
                  </Link>
                  <p className="text-gray-300">{reason.reason}</p>
                </li>
              );
            })}
        </ul>
      </AiPanel>
    </>
  );
};

export default SuggestionReasons;
