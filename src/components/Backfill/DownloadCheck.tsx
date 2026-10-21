import { SeriesPoster } from '@app/components/Backfill/shared';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import type { CheckAction, CheckStatus } from '@server/entity/DownloadCheck';
import type {
  DownloadCheckOverview,
  DownloadCheckRow,
} from '@server/interfaces/api/downloadCheckInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import type { IntlShape } from 'react-intl';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Backfill.DownloadCheck', {
  title: 'Download Check',
  description:
    'Looks at what Sonarr and Radarr grab, and sorts out imports that get stuck.',
  off: 'Off. Turn it on in <link>Settings → Backfill</link>.',
  report: 'Report only: nothing is changed.',
  modeReport: 'Report only',
  modeOn: 'On',
  week: 'This week: {rejected} rejected, {imported} imported, {cleared} cleared.',
  waiting:
    '{count, plural, one {# download needs you} other {# downloads need you}}',
  empty: 'Nothing found yet.',
  program: 'Has a program in it: {files}',
  archive: 'Only packed files, which {app} can’t import',
  noVideo: 'No video in it',
  sample: 'Only a sample',
  early:
    'Grabbed {days, plural, one {a day} other {# days}} before the episode aired',
  earlyHours: 'Grabbed {hours} hours before the episode aired',
  otherCountry: 'Another country’s version ({country})',
  otherYear: 'Another title, from {year}',
  otherEpisode: 'Its episode is “{named}”, not “{expected}”',
  otherTitle: 'Another title',
  renumberedHave: 'It’s {episode}, “{title}”, which you have',
  renumbered: 'Numbered another way: it’s {episode}, “{title}”',
  notUpgrade: 'No better than the file there: {offered} against {have}',
  notUpgradeShort: 'No better than the file there',
  moreEpisodes: 'The file there also has {also}',
  duplicate: 'A better copy is already coming',
  sameTitle: 'The right title, named another way',
  unsureTitle: 'Matched by ID only; the name doesn’t show it’s this title',
  xem: 'Its numbering isn’t confirmed on TheXEM yet',
  sampleUnsure: '{app} couldn’t tell if it’s a sample',
  unparsed: '{app} couldn’t read the file name',
  badFiles: 'Nothing in it {app} can import',
  partial: 'Only part of it came in',
  alreadyImported: 'Already imported',
  unknown: 'Stuck for a reason Download Check doesn’t know',
  unmapped: 'Which file is which episode can’t be told',
  doneReject: 'Rejected',
  doneDrop: 'Removed',
  doneClear: 'Cleared',
  doneImport: 'Imported',
  wouldReject: 'Would reject',
  wouldDrop: 'Would remove',
  wouldClear: 'Would clear',
  wouldImport: 'Would import',
  needsYou: 'Needs you',
  failed: 'Couldn’t do it: {error}',
  failedBadge: 'Failed',
  dismissed: 'Left alone',
  gone: 'Left the queue',
  reject: 'Reject',
  drop: 'Remove',
  clear: 'Clear',
  import: 'Import',
  tryAgain: 'Try again',
  leave: 'Leave',
  showWords: 'What {app} said',
  problem: 'That didn’t work.',
});

const appName = (app: 'sonarr' | 'radarr') =>
  app === 'sonarr' ? 'Sonarr' : 'Radarr';

/** What it found, in words. */
export const findingText = (
  intl: IntlShape,
  row: Pick<DownloadCheckRow, 'finding' | 'params' | 'app'>
): string => {
  const p = row.params as {
    files?: string[];
    hours?: number;
    reason?: string;
    named?: { year?: number; country?: string };
    episodeTitle?: string;
    expected?: string;
    episode?: { label: string; title?: string; hasFile?: boolean };
    have?: string;
    offered?: string;
    also?: string;
  };
  const app = appName(row.app);
  const f = row.finding;
  switch (f) {
    case 'program':
      return intl.formatMessage(messages.program, {
        files: (p.files ?? []).join(', '),
      });
    case 'early':
      return (p.hours ?? 0) >= 48
        ? intl.formatMessage(messages.early, {
            days: Math.round((p.hours ?? 0) / 24),
          })
        : intl.formatMessage(messages.earlyHours, { hours: p.hours ?? 0 });
    case 'otherTitle':
      if (p.reason === 'country' && p.named?.country) {
        return intl.formatMessage(messages.otherCountry, {
          country: p.named.country.toUpperCase(),
        });
      }
      if (p.reason === 'year' && p.named?.year) {
        return intl.formatMessage(messages.otherYear, { year: p.named.year });
      }
      if (p.reason === 'episodeTitle' && p.episodeTitle && p.expected) {
        return intl.formatMessage(messages.otherEpisode, {
          named: p.episodeTitle,
          expected: p.expected,
        });
      }
      return intl.formatMessage(messages.otherTitle);
    case 'renumbered':
      return intl.formatMessage(
        p.episode?.hasFile ? messages.renumberedHave : messages.renumbered,
        { episode: p.episode?.label ?? '', title: p.episode?.title ?? '' }
      );
    case 'notUpgrade':
      return p.have && p.offered
        ? intl.formatMessage(messages.notUpgrade, {
            have: p.have,
            offered: p.offered,
          })
        : intl.formatMessage(messages.notUpgradeShort);
    case 'moreEpisodes':
      return intl.formatMessage(messages.moreEpisodes, { also: p.also ?? '' });
    case 'archive':
    case 'sampleUnsure':
    case 'unparsed':
    case 'badFiles':
      return intl.formatMessage(messages[f], { app });
    default:
      return messages[f]
        ? intl.formatMessage(messages[f])
        : intl.formatMessage(messages.unknown);
  }
};

