import {
  AskAgent,
  RunRow,
  messages,
  useAgent,
} from '@app/components/Backfill/Agent/parts';
import { SCROLL_LIST } from '@app/components/Backfill/shared';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { TrashIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const pageMessages = defineMessages('components.Backfill.Agent.List', {
  backfill: 'Backfill',
  newer: 'Newer',
  older: 'Older',
  clear: 'Clear finished',
  confirmClear: 'Delete them?',
  clearFailed: 'Could not clear finished conversations.',
  clearTip:
    'Cleared automatically after the days set in Settings. Ones still downloading stay; downloads are never touched.',
});

const PAGE = 25;

/** Every run of the admin agent, newest first, and asking it. */
const AgentList = () => {
  const intl = useIntl();
  const [page, setPage] = useState(0);
  const { data, error, mutate } = useAgent(page);
  const [clearProblem, setClearProblem] = useState<string>();
  // Counted on every page, so it can be cleared from any of them.
  const finished = !!data?.finished;
  const clear = async () => {
    setClearProblem(undefined);
    try {
      await axios.post('/api/v1/agent/clear');
      setPage(0);
      await mutate();
    } catch (e) {
      setClearProblem(
        axios.isAxiosError(e) && e.response?.data?.message
          ? String(e.response.data.message)
          : intl.formatMessage(pageMessages.clearFailed)
      );
    }
  };
  if (error && !data) return <ErrorPage statusCode={500} />;
  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.agent),
          intl.formatMessage(pageMessages.backfill),
        ]}
      />
      <div className="mt-6 text-sm text-gray-500">
        <Link href="/backfill" className="hover:text-gray-300">
          {intl.formatMessage(pageMessages.backfill)}
        </Link>
      </div>
      <Header subtext={intl.formatMessage(messages.description)}>
        {intl.formatMessage(messages.agent)}
      </Header>
      {!data ? (
        <LoadingSpinner />
      ) : (
        <div className="mt-6 space-y-6">
          <section className="space-y-2 rounded-lg bg-gray-800 p-5 ring-1 ring-gray-700">
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
          </section>
          {finished && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-gray-500">
                {intl.formatMessage(pageMessages.clearTip)}
              </p>
              <ConfirmButton
                onClick={clear}
                confirmText={intl.formatMessage(pageMessages.confirmClear)}
                className="flex-none"
              >
                <TrashIcon />
                <span>{intl.formatMessage(pageMessages.clear)}</span>
              </ConfirmButton>
            </div>
          )}
          {clearProblem && <Alert type="error" title={clearProblem} />}
          <section className="rounded-lg bg-gray-800 ring-1 ring-gray-700">
            <ul className={`divide-y divide-gray-700 ${SCROLL_LIST}`}>
              {!data.runs.length && (
                <li className="px-5 py-6 text-sm text-gray-400">
                  {intl.formatMessage(messages.noRuns)}
                </li>
              )}
              {data.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          </section>
          {data.total > PAGE && (
            <div className="flex justify-between">
              <Button
                buttonType="default"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {intl.formatMessage(pageMessages.newer)}
              </Button>
              <Button
                buttonType="default"
                disabled={(page + 1) * PAGE >= data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                {intl.formatMessage(pageMessages.older)}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default AgentList;
