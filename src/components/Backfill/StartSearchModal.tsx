import type { TitleKind } from '@app/components/Backfill/types';
import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Backfill.StartSearchModal', {
  title: 'Start a Backfill search',
  pickSeries: 'Series or movie',
  filter: 'Find a series in Sonarr or a movie in Radarr…',
  noMatches: 'Nothing in Sonarr or Radarr matches.',
  series: 'Series',
  movie: 'Movie',
  searchNames: 'Search names',
  searchNamesTip:
    'Prowlarr is searched under the title and aliases Sonarr or Radarr has. Add the names release groups use, such as a romanised or original title.',
  addName: 'Add a name',
  add: 'Add',
  remove: 'Remove {name}',
  start: 'Start search',
  starting: 'Starting…',
  failed: 'The search could not be started.',
  takesAWhile:
    'Searching every indexer and opening the most likely packs takes a few minutes. Its page shows what was found.',
});

export interface LibraryTitle {
  kind: TitleKind;
  serverId: number;
  arrId: number;
  title: string;
}

interface LibraryOption extends LibraryTitle {
  serverName: string;
  year: number;
}

interface StartSearchModalProps {
  show: boolean;
  onClose: () => void;
  /** A title Backfill already follows. */
  seriesId?: number;
  /** A series or movie to start following (from a title page). */
  target?: LibraryTitle;
  /** Names Sonarr already knows, shown for reference. */
  knownNames?: string[];
  initialTerms?: string[];
}

const StartSearchModal = ({
  show,
  onClose,
  seriesId,
  target,
  knownNames = [],
  initialTerms = [],
}: StartSearchModalProps) => {
  const intl = useIntl();
  const router = useRouter();
  const [terms, setTerms] = useState<string[]>(initialTerms);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<LibraryOption>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const needsPick = !seriesId && !target;
  const { data: options } = useSWR<LibraryOption[]>(
    show && needsPick ? '/api/v1/backfill/library' : null
  );
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (options ?? [])
      .filter((o) => !f || o.title.toLowerCase().includes(f))
      .slice(0, 50);
  }, [options, filter]);

  const addTerm = () => {
    const t = draft.trim();
    if (t && !terms.includes(t) && terms.length < 10) setTerms([...terms, t]);
    setDraft('');
  };

  const start = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      let id = seriesId;
      if (!id) {
        const chosen = target ?? picked;
        if (!chosen) return;
        const { data } = await axios.post<{ id: number }>(
          '/api/v1/backfill/series',
          {
            kind: chosen.kind,
            serverId: chosen.serverId,
            arrId: chosen.arrId,
          }
        );
        id = data.id;
      }
      await axios.post(`/api/v1/backfill/series/${id}/search`, {
        searchTerms: terms,
      });
      onClose();
      router.push(`/backfill/series/${id}`);
    } catch (e) {
      setProblem(
        axios.isAxiosError(e) && e.response?.data?.message
          ? String(e.response.data.message)
          : intl.formatMessage(messages.failed)
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Transition
      as="div"
      show={show}
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={intl.formatMessage(messages.title)}
        subTitle={target?.title}
        onCancel={onClose}
        onOk={start}
        okText={intl.formatMessage(busy ? messages.starting : messages.start)}
        okDisabled={busy || (needsPick && !picked)}
        okButtonType="primary"
        loading={busy}
      >
        <div className="space-y-5">
          {problem && <Alert type="error" title={problem} />}
          {needsPick && (
            <div>
              <label
                htmlFor="backfill-series-filter"
                className="text-label mb-1 block"
              >
                {intl.formatMessage(messages.pickSeries)}
              </label>
              <input
                id="backfill-series-filter"
                type="text"
                className="w-full"
                placeholder={intl.formatMessage(messages.filter)}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <ul className="mt-2 max-h-52 divide-y divide-gray-700 overflow-y-auto rounded-md border border-gray-700">
                {shown.map((o) => (
                  <li key={`${o.kind}-${o.serverId}-${o.arrId}`}>
                    <button
                      type="button"
                      onClick={() => setPicked(o)}
                      className={`flex w-full items-baseline justify-between px-3 py-2 text-left text-sm hover:bg-gray-700 ${
                        picked?.kind === o.kind &&
                        picked.arrId === o.arrId &&
                        picked.serverId === o.serverId
                          ? 'bg-indigo-600/30 text-white'
                          : 'text-gray-200'
                      }`}
                    >
                      <span>
                        {o.title}{' '}
                        <span className="text-gray-400">({o.year})</span>
                      </span>
                      <span className="text-xs text-gray-500">
                        {intl.formatMessage(
                          o.kind === 'movie' ? messages.movie : messages.series
                        )}{' '}
                        · {o.serverName}
                      </span>
                    </button>
                  </li>
                ))}
                {options && !shown.length && (
                  <li className="px-3 py-2 text-sm text-gray-400">
                    {intl.formatMessage(messages.noMatches)}
                  </li>
                )}
              </ul>
            </div>
          )}
          <div>
            <div className="text-label mb-1">
              {intl.formatMessage(messages.searchNames)}
            </div>
            <p className="mb-2 text-sm text-gray-400">
              {intl.formatMessage(messages.searchNamesTip)}
            </p>
            {knownNames.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {knownNames.map((name) => (
                  <span
                    key={name}
                    className="rounded-full bg-gray-700/60 px-3 py-0.5 text-sm text-gray-300"
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {terms.map((term) => (
                <span
                  key={term}
                  className="inline-flex items-center gap-1 rounded-full bg-indigo-600/30 px-3 py-0.5 text-sm text-indigo-100"
                >
                  {term}
                  <button
                    type="button"
                    aria-label={intl.formatMessage(messages.remove, {
                      name: term,
                    })}
                    onClick={() => setTerms(terms.filter((t) => t !== term))}
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                className="flex-1"
                aria-label={intl.formatMessage(messages.addName)}
                placeholder={intl.formatMessage(messages.addName)}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTerm();
                  }
                }}
              />
              <button
                type="button"
                className="rounded-md bg-gray-700 px-3 text-sm text-white hover:bg-gray-600"
                onClick={addTerm}
              >
                {intl.formatMessage(messages.add)}
              </button>
            </div>
          </div>
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.takesAWhile)}
          </p>
        </div>
      </Modal>
    </Transition>
  );
};

export default StartSearchModal;