const DONE: Record<CheckAction, keyof typeof messages | undefined> = {
  reject: 'doneReject',
  drop: 'doneDrop',
  clear: 'doneClear',
  import: 'doneImport',
  review: undefined,
};

const WOULD: Record<CheckAction, keyof typeof messages | undefined> = {
  reject: 'wouldReject',
  drop: 'wouldDrop',
  clear: 'wouldClear',
  import: 'wouldImport',
  review: undefined,
};

const TONE: Record<CheckStatus, string> = {
  would: 'bg-indigo-500/15 text-indigo-200 light:text-accent-text',
  waiting: 'bg-yellow-500/15 text-yellow-300 light:text-warning-text',
  done: 'bg-green-500/15 text-success-text',
  failed: 'bg-red-500/15 text-red-300 light:text-danger-text',
  dismissed: 'bg-gray-700 text-gray-300',
  gone: 'bg-gray-700 text-gray-300',
};

/** What it did, or would do, in a word or two. */
const outcomeText = (intl: IntlShape, row: DownloadCheckRow): string => {
  const action = row.action;
  switch (row.status) {
    case 'done':
      return intl.formatMessage(messages[DONE[action] ?? 'doneReject']);
    case 'would':
      return intl.formatMessage(messages[WOULD[action] ?? 'wouldReject']);
    case 'waiting':
      return intl.formatMessage(messages.needsYou);
    case 'failed':
      return intl.formatMessage(messages.failed, { error: row.error ?? '' });
    case 'dismissed':
      return intl.formatMessage(messages.dismissed);
    default:
      return intl.formatMessage(messages.gone);
  }
};

type Choice = 'reject' | 'import' | 'clear' | 'drop' | 'dismiss';

/** What an admin may choose for a row, the suggestion first. */
const choicesFor = (row: DownloadCheckRow): Choice[] => {
  const action = row.action;
  const canImport = row.stage === 'import';
  switch (row.status) {
    case 'waiting':
      return canImport
        ? ['import', 'reject', 'dismiss']
        : ['reject', 'dismiss'];
    case 'would':
    case 'failed':
      if (action === 'review') return ['dismiss'];
      return action === 'import'
        ? ['import', 'reject', 'dismiss']
        : [action as Choice, 'dismiss'];
    default:
      return [];
  }
};

const LABEL: Record<Choice, keyof typeof messages> = {
  reject: 'reject',
  import: 'import',
  clear: 'clear',
  drop: 'drop',
  dismiss: 'leave',
};

/**
 * Download Check on the Backfill page: what it found lately, what it did
 * (or, with Report only, would do), and what's waiting for an admin.
 */
