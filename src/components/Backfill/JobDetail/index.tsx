import {
  JobFollowUpNote,
  JobStatusBadge,
  ProgressBar,
  SeriesPoster,
  appName,
  episodeLabel,
  formatBytes,
  formatDuration,
  jobStage,
} from '@app/components/Backfill/shared';
import type { JobView } from '@app/components/Backfill/types';
import { ACTIVE_JOB } from '@app/components/Backfill/types';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  FilmIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { CheckIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { FormattedTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Backfill.JobDetail', {
  backfill: 'Backfill',
  job: 'Backfill #{id}',
  approvedBy: 'Approved by {name}',
  repeated: '{message} (tried {count} times, last at {time})',
  pause: 'Pause',
  mediaPage: 'Media page',
  resume: 'Resume',
  end: 'End backfill',
  endTitle: 'End this backfill?',
  endBody:
    'The download and its partial files are removed. Files already imported stay in your library.',
  stepApproved: 'Approved',
  stepDownloading: 'Downloading',
  stepImporting: 'Importing',
  stepCleanup: 'Cleaned up',
  stepDone: 'Checked in {app}',
  progress: 'Progress',
  overall: 'Overall',
  sizes: '{have} of {total}',
  speed: '{speed}/s',
  eta: '{time} left',
  files: 'Files',
  imported: 'Imported',
  replaced: 'Replaced',
  waiting: 'Waiting',
  failedCount: 'Not imported',
  state_waiting: 'Waiting',
  state_importing: 'Importing',
  state_imported: 'Imported',
  state_failed: 'Not imported',
  activity: 'Activity',
  failed: 'That did not work.',
});

const STATE_STYLE = {
  waiting: 'bg-gray-600/40 text-gray-300',
  importing: 'bg-indigo-500/20 text-indigo-200 light:text-accent-text',
  imported: 'bg-green-500/20 text-green-200 light:text-success-text',
  failed: 'bg-red-500/20 text-red-200 light:text-danger-text',
} as const;

const LOG_STYLE = {
  info: 'text-indigo-300 light:text-accent-text',
  ok: 'text-success-text',
  warn: 'text-yellow-400 light:text-warning-text',
  error: 'text-red-400 light:text-danger-text',
} as const;

