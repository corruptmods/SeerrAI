import {
  HEADER_BUTTON,
  HEADER_ICON,
  ProgressBar,
} from '@app/components/Backfill/shared';
import type { SearchAllStatus } from '@app/components/Backfill/types';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { MagnifyingGlassIcon, StopIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Backfill.SearchAll', {
  searchAll: 'Search all stuck',
  explain:
    'Searches every stuck title one at a time, with a pause between, instead of a few each scan: titles someone requested first. Titles Sonarr or Radarr searched for today are included; ones Backfill searched in the last day are not. Packs that pass auto-approve start downloading as they are found. Each title is a query to every indexer, so this takes a while.',
  start: 'Search All Stuck',
  cancel: 'Cancel',
  starting: 'Starting…',
  running: 'Searching everything stuck',
  progress:
    '{done} of {total} searched · {found, plural, =0 {nothing found yet} one {packs found for # title} other {packs found for # titles}}',
  preparing: 'Reading what Sonarr and Radarr are missing…',
  now: 'Now: {title}',
  stop: 'Stop',
  stopping: 'Stopping after this title…',
  finished:
    'Searched {done} of {total} stuck {total, plural, one {title} other {titles}}; {found, plural, =0 {nothing new was found} one {packs found for # title} other {packs found for # titles}}.',
  failed: 'Could not start searching.',
  stopFailed: 'Could not stop searching.',
});

/**
 * Searching every stuck title at a steady pace: the button, what it does
 * before it starts, and how far it has got while it runs.
 */
export const SearchAllButton = ({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) => {
  const intl = useIntl();
  return (
    <Button
      buttonType="default"
      onClick={onClick}
      disabled={disabled}
      className={HEADER_BUTTON}
    >
      <MagnifyingGlassIcon className={HEADER_ICON} />
      <span>{intl.formatMessage(messages.searchAll)}</span>
    </Button>
  );
};

const SearchAllPanel = ({
  status,
  confirming,
  onCancel,
  onChanged,
}: {
  status: SearchAllStatus;
  confirming: boolean;
  onCancel: () => void;
  onChanged: () => void;
}) => {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [problem, setProblem] = useState<string>();
  const running = status.running;

  if (running) {
    const ready = running.total > 0;
    return (
      <div className="rounded-lg bg-gray-800 p-4 ring-1 ring-indigo-500/40">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-white">
              {intl.formatMessage(messages.running)}
            </p>
            <p className="text-sm text-gray-300">
              {ready
                ? intl.formatMessage(messages.progress, running)
                : intl.formatMessage(messages.preparing)}
            </p>
          </div>
          <Button
            buttonType="default"
            buttonSize="sm"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              setProblem(undefined);
              try {
                await axios.delete('/api/v1/backfill/search-all');
              } catch (e) {
                // Still running: offer Stop again, and say why it didn't.
                setStopping(false);
                setProblem(
                  axios.isAxiosError(e) && e.response?.data?.message
                    ? String(e.response.data.message)
                    : intl.formatMessage(messages.stopFailed)
                );
              }
              onChanged();
            }}
          >
            <StopIcon />
            <span>
              {intl.formatMessage(stopping ? messages.stopping : messages.stop)}
            </span>
          </Button>
        </div>
        {problem && <p className="mt-2 text-sm text-red-300">{problem}</p>}
        {ready && (
          <div className="mt-3 space-y-2">
            <ProgressBar
              value={(running.done / running.total) * 100}
              done={running.done === running.total}
            />
            {running.current && (
              <p className="truncate text-xs text-gray-400">
                {intl.formatMessage(messages.now, { title: running.current })}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="rounded-lg bg-gray-800 p-4 ring-1 ring-gray-700">
        <p className="text-sm text-gray-300">
          {intl.formatMessage(messages.explain)}
        </p>
        {problem && <p className="mt-2 text-sm text-red-300">{problem}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            buttonType="primary"
            buttonSize="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setProblem(undefined);
              setStopping(false);
              try {
                await axios.post('/api/v1/backfill/search-all');
                onCancel();
                onChanged();
              } catch (e) {
                setProblem(
                  axios.isAxiosError(e) && e.response?.data?.message
                    ? String(e.response.data.message)
                    : intl.formatMessage(messages.failed)
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <MagnifyingGlassIcon />
            <span>
              {intl.formatMessage(busy ? messages.starting : messages.start)}
            </span>
          </Button>
          <Button buttonType="ghost" buttonSize="sm" onClick={onCancel}>
            {intl.formatMessage(messages.cancel)}
          </Button>
        </div>
      </div>
    );
  }

  if (status.last) {
    return (
      <p className="text-sm text-gray-400">
        {status.last.stoppedBecause ? `${status.last.stoppedBecause} ` : ''}
        {intl.formatMessage(messages.finished, status.last)}
      </p>
    );
  }
  return null;
};

export default SearchAllPanel;