const DownloadCheckPanel = () => {
  const intl = useIntl();
  const [busy, setBusy] = useState<number>();
  const [problem, setProblem] = useState<{ id: number; text: string }>();
  const { data, mutate } = useSWR<DownloadCheckOverview>(
    '/api/v1/backfill/download-check',
    {
      refreshInterval: 30_000,
    }
  );

  if (!data) return null;

  const choose = async (row: DownloadCheckRow, choice: Choice) => {
    setBusy(row.id);
    setProblem(undefined);
    try {
      await axios.post(`/api/v1/backfill/download-check/${row.id}`, {
        choice,
      });
    } catch (e) {
      setProblem({
        id: row.id,
        text:
          axios.isAxiosError(e) && e.response?.data?.message
            ? String(e.response.data.message)
            : intl.formatMessage(messages.problem),
      });
    } finally {
      setBusy(undefined);
      await mutate();
    }
  };

  return (
    <section
      id="download-check"
      aria-labelledby="download-check-title"
      className="rounded-lg bg-gray-800 ring-1 ring-gray-700"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-gray-700 px-5 py-4">
        <div className="min-w-0">
          <h3
            id="download-check-title"
            className="flex items-center gap-2 text-lg font-semibold text-strong"
          >
            <ShieldCheckIcon className="h-5 w-5 flex-none text-indigo-400 light:text-accent-text" />
            {intl.formatMessage(messages.title)}
          </h3>
          <p className="mt-0.5 text-sm text-gray-400">
            {data.mode === 'off'
              ? intl.formatMessage(messages.off, {
                  link: (text: React.ReactNode) => (
                    <Link
                      key="link"
                      href="/settings/backfill#download-check"
                      className="text-indigo-400 hover:underline light:text-accent-text"
                    >
                      {text}
                    </Link>
                  ),
                })
              : data.mode === 'report'
                ? intl.formatMessage(messages.report)
                : intl.formatMessage(messages.description)}
          </p>
        </div>
        {data.mode !== 'off' && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              data.mode === 'on' ? TONE.done : TONE.would
            }`}
          >
            {intl.formatMessage(
              data.mode === 'on' ? messages.modeOn : messages.modeReport
            )}
          </span>
        )}
      </div>
      {(data.rows.length > 0 || data.mode !== 'off') && (
        <div className="border-b border-gray-700 px-5 py-2 text-sm text-gray-300">
          {data.waiting > 0 && (
            <span className="mr-2 font-medium text-yellow-300 light:text-warning-text">
              {intl.formatMessage(messages.waiting, { count: data.waiting })}
            </span>
          )}
          {intl.formatMessage(messages.week, {
            rejected: data.week.rejected,
            imported: data.week.imported,
            cleared: data.week.cleared,
          })}
        </div>
      )}
      <ul className="max-h-[32rem] divide-y divide-gray-700 overflow-y-auto">
        {!data.rows.length && data.mode !== 'off' && (
          <li className="px-5 py-4 text-sm text-gray-400">
            {intl.formatMessage(messages.empty)}
          </li>
        )}
        {data.rows.map((row) => {
          const choices = choicesFor(row);
          return (
            <li key={row.id} className="flex gap-3 px-5 py-3">
              <SeriesPoster src={row.poster} title={row.itemTitle} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0 font-semibold text-strong">
                    <span className="break-words">{row.itemTitle}</span>
                    {row.episodes && (
                      <span className="ml-1.5 text-sm font-normal text-gray-400">
                        {row.episodes}
                      </span>
                    )}
                  </div>
                  <span
                    className={`flex-none rounded-full px-2 py-0.5 text-xs font-medium ${
                      TONE[row.status]
                    }`}
                  >
                    {row.status === 'failed'
                      ? intl.formatMessage(messages.failedBadge)
                      : outcomeText(intl, row)}
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-gray-200">
                  {findingText(intl, row)}
                </div>
                <div className="mt-0.5 break-all text-xs text-gray-500">
                  {row.title}
                </div>
                <div className="mt-0.5 text-xs text-gray-500">
                  {row.server ?? appName(row.app)}
                  {' · '}
                  <FormattedRelativeTime
                    value={Math.round(
                      (new Date(row.createdAt).getTime() - Date.now()) / 1000
                    )}
                    updateIntervalInSeconds={60}
                    numeric="auto"
                  />
                </div>
                {row.status === 'failed' && row.error && (
                  <div className="mt-1 text-xs text-red-300 light:text-danger-text">
                    {outcomeText(intl, row)}
                  </div>
                )}
                {row.detail && (
                  <details className="mt-1 text-xs text-gray-400">
                    <summary className="cursor-pointer select-none hover:text-gray-200">
                      {intl.formatMessage(messages.showWords, {
                        app: appName(row.app),
                      })}
                    </summary>
                    <p className="mt-1 whitespace-pre-line break-words">
                      {row.detail}
                    </p>
                  </details>
                )}
                {problem?.id === row.id && (
                  <div className="mt-1 text-xs text-red-300 light:text-danger-text">
                    {problem.text}
                  </div>
                )}
                {choices.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {choices.map((choice, i) => (
                      <Button
                        key={choice}
                        buttonSize="sm"
                        buttonType={
                          i === 0 && choice !== 'dismiss'
                            ? choice === 'reject'
                              ? 'danger'
                              : 'primary'
                            : 'default'
                        }
                        disabled={busy !== undefined}
                        onClick={() => void choose(row, choice)}
                      >
                        {intl.formatMessage(
                          row.status === 'failed' && i === 0
                            ? messages.tryAgain
                            : messages[LABEL[choice]]
                        )}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default DownloadCheckPanel;
