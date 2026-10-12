import ProposalCard from '@app/components/Backfill/Agent/ProposalCard';
import {
  RunMeta,
  RunStatusBadge,
  messages,
} from '@app/components/Backfill/Agent/parts';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownIcon,
  ArrowDownTrayIcon,
  CheckBadgeIcon,
  ExclamationTriangleIcon,
  HandRaisedIcon,
  LinkIcon,
  NoSymbolIcon,
  PaperAirplaneIcon,
  PlusCircleIcon,
  QuestionMarkCircleIcon,
  SparklesIcon,
  TrashIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import type { AgentStep } from '@server/entity/AgentRun';
import type { AgentRunDetail } from '@server/interfaces/api/agentInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { FormattedTime, useIntl } from 'react-intl';
import useSWR from 'swr';

/** How close to the bottom still counts as following the conversation. */
const NEAR_BOTTOM_PX = 80;

const runMessages = defineMessages('components.Backfill.Agent.Run', {
  backfill: 'Backfill',
  run: 'Conversation #{id}',
  changes: 'What it changed',
  openDownload: 'Open download',
  openTitle: 'Open in Backfill',
  worked: 'Worked: {count, plural, one {# step} other {# steps}} · {tools}',
  showResult: 'What it saw',
  tokens: '{input} tokens read, {output} written',
  untitled: 'Admin agent',
  started: 'Backfill came up empty for {title}, so it looked further.',
  question: 'It needs your answer',
  replyPlaceholder: 'Correct it or ask for more: “check it is English first”',
  answerPlaceholder: 'Answer its question…',
  send: 'Send',
  sending: 'Sending…',
  sendFailed: 'That could not be sent.',
  you: 'You',
  delete: 'Delete',
  newMessages: 'New messages',
  confirmDelete: 'Delete it?',
  deleteFailed: 'It could not be deleted.',
  agent: 'Agent',
  proposed: 'It needs your approval',
  decideFailed: 'That could not be done.',
  proposalPlaceholder: 'Or tell it something else instead…',
});

type Entry =
  | { type: 'admin'; at: string; text: string; who?: string }
  | {
      type: 'agent';
      at: string;
      text: string;
      question?: boolean;
      proposal?: boolean;
    }
  | { type: 'work'; at: string; steps: AgentStep[] }
  | { type: 'action'; at: string; text: string };

/** The steps as a conversation: who said what, and the work in between. */
const conversationOf = (run: AgentRunDetail): Entry[] => {
  const entries: Entry[] = [];
  if (run.ask) {
    entries.push({
      type: 'admin',
      at: run.createdAt,
      text: run.ask,
      who: run.requestedByName ?? undefined,
    });
  }
  for (const step of run.steps) {
    const last = entries[entries.length - 1];
    switch (step.kind) {
      case 'reply': {
        const split = step.text.indexOf(': ');
        entries.push({
          type: 'admin',
          at: step.at,
          who: split > 0 ? step.text.slice(0, split) : undefined,
          text: split > 0 ? step.text.slice(split + 2) : step.text,
        });
        break;
      }
      case 'say':
        entries.push({ type: 'agent', at: step.at, text: step.text });
        break;
      case 'ask':
        entries.push({
          type: 'agent',
          at: step.at,
          text: step.text,
          question: true,
        });
        break;
      case 'propose':
        entries.push({
          type: 'agent',
          at: step.at,
          text: step.text,
          proposal: true,
        });
        break;
      case 'action':
        entries.push({ type: 'action', at: step.at, text: step.text });
        break;
      default:
        if (last?.type === 'work') {
          last.steps.push(step);
        } else {
          entries.push({ type: 'work', at: step.at, steps: [step] });
        }
    }
  }
  return entries;
};

