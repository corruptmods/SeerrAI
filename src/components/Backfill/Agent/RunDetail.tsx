import ProposalCard from '@app/components/Backfill/Agent/ProposalCard';
import { changeMessages } from '@app/components/Backfill/Agent/changeMessages';
import {
  RunMeta,
  RunStatusBadge,
  messages,
} from '@app/components/Backfill/Agent/parts';
import { runRefreshMs } from '@app/components/Backfill/Agent/refresh';
import { toolMessages } from '@app/components/Backfill/Agent/toolMessages';
import type { ChangeIcon } from '@app/components/Backfill/Agent/work';
import {
  changeIcon,
  changeWords,
  matchActions,
  toolWords,
} from '@app/components/Backfill/Agent/work';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  AdjustmentsHorizontalIcon,
  ArrowDownIcon,
  ArrowDownTrayIcon,
  ArrowPathRoundedSquareIcon,
  CheckBadgeIcon,
  ExclamationTriangleIcon,
  HandRaisedIcon,
  LinkIcon,
  LockOpenIcon,
  NoSymbolIcon,
  PaperAirplaneIcon,
  PlusCircleIcon,
  QuestionMarkCircleIcon,
  SparklesIcon,
  StopCircleIcon,
  TrashIcon,
  WrenchScrewdriverIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import type { AgentAction, AgentStep } from '@server/entity/AgentRun';
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
  openPage: 'Open its page',
  worked: 'Worked: {count, plural, one {# step} other {# steps}} · {tools}',
  showResult: 'What it saw',
  tokens: '{input} tokens read, {output} written',
  untitled: 'Admin agent',
  started: 'Backfill came up empty for {title}, so it looked further.',
  question: 'It needs your answer',
  replyPlaceholder: 'Correct it or ask for more…',
  workingPlaceholder: 'Correct it while it works…',
  waitingToRead: 'It reads this before its next step.',
  stop: 'Stop',
  stopping: 'Stopping…',
  stopFailed: 'It could not be stopped.',
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
  | {
      type: 'admin';
      at: string;
      text: string;
      who?: string;
      /** Backfill telling it a download it started failed. */
      backfill?: boolean;
    }
  | {
      type: 'agent';
      at: string;
      text: string;
      question?: boolean;
      proposal?: boolean;
    }
  | { type: 'work'; at: string; steps: AgentStep[] }
  | { type: 'action'; at: string; text: string; action?: AgentAction };

