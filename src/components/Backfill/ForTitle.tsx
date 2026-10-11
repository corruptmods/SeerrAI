import {
  JobStatusBadge,
  ProgressBar,
  SeriesStatusBadge,
  formatBytes,
  formatDuration,
} from '@app/components/Backfill/shared';
import type { TitleKind, TitleLookup } from '@app/components/Backfill/types';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Backfill.ForTitle', {
  backfill: 'Backfill',
  open: 'Open in Backfill',
  review: 'Review the pack',
  missingCount: '{count} missing',
  belowCutoff: '{count} below cutoff',
  movieMissing: 'The movie is missing',
  movieBelowCutoff: 'The file is below the cutoff',
  nothingMissing: 'Nothing missing',
  waiting:
    '{count, plural, one {A pack waits} other {# packs wait}} for approval',
  downloads: '{count, plural, one {# download} other {# downloads}}',
  left: '{size} left · {speed}/s',
  eta: '{time} left',
});

export interface ForTitleTarget {
  kind: TitleKind;
  serverId: number;
  arrId: number;
}

/**
 * What Backfill has for the title a page is about, or undefined when it
 * doesn't follow it. The page's button and its Backfill box ask together,
 * in one request; it stays live while something downloads.
 */
export const useBackfillForTitle = (
  tmdbId: number,
  target: ForTitleTarget
): TitleLookup | undefined => {
  const { data } = useSWR<TitleLookup[]>(
    `/api/v1/backfill/lookup?tmdbIds=${tmdbId}&all=true`,
    {
      refreshInterval: (latest) =>
        latest?.some((row) =>
          (row.jobs ?? []).some((j) => j.status === 'downloading')
        )
          ? 3000
          : latest?.some(
                (row) => row.jobs?.length || row.status === 'searching'
              )
            ? 8000
            : 0,
    }
  );
  const rows = (data ?? []).filter((row) => row.kind === target.kind);
  return (
    rows.find(
      (row) => row.serverId === target.serverId && row.arrId === target.arrId
    ) ?? rows[0]
  );
};

/**
 * On a series' or movie's page, for admins: where Backfill is with it, the
 * downloads it has running (each opens its own page), and the way to its
 * Backfill page. Nothing for a title it doesn't follow, or has completed
 * with nothing left running; the page's Backfill button still leads there.
 */
const BackfillForTitle = ({
  tmdbId,
  target,
}: {
  tmdbId: number;
  target: ForTitleTarget;
}) => {
  const intl = useIntl();
  const tracked = useBackfillForTitle(tmdbId, target);
  const jobs = tracked?.jobs ?? [];
  if (!tracked || (tracked.status === 'done' && !jobs.length)) return null;

  const gap =
    tracked.kind === 'movie'
      ? tracked.missing
        ? intl.formatMessage(messages.movieMissing)
        : tracked.belowCutoff
          ? intl.formatMessage(messages.movieBelowCutoff)
          : intl.formatMessage(messages.nothingMissing)
      : [
          tracked.missing
            ? intl.formatMessage(messages.missingCount, {
                count: tracked.missing,
              })
            : '',
          tracked.belowCutoff
            ? intl.formatMessage(messages.belowCutoff, {
                count: tracked.belowCutoff,
              })
            : '',
        ]
          .filter(Boolean)
          .join(' · ') || intl.formatMessage(messages.nothingMissing);

  return (
    <section className="mb-6 overflow-hidden rounded-lg bg-gray-800 ring-1 ring-gray-700">
      <div className="flex items-center justify-between gap-3 border-b border-gray-700 px-4 py-3">
        <h3 className="flex items-center gap-2 font-semibold text-white">
          <DocumentMagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
          {intl.formatMessage(messages.backfill)}
        </h3>
        <SeriesStatusBadge status={tracked.status} />
      </div>
      <div className="space-y-3 p-4">
        <div className="text-sm text-gray-300">
          {gap}
          {jobs.length > 0 &&
            ` · ${intl.formatMessage(messages.downloads, {
              count: jobs.length,
            })}`}
        </div>
        {tracked.readyCount > 0 && (
          <div className="text-sm text-yellow-300">
            {intl.formatMessage(messages.waiting, {
              count: tracked.readyCount,
            })}
          </div>
        )}
        {jobs.length > 0 && (
          <ul className="-mx-2 max-h-96 space-y-1 overflow-y-auto overscroll-contain">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/backfill/jobs/${job.id}`}
                  className="block rounded-md px-2 py-2 hover:bg-gray-700/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    {/* Two lines, so the episode in the release's name
                        shows on a narrow box. */}
                    <div className="line-clamp-2 min-w-0 break-words text-sm text-white">
                      {job.title}
                    </div>
                    <span className="flex-shrink-0">
                      <JobStatusBadge
                        status={job.status}
                        progress={job.progress}
                        kind={tracked.kind}
                      />
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <ProgressBar value={job.progress} />
                  </div>
                  <div className="mt-1 flex justify-between gap-2 text-xs text-gray-400">
                    <span className="min-w-0">
                      {job.status === 'downloading' && job.progress < 100
                        ? intl.formatMessage(messages.left, {
                            size: formatBytes(job.sizeLeft),
                            speed: formatBytes(job.speed),
                          })
                        : (job.stage ?? '')}
                    </span>
                    <span className="flex-shrink-0 tabular-nums">
                      {job.secondsLeft
                        ? intl.formatMessage(messages.eta, {
                            time: formatDuration(job.secondsLeft),
                          })
                        : `${job.progress}%`}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link href={`/backfill/series/${tracked.id}`} passHref legacyBehavior>
          <Button
            as="a"
            buttonSize="sm"
            buttonType={tracked.readyCount ? 'primary' : 'default'}
            className="w-full"
          >
            <span>
              {intl.formatMessage(
                tracked.readyCount ? messages.review : messages.open
              )}
            </span>
          </Button>
        </Link>
      </div>
    </section>
  );
};

export default BackfillForTitle;
