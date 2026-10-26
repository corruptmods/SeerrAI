import { runRefreshMs } from '@app/components/Backfill/Agent/refresh';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import useMediaQuery from '@app/hooks/useMediaQuery';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  PaperAirplaneIcon,
  QuestionMarkCircleIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import type {
  AgentOverview,
  AgentRunSummary,
} from '@server/interfaces/api/agentInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

export const messages = defineMessages('components.Backfill.Agent', {
  agent: 'Admin agent',
  description:
    'An AI that digs deeper: it tries other searches, checks pack contents and downloads only what’s missing.',
  placeholder: 'Ask it to find something: “Get the missing Wendle episodes”',
  placeholderShort: 'Ask it to find something',
  ask: 'Ask',
  asking: 'Starting…',
  askFailed: 'The agent could not start.',
  autoOn:
    'It also steps in when Backfill finds nothing for a requested or reported title.',
  autoOff: 'It only works when asked; running on its own is off in Settings.',
  settings: 'Settings',
  allRuns: 'All runs',
  noRuns: 'Nothing yet. Ask it something to get started.',
  held: 'Waiting on the search',
  heldNote: 'It starts if Sonarr, Radarr and Backfill find nothing.',
  reportedBy: 'Reported by {name}',
  queued: 'Waiting',
  running: 'Working',
  waiting: 'Needs your answer',
  done: 'Done',
  failed: 'Failed',
  askedBy: 'Asked by {name}',
  onItsOwn: 'On its own',
  downloads:
    '{count, plural, one {# download started} other {# downloads started}}',
  requests:
    '{count, plural, one {# title requested} other {# titles requested}}',
  steps: '{count, plural, one {# step} other {# steps}}',
  working: 'Working on it…',
  forTitle: 'Ask the admin agent',
  autoRan:
    'It looked for this on its own on {date}, which it does once per title. Now it looks only when asked.',
  forTitleTip:
    'It looks further than Sonarr and Radarr. Left empty, it gets whatever is missing.',
  forAlbumTip:
    'It looks further than Lidarr. Left empty, it gets whatever is missing.',
  titlePlaceholder: 'What to do (optional)',
  earlier: 'Earlier conversations',
  allConversations: 'All conversations',
});

export const RunStatusBadge = ({
  status,
}: {
  status: AgentRunSummary['status'];
}) => {
  const intl = useIntl();
  const map = {
    held: ['default', messages.held],
    queued: ['default', messages.queued],
    running: ['primary', messages.running],
    waiting: ['warning', messages.waiting],
    done: ['success', messages.done],
    failed: ['danger', messages.failed],
  } as const;
  const [type, text] = map[status];
  return <Badge badgeType={type}>{intl.formatMessage(text)}</Badge>;
};

export const RunStatusIcon = ({
  status,
}: {
  status: AgentRunSummary['status'];
}) => {
  if (status === 'running') {
    return (
      <SparklesIcon className="h-5 w-5 flex-none animate-pulse text-indigo-300 light:text-accent-text" />
    );
  }
  if (status === 'waiting') {
    return (
      <QuestionMarkCircleIcon className="h-5 w-5 flex-none text-yellow-300 light:text-warning-text" />
    );
  }
  if (status === 'queued' || status === 'held') {
    return <ClockIcon className="h-5 w-5 flex-none text-gray-400" />;
  }
  if (status === 'failed') {
    return (
      <ExclamationCircleIcon className="h-5 w-5 flex-none text-red-400 light:text-danger-text" />
    );
  }
  return <CheckCircleIcon className="h-5 w-5 flex-none text-success-text" />;
};

export const Ago = ({ at }: { at: string }) => (
  <FormattedRelativeTime
    value={Math.round((new Date(at).getTime() - Date.now()) / 1000)}
    updateIntervalInSeconds={60}
    numeric="auto"
  />
);

