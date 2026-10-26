import { useBackfillForTitle } from '@app/components/Backfill/ForTitle';
import type { LibraryTitle } from '@app/components/Backfill/StartSearchModal';
import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import useLazyModule from '@app/hooks/useLazyModule';
import defineMessages from '@app/utils/defineMessages';
import { DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Backfill.TitleButton', {
  search: 'Search with Backfill',
  open: 'Open in Backfill',
  waiting: 'Backfill: a pack is waiting for approval',
  running: 'Backfill: downloading {progress}%',
  runningMany: 'Backfill: {count} downloads',
});

const loadStart = () => import('@app/components/Backfill/StartSearchModal');

/*
 * Backfill on a series', movie's or album's page, for admins: opens the title's
 * Backfill page (its downloads are listed there and in the page's Backfill
 * box), or starts a search for a title it isn't following yet. The
 * dialog's code loads only when it is opened.
 */
const BackfillTitleButton = ({
  id,
  target,
}: {
  /** The TMDB id; an album's MusicBrainz id. */
  id: number | string;
  target: LibraryTitle;
}) => {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const tracked = useBackfillForTitle(id, target);
  const loaded = useLazyModule(loadStart, open, () => setOpen(false));
  const Start = loaded?.default;

  if (tracked) {
    const jobs = tracked.jobs ?? [];
    const label =
      jobs.length > 1
        ? intl.formatMessage(messages.runningMany, { count: jobs.length })
        : tracked.job
          ? intl.formatMessage(messages.running, {
              progress: tracked.job.progress,
            })
          : tracked.readyCount
            ? intl.formatMessage(messages.waiting)
            : intl.formatMessage(messages.open);
    return (
      <Tooltip content={label}>
        <Link href={`/backfill/series/${tracked.id}`} passHref legacyBehavior>
          <Button
            as="a"
            buttonType="ghost"
            className="media-action-icon relative"
            aria-label={label}
          >
            <DocumentMagnifyingGlassIcon className="!mr-0" />
            {(tracked.readyCount > 0 || tracked.job) && (
              <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-indigo-500" />
            )}
          </Button>
        </Link>
      </Tooltip>
    );
  }

  return (
    <>
      <Tooltip content={intl.formatMessage(messages.search)}>
        <Button
          buttonType="ghost"
          className="media-action-icon"
          onClick={() => setOpen(true)}
        >
          <DocumentMagnifyingGlassIcon className="!mr-0" />
        </Button>
      </Tooltip>
      {Start && (
        <Start show={open} onClose={() => setOpen(false)} target={target} />
      )}
    </>
  );
};

export default BackfillTitleButton;
