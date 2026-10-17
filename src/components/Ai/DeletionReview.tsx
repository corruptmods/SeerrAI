import AiPanel, { useAiAnswer } from '@app/components/Ai/AiPanel';
import { KeepButton } from '@app/components/DeletingSoon';
import useAi from '@app/hooks/useAi';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { SparklesIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.DeletionReview', {
  review: 'Review with AI',
  title: 'Review Deletions',
  intro:
    'Titles that may be deleted by mistake: someone part-way through, rewatched often, recently requested or on a watch list.',
  none: 'Nothing looks like a mistake.',
  deletes: 'Deletes {date}',
});

interface Flagged {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  deleteAt: string;
  reason: string;
}

/**
 * A second look at what Maintainerr is about to delete, for those who
 * manage requests: the titles that may be a mistake, each with its Keep.
 */
const DeletionReview = () => {
  const intl = useIntl();
  const { on } = useAi();
  const { hasPermission } = useUser();
  const [open, setOpen] = useState(false);
  const { busy, answer, error, ask } = useAiAnswer<Flagged[]>();

  if (
    !on('aiDeletionReview') ||
    !hasPermission([Permission.MANAGE_REQUESTS, Permission.ADMIN], {
      type: 'or',
    })
  ) {
    return null;
  }

  const show = () => {
    setOpen(true);
    if (!answer && !busy) {
      ask(async () => {
        const response = await axios.post<Flagged[]>(
          '/api/v1/ai/deletion-review'
        );
        return response.data;
      });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="ml-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-indigo-300 ring-1 ring-gray-700 transition hover:text-indigo-200 hover:ring-gray-500 light:text-accent-text light:hover:text-accent-text"
      >
        <SparklesIcon className="h-4 w-4" />
        {intl.formatMessage(messages.review)}
      </button>
      <AiPanel
        show={open}
        title={intl.formatMessage(messages.title)}
        onClose={() => setOpen(false)}
        busy={busy}
        error={error}
      >
        <p className="text-gray-300">{intl.formatMessage(messages.intro)}</p>
        {answer && !answer.length && (
          <p className="text-gray-400">{intl.formatMessage(messages.none)}</p>
        )}
        <ul className="space-y-4">
          {(answer ?? []).map((item) => (
            <li
              key={`${item.mediaType}-${item.tmdbId}`}
              className="space-y-2 rounded-lg bg-gray-900/60 p-3 ring-1 ring-gray-700"
            >
              <div className="flex items-baseline justify-between gap-3">
                <Link
                  href={`/${item.mediaType}/${item.tmdbId}`}
                  className="font-semibold text-strong hover:underline"
                >
                  {item.title}
                </Link>
                <span className="flex-none text-xs text-red-300 light:text-danger-text">
                  {intl.formatMessage(messages.deletes, {
                    date: intl.formatDate(item.deleteAt, {
                      month: 'short',
                      day: 'numeric',
                    }),
                  })}
                </span>
              </div>
              <p className="text-gray-300">{item.reason}</p>
              <KeepButton
                tmdbId={item.tmdbId}
                mediaType={item.mediaType}
                title={item.title}
                compact
              />
            </li>
          ))}
        </ul>
      </AiPanel>
    </>
  );
};

export default DeletionReview;