/** "Asked by Sam · 5 minutes ago · 1 download started". */
export const RunMeta = ({ run }: { run: AgentRunSummary }) => {
  const intl = useIntl();
  const grabs = run.actions.filter((a) => a.type === 'grab').length;
  const requests = run.actions.filter((a) => a.type === 'request').length;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>
        {run.trigger === 'ask'
          ? intl.formatMessage(messages.askedBy, {
              name: run.requestedByName ?? '?',
            })
          : run.trigger === 'report'
            ? intl.formatMessage(messages.reportedBy, {
                name: run.requestedByName ?? '?',
              })
            : intl.formatMessage(messages.onItsOwn)}
      </span>
      <span aria-hidden>·</span>
      <Ago at={run.createdAt} />
      {grabs > 0 && (
        <>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1 text-green-300 light:text-success-text">
            <ArrowDownTrayIcon className="h-3.5 w-3.5" />
            {intl.formatMessage(messages.downloads, { count: grabs })}
          </span>
        </>
      )}
      {requests > 0 && (
        <>
          <span aria-hidden>·</span>
          <span className="text-indigo-300 light:text-accent-text">
            {intl.formatMessage(messages.requests, { count: requests })}
          </span>
        </>
      )}
    </span>
  );
};

/** One run in a list; on a title's page, by what was asked instead. */
export const RunRow = ({
  run,
  byAsk = false,
}: {
  run: AgentRunSummary;
  byAsk?: boolean;
}) => {
  const intl = useIntl();
  const heading =
    byAsk && run.ask
      ? `“${run.ask}”`
      : (run.title ?? (run.ask ? `“${run.ask}”` : '—'));
  return (
    <li>
      <Link
        href={`/backfill/agent/${run.id}`}
        className="flex gap-3 px-5 py-3 transition hover:bg-gray-700/40 focus:outline-none focus-visible:bg-gray-700/40"
      >
        <span className="pt-0.5">
          <RunStatusIcon status={run.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span className="truncate font-semibold text-strong">
              {heading}
            </span>
            <span className="flex-none">
              <RunStatusBadge status={run.status} />
            </span>
          </span>
          {!byAsk && run.title && run.ask && (
            <span className="block truncate text-sm text-gray-400">
              “{run.ask}”
            </span>
          )}
          <span className="mt-0.5 block text-xs text-gray-500">
            <RunMeta run={run} />
          </span>
          {run.status === 'waiting' && run.question ? (
            <span className="mt-1 line-clamp-2 text-sm text-yellow-200 light:text-warning-text">
              {run.question}
            </span>
          ) : (
            (run.summary || run.error) && (
              <span
                className={`mt-1 line-clamp-2 text-sm ${
                  run.error ? 'text-red-300' : 'text-gray-300'
                }`}
              >
                {run.error ?? run.summary}
              </span>
            )
          )}
          {run.status === 'held' && (
            <span className="mt-1 block text-sm text-gray-400">
              {intl.formatMessage(messages.heldNote)}
            </span>
          )}
          {!run.summary && !run.error && run.status === 'running' && (
            <span className="mt-1 block text-sm text-indigo-200 light:text-accent-text">
              {intl.formatMessage(messages.working)}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
};

/** What the agent is doing, refreshed often while it works. */
export const useAgent = (page = 0) =>
  useSWR<AgentOverview>(`/api/v1/agent${page ? `?page=${page}` : ''}`, {
    refreshInterval: (latest) =>
      runRefreshMs(latest?.runs.map((r) => r.status) ?? [], {
        working: 3000,
        idle: 30000,
      }),
  });

export interface AgentTitle {
  kind: 'series' | 'movie' | 'album';
  serverId: number;
  arrId: number;
}

/**
 * The box an admin asks the agent in; the new run opens to watch. From a
 * title's page it is about that title, and may be sent empty.
 */
export const AskAgent = ({
  problem,
  title,
}: {
  problem: string | null;
  title?: AgentTitle;
}) => {
  const intl = useIntl();
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const ready = !!title || text.trim().length >= 3;
  // The example does not fit on a phone.
  const wide = useMediaQuery('(min-width: 640px)');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFailed(undefined);
    try {
      const { data } = await axios.post<AgentRunSummary>('/api/v1/agent/ask', {
        text: text.trim(),
        ...(title ? { title } : {}),
      });
      await router.push(`/backfill/agent/${data.id}`);
    } catch (err) {
      setFailed(
        axios.isAxiosError(err) && err.response?.data?.message
          ? String(err.response.data.message)
          : intl.formatMessage(messages.askFailed)
      );
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <label htmlFor="agent-ask" className="sr-only">
          {intl.formatMessage(messages.ask)}
        </label>
        <input
          id="agent-ask"
          type="text"
          value={text}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
          placeholder={intl.formatMessage(
            title
              ? messages.titlePlaceholder
              : wide
                ? messages.placeholder
                : messages.placeholderShort
          )}
          disabled={!!problem || busy}
          className="min-w-0 flex-1 rounded-md border border-field-border bg-field px-3 py-2 text-sm text-strong placeholder:text-gray-400 disabled:opacity-60"
        />
        <Button
          buttonType="primary"
          type="submit"
          disabled={!!problem || busy || !ready}
          className="flex-none"
        >
          <PaperAirplaneIcon />
          <span>
            {intl.formatMessage(busy ? messages.asking : messages.ask)}
          </span>
        </Button>
      </div>
      {(problem || failed) && (
        <p className="text-sm text-yellow-300 light:text-warning-text">
          {problem ?? failed}
        </p>
      )}
    </form>
  );
};

/** On the Backfill page: ask, and the latest few runs. */
export const AgentPanel = () => {
  const intl = useIntl();
  const { data } = useAgent();
  if (!data) return null;
  return (
    <section className="rounded-lg bg-gray-800 ring-1 ring-gray-700">
      <div className="flex flex-col gap-1 border-b border-gray-700 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-strong">
          <SparklesIcon className="h-5 w-5 text-indigo-300 light:text-accent-text" />
          {intl.formatMessage(messages.agent)}
        </h3>
        <Link
          href="/backfill/agent"
          className="text-sm font-medium text-indigo-300 hover:text-indigo-200 light:text-accent-text light:hover:text-accent-text"
        >
          {intl.formatMessage(messages.allRuns)} ({data.total})
        </Link>
      </div>
      <div className="space-y-2 px-5 py-4">
        <AskAgent problem={data.problem} />
        <p className="text-xs text-gray-500">
          {intl.formatMessage(
            data.autoRun ? messages.autoOn : messages.autoOff
          )}{' '}
          <Link
            href="/settings/backfill"
            className="underline hover:text-gray-300"
          >
            {intl.formatMessage(messages.settings)}
          </Link>
        </p>
      </div>
      <ul className="divide-y divide-gray-700 border-t border-gray-700">
        {!data.runs.length && (
          <li className="px-5 py-4 text-sm text-gray-400">
            {intl.formatMessage(messages.noRuns)}
          </li>
        )}
        {data.runs.slice(0, 3).map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </ul>
    </section>
  );
};

/**
 * On a title's page, for admins: ask the agent about this title, and its
 * earlier conversations about it.
 */
export const AgentForTitle = ({
  title,
  card,
  autoRanAt,
}: {
  title: AgentTitle;
  /** Framed as a card, among a Backfill page's sections. */
  card?: boolean;
  /** When it looked on its own: it does that once per title. */
  autoRanAt?: string | null;
}) => {
  const intl = useIntl();
  const { data } = useSWR<AgentOverview>(
    `/api/v1/agent?kind=${title.kind}&serverId=${title.serverId}&arrId=${title.arrId}`
  );
  // Nothing at all on the page when the agent cannot run.
  if (!data || data.problem) return null;
  return (
    <div
      className={
        card
          ? 'mt-4 rounded-lg bg-gray-800 p-5 ring-1 ring-gray-700'
          : undefined
      }
    >
      <h3 className="mb-2 flex items-center gap-2 text-xl font-bold text-strong">
        <SparklesIcon className="h-5 w-5 text-indigo-300 light:text-accent-text" />
        {intl.formatMessage(messages.forTitle)}
      </h3>
      <div className="space-y-3">
        <p className="text-sm text-gray-400">
          {intl.formatMessage(
            title.kind === 'album' ? messages.forAlbumTip : messages.forTitleTip
          )}
        </p>
        {autoRanAt && (
          <p className="text-sm text-yellow-200/90 light:text-warning-text">
            {intl.formatMessage(messages.autoRan, {
              date: intl.formatDate(autoRanAt, { dateStyle: 'medium' }),
            })}
          </p>
        )}
        <AskAgent problem={null} title={title} />
        {data.runs.length > 0 && (
          <div className="overflow-hidden rounded-md border border-gray-700">
            <div className="flex items-center justify-between border-b border-gray-700 bg-gray-800 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
              <span>{intl.formatMessage(messages.earlier)}</span>
              <Link
                href="/backfill/agent"
                className="font-medium normal-case tracking-normal text-indigo-300 hover:text-indigo-200 light:text-accent-text light:hover:text-accent-text"
              >
                {intl.formatMessage(messages.allConversations)}
              </Link>
            </div>
            <ul className="divide-y divide-gray-700">
              {data.runs.slice(0, 3).map((run) => (
                <RunRow key={run.id} run={run} byAsk />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};