const WorkStep = ({ step }: { step: AgentStep }) => {
  const intl = useIntl();
  if (step.kind === 'tool') {
    return (
      <div className="flex gap-2">
        <WrenchScrewdriverIcon className="mt-0.5 h-4 w-4 flex-none text-gray-500" />
        <code className="min-w-0 break-all text-xs leading-5 text-gray-400">
          {step.text}
        </code>
      </div>
    );
  }
  if (step.kind === 'error') {
    return (
      <div className="flex gap-2 pl-6">
        <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-none text-yellow-400" />
        <p className="whitespace-pre-wrap text-xs leading-5 text-yellow-200">
          {step.text}
        </p>
      </div>
    );
  }
  const first = step.text.split('\n')[0];
  const more = step.text.includes('\n');
  return (
    <details className="group/result ml-6 rounded-md bg-gray-900/60 ring-1 ring-gray-700">
      <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-1.5 text-xs text-gray-300 marker:hidden">
        <span className="min-w-0 flex-1 truncate">{first}</span>
        {more && (
          <span className="flex-none text-indigo-300 group-open/result:hidden">
            {intl.formatMessage(runMessages.showResult)}
          </span>
        )}
      </summary>
      {more && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-gray-700 px-3 py-2 font-mono text-[11px] leading-5 text-gray-300">
          {step.text}
        </pre>
      )}
    </details>
  );
};

const Time = ({ at }: { at: string }) => (
  <span className="flex-none text-[11px] tabular-nums opacity-80">
    <FormattedTime value={at} />
  </span>
);

const EntryView = ({ entry }: { entry: Entry }) => {
  const intl = useIntl();
  if (entry.type === 'admin') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-white shadow">
          <div className="mb-0.5 flex items-center justify-between gap-3 text-[11px] text-indigo-200">
            <span>{entry.who ?? intl.formatMessage(runMessages.you)}</span>
            <Time at={entry.at} />
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">
            {entry.text}
          </p>
        </div>
      </div>
    );
  }
  if (entry.type === 'agent') {
    return (
      <div className="flex justify-start">
        <div
          className={`max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2.5 shadow ring-1 ${
            entry.question || entry.proposal
              ? 'bg-yellow-500/10 ring-yellow-500/60'
              : 'bg-gray-700 ring-gray-600'
          }`}
        >
          <div className="mb-0.5 flex items-center justify-between gap-3 text-[11px] text-gray-400">
            <span className="flex items-center gap-1">
              {entry.proposal ? (
                <HandRaisedIcon className="h-3.5 w-3.5 text-yellow-300" />
              ) : entry.question ? (
                <QuestionMarkCircleIcon className="h-3.5 w-3.5 text-yellow-300" />
              ) : (
                <SparklesIcon className="h-3.5 w-3.5 text-indigo-300" />
              )}
              {intl.formatMessage(
                entry.proposal
                  ? runMessages.proposed
                  : entry.question
                    ? runMessages.question
                    : runMessages.agent
              )}
            </span>
            <Time at={entry.at} />
          </div>
          <p className="whitespace-pre-wrap break-words text-sm text-gray-100">
            {entry.text}
          </p>
        </div>
      </div>
    );
  }
  if (entry.type === 'action') {
    return (
      <div className="flex items-start gap-2 px-1 text-sm font-medium text-green-200">
        <ArrowDownTrayIcon className="mt-0.5 h-4 w-4 flex-none text-green-400" />
        <span className="min-w-0 break-words">{entry.text}</span>
      </div>
    );
  }
  const tools = [
    ...new Set(
      entry.steps.filter((s) => s.kind === 'tool').map((s) => s.tool ?? '')
    ),
  ]
    .filter(Boolean)
    .join(', ');
  const calls = entry.steps.filter((s) => s.kind === 'tool').length;
  return (
    <details className="rounded-lg bg-gray-800/60 px-3 py-1.5 ring-1 ring-gray-700">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-gray-400 marker:hidden">
        <WrenchScrewdriverIcon className="h-4 w-4 flex-none" />
        <span className="min-w-0 flex-1 truncate">
          {intl.formatMessage(runMessages.worked, { count: calls, tools })}
        </span>
      </summary>
      <div className="mt-2 space-y-1.5">
        {entry.steps.map((step, i) => (
          <WorkStep key={`${step.at}-${i}`} step={step} />
        ))}
      </div>
    </details>
  );
};