/** The steps as a conversation: who said what, and the work in between. */
const conversationOf = (run: AgentRunDetail): Entry[] => {
  const entries: Entry[] = [];
  const actionFor = matchActions(run.actions);
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
      case 'followUp':
        entries.push({
          type: 'admin',
          at: step.at,
          text: step.text,
          backfill: true,
        });
        break;
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
        entries.push({
          type: 'action',
          at: step.at,
          text: step.text,
          action: actionFor(step.text),
        });
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

/** An icon for each kind of change: a delete is a bin, not a download. */
const CHANGE_ICONS: Record<ChangeIcon, typeof TrashIcon> = {
  download: ArrowDownTrayIcon,
  request: PlusCircleIcon,
  stop: StopCircleIcon,
  link: LinkIcon,
  delete: TrashIcon,
  block: NoSymbolIcon,
  unblock: LockOpenIcon,
  failed: XCircleIcon,
  profile: AdjustmentsHorizontalIcon,
  replace: ArrowPathRoundedSquareIcon,
  done: CheckBadgeIcon,
};

/** The colour a change is shown in: stopping is neutral, deleting red. */
const changeColour = (icon: ChangeIcon): string =>
  icon === 'stop'
    ? 'text-gray-300'
    : icon === 'delete'
      ? 'text-red-200 light:text-danger-text'
      : 'text-green-200 light:text-success-text';

const WorkStep = ({ step }: { step: AgentStep }) => {
  const intl = useIntl();
  if (step.kind === 'tool') {
    const words = intl.formatMessage(toolMessages[toolWords(step.tool)]);
    // What it did in words; the call itself, for an admin who wants it,
    // small underneath.
    return (
      <div className="flex gap-2">
        <WrenchScrewdriverIcon className="mt-0.5 h-4 w-4 flex-none text-gray-500" />
        <div className="min-w-0">
          <p className="text-xs leading-5 text-gray-300">
            {words.charAt(0).toLocaleUpperCase(intl.locale) + words.slice(1)}
          </p>
          <code className="block break-all text-[11px] leading-4 text-gray-500">
            {step.text}
          </code>
        </div>
      </div>
    );
  }
  if (step.kind === 'error') {
    return (
      <div className="flex gap-2 pl-6">
        <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-none text-yellow-400 light:text-warning-text" />
        <p className="whitespace-pre-wrap text-xs leading-5 text-yellow-200 light:text-warning-text">
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
          <span className="flex-none text-indigo-300 group-open/result:hidden light:text-accent-text">
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
        <div
          className={`max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-strong shadow ${
            entry.backfill ? 'bg-gray-600' : 'bg-indigo-600'
          }`}
        >
          <div
            className={`mb-0.5 flex items-center justify-between gap-3 text-[11px] ${
              entry.backfill ? 'text-gray-300' : 'text-indigo-200'
            }`}
          >
            <span>
              {entry.backfill
                ? intl.formatMessage(runMessages.backfill)
                : (entry.who ?? intl.formatMessage(runMessages.you))}
            </span>
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
                <HandRaisedIcon className="h-3.5 w-3.5 text-yellow-300 light:text-warning-text" />
              ) : entry.question ? (
                <QuestionMarkCircleIcon className="h-3.5 w-3.5 text-yellow-300 light:text-warning-text" />
              ) : (
                <SparklesIcon className="h-3.5 w-3.5 text-indigo-300 light:text-accent-text" />
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
    // Where it happened, in a few words: the whole of it is under What it
    // changed, at the top. One recorded before changes were kept by kind
    // keeps its own words.
    const icon = entry.action ? changeIcon(entry.action) : 'done';
    const Icon = CHANGE_ICONS[icon];
    return (
      <div
        className={`flex items-start gap-2 px-1 text-sm font-medium ${changeColour(icon)}`}
      >
        <Icon className="mt-0.5 h-4 w-4 flex-none" />
        <span className="min-w-0 break-words">
          {entry.action
            ? intl.formatMessage(changeMessages[changeWords(entry.action)])
            : entry.text}
        </span>
      </div>
    );
  }
  const tools = intl.formatList(
    [
      ...new Set(
        entry.steps.filter((s) => s.kind === 'tool').map((s) => s.tool ?? '')
      ),
    ]
      .filter(Boolean)
      .map((tool) => intl.formatMessage(toolMessages[toolWords(tool)])),
    { type: 'conjunction' }
  );
  const calls = entry.steps.filter((s) => s.kind === 'tool').length;
  return (
    <details className="rounded-lg bg-gray-800/60 px-3 py-1.5 ring-1 ring-gray-700">
      <summary className="flex cursor-pointer list-none items-start gap-2 text-xs leading-5 text-gray-400 marker:hidden">
        <WrenchScrewdriverIcon className="mt-0.5 h-4 w-4 flex-none" />
        <span className="min-w-0 flex-1">
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
  // The reply box starts one line high and grows with what's typed, up to
  // its max height, then scrolls.
  const replyBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = replyBox.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }, [text]);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string>();
  // Said while it works, until it reads it (a reply step shows up).
  const [pending, setPending] = useState<string[]>([]);
  const [stopping, setStopping] = useState(false);
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
        latest ? runRefreshMs([latest.status], { working: 2000, idle: 0 }) : 0,
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
  // Once it is no longer working, Stop and anything said to it are done with.
  useEffect(() => {
    if (status !== 'running' && status !== 'queued') {
      setStopping(false);
      setPending([]);
    }
  }, [status]);
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
  const read = new Set(
    data.steps
      .filter((step) => step.kind === 'reply')
      .map((step) => step.text.slice(step.text.indexOf(': ') + 2))
  );
  const unread = working ? pending.filter((note) => !read.has(note)) : [];

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending || stopping) return;
    setSending(true);
    setFailed(undefined);
    const said = text.trim();
    try {
      await axios.post(`/api/v1/agent/${data.id}/reply`, { text: said });
      if (working) setPending((before) => [...before, said]);
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

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setFailed(undefined);
    try {
      await axios.post(`/api/v1/agent/${data.id}/stop`);
      setPending([]);
    } catch (err) {
      setStopping(false);
      setFailed(
        axios.isAxiosError(err) && err.response?.data?.message
          ? String(err.response.data.message)
          : intl.formatMessage(runMessages.stopFailed)
      );
    }
    await mutate();
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
          <h1 className="flex items-start gap-2 text-2xl font-bold text-strong sm:text-3xl">
            <SparklesIcon className="mt-1 h-6 w-6 flex-none text-indigo-300 light:text-accent-text sm:h-7 sm:w-7" />
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
          {data.titlePage && (
            <Link href={data.titlePage} passHref legacyBehavior>
              <Button
                as="a"
                buttonType="default"
                className="flex-1 sm:flex-none"
              >
                {intl.formatMessage(runMessages.openPage)}
              </Button>
            </Link>
          )}
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
          {working && (
            <Button
              buttonType="danger"
              onClick={() => void stop()}
              disabled={stopping}
              className="flex-1 sm:flex-none"
            >
              <StopCircleIcon />
              <span>
                {intl.formatMessage(
                  stopping ? runMessages.stopping : runMessages.stop
                )}
              </span>
            </Button>
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
          <ul className="mt-2 max-h-60 space-y-3 overflow-y-auto overscroll-contain pr-1 sm:max-h-40">
            {data.actions.map((action, i) => {
              const icon = changeIcon(action);
              const Icon = CHANGE_ICONS[icon];
              return (
                <li
                  key={`${action.at}-${i}`}
                  className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-3"
                >
                  <span
                    className={`flex min-w-0 flex-1 items-start gap-2 text-sm ${changeColour(icon)}`}
                  >
                    <Icon className="mt-0.5 h-4 w-4 flex-none" />
                    <span className="min-w-0 break-words">{action.detail}</span>
                  </span>
                  {action.jobId && action.type === 'grab' && (
                    <Link
                      href={`/backfill/jobs/${action.jobId}`}
                      passHref
                      legacyBehavior
                    >
                      <Button
                        as="a"
                        buttonType="primary"
                        buttonSize="sm"
                        className="ml-6 flex-none sm:ml-0"
                      >
                        {intl.formatMessage(runMessages.openDownload)}
                      </Button>
                    </Link>
                  )}
                </li>
              );
            })}
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
            {unread.map((note, i) => (
              <div key={`pending-${i}`} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-accent/70 px-4 py-2 text-sm text-on-accent">
                  <p className="whitespace-pre-wrap break-words">{note}</p>
                  <p className="mt-1 text-[11px] opacity-80">
                    {intl.formatMessage(runMessages.waitingToRead)}
                  </p>
                </div>
              </div>
            ))}
            {working && (
              <div className="flex items-center gap-2 text-sm text-indigo-200 light:text-accent-text">
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
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-on-accent shadow-lg ring-1 ring-indigo-400 hover:bg-accent-hover"
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
              ref={replyBox}
              rows={1}
              value={text}
              maxLength={1000}
              disabled={sending || stopping}
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
                    : working
                      ? runMessages.workingPlaceholder
                      : runMessages.replyPlaceholder
              )}
              className="block max-h-40 min-h-[44px] min-w-0 flex-1 resize-none rounded-md border border-field-border bg-field px-3 py-[11px] text-sm leading-5 text-strong placeholder:truncate placeholder:text-gray-400 disabled:opacity-60"
            />
            {/* Just the arrow on a phone, leaving the box the room. */}
            <Button
              buttonType="primary"
              type="submit"
              disabled={sending || stopping || !text.trim()}
              className="h-11 flex-none"
              aria-label={intl.formatMessage(
                sending ? runMessages.sending : runMessages.send
              )}
            >
              <PaperAirplaneIcon />
              <span className="hidden sm:inline">
                {intl.formatMessage(
                  sending ? runMessages.sending : runMessages.send
                )}
              </span>
            </Button>
          </div>
          {failed && (
            <p className="text-sm text-red-300 light:text-danger-text">
              {failed}
            </p>
          )}
        </form>
      </section>
      <p className="mt-2 px-1 text-right text-[11px] text-gray-500">
        {intl.formatMessage(runMessages.tokens, {
          input: intl.formatNumber(data.inputTokens),
          output: intl.formatNumber(data.outputTokens),
        })}
      </p>
    </>
  );
};

export default RunDetail;