const JobDetail = () => {
  const intl = useIntl();
  const router = useRouter();
  const id = Number(router.query.jobId);
  const [ending, setEnding] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { data, error, mutate } = useSWR<JobView>(
    Number.isInteger(id) && id > 0 ? `/api/v1/backfill/jobs/${id}` : null,
    {
      refreshInterval: (latest) =>
        latest && ACTIVE_JOB.includes(latest.status) ? 2000 : 0,
    }
  );

  if (error && !data) {
    return (
      <ErrorPage statusCode={error?.response?.status === 404 ? 404 : 500} />
    );
  }
  if (!data) return <LoadingSpinner />;

  const act = async (path: string) => {
    setProblem(undefined);
    try {
      await axios.post(`/api/v1/backfill/jobs/${data.id}/${path}`);
      await mutate();
    } catch (e) {
      setProblem(
        axios.isAxiosError(e) && e.response?.data?.message
          ? String(e.response.data.message)
          : intl.formatMessage(messages.failed)
      );
    }
  };

  const active = ACTIVE_JOB.includes(data.status);
  const files = data.files ?? [];
  const count = (state: string) =>
    files.filter((f) => f.state === state).length;
  const reached = {
    queued: 1,
    downloading: 2,
    paused: 2,
    importing: 3,
    done: 5,
    failed: 0,
    cancelled: 0,
  }[data.status];
  const steps = [
    messages.stepApproved,
    messages.stepDownloading,
    messages.stepImporting,
    messages.stepCleanup,
    messages.stepDone,
  ];

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.job, { id: data.id }),
          intl.formatMessage(messages.backfill),
        ]}
      />
      <div className="mt-6 text-sm text-gray-500">
        <Link href="/backfill" className="hover:text-gray-300">
          {intl.formatMessage(messages.backfill)}
        </Link>
        {data.series && (
          <>
            {' · '}
            <Link
              href={`/backfill/series/${data.series.id}`}
              className="hover:text-gray-300"
            >
              {data.series.title}
            </Link>
          </>
        )}
        {' · '}
        <span className="text-gray-300">#{data.id}</span>
      </div>
      <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-start">
        <SeriesPoster
          src={data.series?.poster}
          title={data.series?.title ?? data.title}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col justify-between gap-3 xl:flex-row">
            <div className="min-w-0">
              <h1 className="text-3xl font-bold text-strong">
                {data.series?.title}
              </h1>
              <div className="mt-1 break-all text-sm text-gray-400">
                {data.title}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-400">
                <JobStatusBadge
                  status={data.status}
                  progress={data.progress}
                  kind={data.series?.kind}
                />
                {data.stage && <span>{jobStage(intl, data)}</span>}
                {data.approvedByName && (
                  <span>
                    ·{' '}
                    {intl.formatMessage(messages.approvedBy, {
                      name: data.approvedByName,
                    })}
                  </span>
                )}
                {data.status === 'failed' && data.followUp && (
                  <span>
                    · <JobFollowUpNote job={data} />
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              {data.series?.tmdbId && (
                <Link
                  href={`/${data.series.kind === 'movie' ? 'movie' : 'tv'}/${
                    data.series.tmdbId
                  }`}
                  passHref
                  legacyBehavior
                >
                  <Button as="a" buttonType="default">
                    <FilmIcon />
                    <span>{intl.formatMessage(messages.mediaPage)}</span>
                  </Button>
                </Link>
              )}
              {active && data.status === 'downloading' && (
                <Button onClick={() => act('pause')}>
                  <PauseIcon />
                  <span>{intl.formatMessage(messages.pause)}</span>
                </Button>
              )}
              {active && data.status === 'paused' && (
                <Button onClick={() => act('resume')}>
                  <PlayIcon />
                  <span>{intl.formatMessage(messages.resume)}</span>
                </Button>
              )}
              {active && data.status !== 'importing' && (
                <Button buttonType="danger" onClick={() => setEnding(true)}>
                  <StopIcon />
                  <span>{intl.formatMessage(messages.end)}</span>
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Transition
        as="div"
        show={ending}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          title={intl.formatMessage(messages.endTitle)}
          onCancel={() => setEnding(false)}
          onOk={async () => {
            setEnding(false);
            await act('end');
          }}
          okText={intl.formatMessage(messages.end)}
          okButtonType="danger"
        >
          {intl.formatMessage(messages.endBody)}
        </Modal>
      </Transition>

      <div className="mt-4 space-y-2">
        {problem && <Alert type="error" title={problem} />}
        {data.error && <Alert type="error" title={data.error} />}
      </div>

      <section className="mt-4 rounded-lg bg-gray-800 px-5 py-6 ring-1 ring-gray-700">
        <ol className="grid grid-cols-5 gap-2">
          {steps.map((step, i) => {
            const done = i + 1 < reached || data.status === 'done';
            const current = i + 1 === reached && data.status !== 'done';
            return (
              <li
                key={step.id}
                className="flex flex-col items-center text-center"
              >
                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                    done
                      ? 'bg-green-600 text-white'
                      : current
                        ? 'bg-indigo-500 text-on-accent ring-4 ring-indigo-500/30'
                        : 'bg-gray-700 text-gray-400'
                  }`}
                >
                  {done ? <CheckIcon className="h-4 w-4" /> : i + 1}
                </span>
                <span className="mt-2 text-xs font-semibold text-gray-200 sm:text-sm">
                  {intl.formatMessage(step, {
                    app: appName(data.series?.kind ?? 'series'),
                  })}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="rounded-lg bg-gray-800 ring-1 ring-gray-700">
          <div className="flex items-center justify-between border-b border-gray-700 px-5 py-4">
            <h2 className="text-lg font-semibold text-strong">
              {intl.formatMessage(messages.progress)}
            </h2>
            <span className="text-sm text-gray-400">
              {intl.formatMessage(messages.sizes, {
                have: formatBytes(Math.max(0, data.size - data.sizeLeft)),
                total: formatBytes(data.size),
              })}
              {data.status === 'downloading' && data.speed > 0 && (
                <>
                  {' · '}
                  {intl.formatMessage(messages.speed, {
                    speed: formatBytes(data.speed),
                  })}
                </>
              )}
            </span>
          </div>
          <div className="space-y-5 p-5">
            <div>
              <div className="mb-2 flex justify-between text-sm">
                <span className="font-semibold text-strong">
                  {intl.formatMessage(messages.overall)}
                </span>
                <span className="text-gray-400">
                  {data.secondsLeft && data.status === 'downloading'
                    ? intl.formatMessage(messages.eta, {
                        time: formatDuration(intl, data.secondsLeft),
                      })
                    : `${data.progress}%`}
                </span>
              </div>
              <ProgressBar
                value={data.progress}
                thick
                done={data.status === 'done'}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  [
                    messages.imported,
                    data.status === 'done' || data.status === 'failed'
                      ? data.imported
                      : count('imported'),
                  ],
                  [messages.replaced, data.replaced],
                  [messages.waiting, count('waiting') + count('importing')],
                  [messages.failedCount, count('failed')],
                ] as const
              ).map(([label, value]) => (
                <div
                  key={label.id}
                  className="rounded-lg bg-gray-900/50 p-3 ring-1 ring-gray-700"
                >
                  <div className="text-xs text-gray-400">
                    {intl.formatMessage(label)}
                  </div>
                  <div className="mt-1 text-2xl font-bold text-strong">
                    {value}
                  </div>
                </div>
              ))}
            </div>
            <div>
              <div className="text-label mb-2">
                {intl.formatMessage(messages.files)}
              </div>
              <ul className="max-h-[28rem] divide-y divide-gray-700 overflow-y-auto rounded-md border border-gray-700 bg-gray-900/40">
                {files.map((file) => (
                  <li
                    key={file.index}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
                  >
                    <span className="w-28 whitespace-nowrap font-mono text-gray-300">
                      {episodeLabel(file) || '—'}
                    </span>
                    <span className="min-w-0 flex-1 break-all text-gray-400">
                      {file.name}
                    </span>
                    <span className="whitespace-nowrap text-gray-500">
                      {formatBytes(file.size)}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 ${STATE_STYLE[file.state]}`}
                    >
                      {intl.formatMessage(messages[`state_${file.state}`])}
                    </span>
                    {file.note && (
                      <span className="basis-full pl-[7.75rem] text-gray-500">
                        {file.note}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="flex flex-col rounded-lg bg-gray-800 ring-1 ring-gray-700">
          <h2 className="border-b border-gray-700 px-5 py-4 text-lg font-semibold text-strong">
            {intl.formatMessage(messages.activity)}
          </h2>
          <div className="relative min-h-[16rem] flex-1">
            <ol className="max-h-[36rem] space-y-1 overflow-y-auto p-5 font-mono text-xs leading-6 xl:absolute xl:inset-0 xl:max-h-none">
              {[...(data.log ?? [])].reverse().map((line, i) => (
                <li key={`${line.at}-${i}`} className="flex gap-3">
                  <span className="whitespace-nowrap text-gray-500">
                    <FormattedTime value={line.at} />
                  </span>
                  <span className={LOG_STYLE[line.kind]}>
                    {line.count && line.lastAt
                      ? intl.formatMessage(messages.repeated, {
                          message: line.message,
                          count: line.count,
                          time: intl.formatTime(line.lastAt),
                        })
                      : line.message}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </div>
    </>
  );
};

export default JobDetail;