/** A conversation with the admin agent: what it was told, did and said. */
const RunDetail = () => {
  const intl = useIntl();
  const router = useRouter();
  const id = Number(router.query.runId);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string>();
  // The conversation scrolls inside its own box. It follows the newest
  // message while the admin is at the bottom, and stays put once they
  // scroll up to read, offering a way back down instead.
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const { data, error, mutate } = useSWR<AgentRunDetail>(
    Number.isInteger(id) && id > 0 ? `/api/v1/agent/${id}` : null,
    {
      refreshInterval: (latest) =>
        latest && (latest.status === 'running' || latest.status === 'queued')
          ? 2000
          : 0,
    }
  );
  const count = data?.steps.length ?? 0;
  const status = data?.status;
  const toBottom = () => {
    const box = log.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    pinned.current = true;
    setUnseen(false);
  };
  useEffect(() => {
    if (!count) return;
    if (pinned.current) {
      toBottom();
    } else {
      setUnseen(true);
    }
  }, [count, status]);
  const onScroll = () => {
    const box = log.current;
    if (!box) return;
    pinned.current =
      box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
    if (pinned.current) setUnseen(false);
  };

  if (error && !data) return <ErrorPage statusCode={404} />;
  if (!data) return <LoadingSpinner />;
  const working = data.status === 'running' || data.status === 'queued';
  const entries = conversationOf(data);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending || working) return;
    setSending(true);
    setFailed(undefined);
    try {
      await axios.post(`/api/v1/agent/${data.id}/reply`, {
        text: text.trim(),
      });
      setText('');
      pinned.current = true;
      await mutate();
    } catch (err) {
      setFailed(
        axios.isAxiosError(err) && err.response?.data?.message
          ? String(err.response.data.message)
          : intl.formatMessage(runMessages.sendFailed)
      );
    } finally {
      setSending(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (!data.proposal || sending) return;
    setSending(true);
    setFailed(undefined);
    try {
      await axios.post(
        `/api/v1/agent/${data.id}/${approve ? 'approve' : 'decline'}`,
        { proposal: data.proposal.id }
      );
      pinned.current = true;
    } catch (err) {
      setFailed(
        axios.isAxiosError(err) && err.response?.data?.message
          ? String(err.response.data.message)
          : intl.formatMessage(runMessages.decideFailed)
      );
    } finally {
      // Whatever happened, show where it stands now.
      await mutate();
      setSending(false);
    }
  };

  const remove = async () => {
    try {
      await axios.delete(`/api/v1/agent/${data.id}`);
      await router.push('/backfill/agent');
    } catch (err) {
      setFailed(
        axios.isAxiosError(err) && err.response?.data?.message
          ? String(err.response.data.message)
          : intl.formatMessage(runMessages.deleteFailed)
      );
    }
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(runMessages.run, { id: data.id }),
          intl.formatMessage(messages.agent),
        ]}
      />
      <div className="mt-6 text-sm text-gray-500">
        <Link href="/backfill" className="hover:text-gray-300">
          {intl.formatMessage(runMessages.backfill)}
        </Link>
        {' · '}
        <Link href="/backfill/agent" className="hover:text-gray-300">
          {intl.formatMessage(messages.agent)}
        </Link>
        {' · '}
        <span className="text-gray-300">#{data.id}</span>
      </div>
      <div className="mt-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h1 className="flex items-start gap-2 text-2xl font-bold text-white sm:text-3xl">
            <SparklesIcon className="mt-1 h-6 w-6 flex-none text-indigo-300 sm:h-7 sm:w-7" />
            <span className="min-w-0 break-words">
              {data.title ?? intl.formatMessage(runMessages.untitled)}
            </span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-400">
            <RunStatusBadge status={data.status} />
            <RunMeta run={{ ...data, steps: data.steps.length }} />
          </div>
        </div>
        <div className="flex flex-none gap-2">
          {data.backfillId && (
            <Link
              href={`/backfill/series/${data.backfillId}`}
              passHref
              legacyBehavior
            >
              <Button
                as="a"
                buttonType="default"
                className="flex-1 sm:flex-none"
              >
                {intl.formatMessage(runMessages.openTitle)}
              </Button>
            </Link>
          )}
          {!working && (
            <ConfirmButton
              onClick={remove}
              confirmText={intl.formatMessage(runMessages.confirmDelete)}
              className="flex-1 sm:flex-none"
            >
              <TrashIcon />
              <span>{intl.formatMessage(runMessages.delete)}</span>
            </ConfirmButton>
          )}
        </div>
      </div>

      {data.actions.length > 0 && (
        <section className="mt-6 rounded-lg bg-gray-800 px-5 py-4 ring-1 ring-gray-700">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            {intl.formatMessage(runMessages.changes)}
          </div>
          <ul className="mt-2 max-h-28 space-y-2 overflow-y-auto overscroll-contain pr-1">
            {data.actions.map((action, i) => (
              <li
                key={`${action.at}-${i}`}
                className="flex flex-col gap-2 sm:flex-row sm:items-center"
              >
                <span
                  className={`flex min-w-0 flex-1 items-start gap-2 text-sm ${
                    action.type === 'stop' ? 'text-gray-300' : 'text-green-200'
                  }`}
                >
                  {action.type === 'grab' ? (
                    <ArrowDownTrayIcon className="mt-0.5 h-4 w-4 flex-none" />
                  ) : action.type === 'change' ? (
                    <CheckBadgeIcon className="mt-0.5 h-4 w-4 flex-none" />
                  ) : action.type === 'stop' ? (
                    <NoSymbolIcon className="mt-0.5 h-4 w-4 flex-none" />
                  ) : action.type === 'relink' ? (
                    <LinkIcon className="mt-0.5 h-4 w-4 flex-none" />
                  ) : (
                    <PlusCircleIcon className="mt-0.5 h-4 w-4 flex-none" />
                  )}
                  <span className="min-w-0 break-words">{action.detail}</span>
                </span>
                {action.jobId && action.type === 'grab' && (
                  <Link
                    href={`/backfill/jobs/${action.jobId}`}
                    passHref
                    legacyBehavior
                  >
                    <Button as="a" buttonType="primary" buttonSize="sm">
                      {intl.formatMessage(runMessages.openDownload)}
                    </Button>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.proposal && (
        <ProposalCard
          proposal={data.proposal}
          busy={sending}
          onDecide={(approve) => void decide(approve)}
        />
      )}

      <section className="mt-4 rounded-lg bg-gray-800 ring-1 ring-gray-700">
        <div className="relative">
          <div
            ref={log}
            onScroll={onScroll}
            className="max-h-[max(18rem,40vh)] space-y-2 overflow-y-auto overscroll-contain p-3 sm:p-4"
          >
            {data.trigger === 'auto' && (
              <p className="text-center text-xs text-gray-500">
                {intl.formatMessage(runMessages.started, {
                  title: data.title ?? '—',
                })}
              </p>
            )}
            {entries.map((entry, i) => (
              <EntryView key={`${entry.at}-${i}`} entry={entry} />
            ))}
            {working && (
              <div className="flex items-center gap-2 text-sm text-indigo-200">
                <SparklesIcon className="h-4 w-4 animate-pulse" />
                {intl.formatMessage(messages.working)}
              </div>
            )}
            {data.error && <Alert type="error" title={data.error} />}
          </div>
          {unseen && (
            <button
              type="button"
              onClick={toBottom}
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg ring-1 ring-indigo-400 hover:bg-indigo-500"
            >
              <ArrowDownIcon className="h-3.5 w-3.5" />
              {intl.formatMessage(runMessages.newMessages)}
            </button>
          )}
        </div>
        <form
          onSubmit={send}
          className="flex flex-col gap-2 border-t border-gray-700 p-3 sm:p-4"
        >
          <div className="flex items-end gap-2">
            <label htmlFor="agent-reply" className="sr-only">
              {intl.formatMessage(runMessages.send)}
            </label>
            <textarea
              id="agent-reply"
              rows={2}
              value={text}
              maxLength={1000}
              disabled={working || sending}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(e);
                }
              }}
              placeholder={intl.formatMessage(
                data.proposal
                  ? runMessages.proposalPlaceholder
                  : data.status === 'waiting'
                    ? runMessages.answerPlaceholder
                    : runMessages.replyPlaceholder
              )}
              className="min-h-[44px] min-w-0 flex-1 resize-y rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-sm text-white placeholder:text-gray-400 disabled:opacity-60"
            />
            <Button
              buttonType="primary"
              type="submit"
              disabled={working || sending || !text.trim()}
              className="flex-none"
            >
              <PaperAirplaneIcon />
              <span>
                {intl.formatMessage(
                  sending ? runMessages.sending : runMessages.send
                )}
              </span>
            </Button>
          </div>
          {failed && <p className="text-sm text-red-300">{failed}</p>}
          <p className="text-right text-[11px] text-gray-500">
            {intl.formatMessage(runMessages.tokens, {
              input: intl.formatNumber(data.inputTokens),
              output: intl.formatNumber(data.outputTokens),
            })}
          </p>
        </form>
      </section>
    </>
  );
};

export default RunDetail;
