import { resultLabel } from '@app/components/AiChat/AiTitleCard';
import Modal from '@app/components/Common/Modal';
import PosterBackground from '@app/components/Common/PosterBackground';
import { MARKERS_KEY } from '@app/hooks/useMediaMarkers';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { MediaStatus } from '@server/constants/media';
import type { MovieResult, TvResult } from '@server/models/Search';
import axios from 'axios';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.AiChat.AiBulkSheet', {
  listTitle: 'Add to a List',
  requestTitle: 'Request',
  whichList: 'List',
  newList: 'A new list',
  listName: 'Name of the new list',
  alsoRequest: 'Also request what is not here yet',
  seasons: 'Series are requested with every season.',
  add: 'Add {count, plural, one {# Title} other {# Titles}}',
  request: 'Request {count, plural, one {# Title} other {# Titles}}',
  close: 'Close',
  here: 'In the library',
  coming: 'On its way',
  asked: 'Already requested',
  blocked: 'Blocklisted',
  movie: 'Movie',
  series: 'Series',
  failed: 'That did not work. Try again.',
  needName: 'Give the new list a name.',
  added:
    '{added, plural, one {# title} other {# titles}} added to {name}.{skipped, plural, =0 {} one { # was already on it.} other { # were already on it.}}',
  requestedCount:
    '{count, plural, =0 {Nothing needed requesting.} one {# title requested.} other {# titles requested.}}',
  requestFailedCount:
    '{count, plural, =0 {} one {# could not be requested.} other {# could not be requested.}}',
  openList: 'Open the List',
  outcomeRequested: 'Requested',
  requesting: 'Requesting {done} of {total}…',
  notOut: 'Not out yet',
  chooseAll: 'Tick All',
  chooseNone: 'Untick All',
  outcomeHere: 'Already here',
  outcomeAsked: 'Already requested',
});

interface ListSummary {
  id: number;
  name: string;
}

type Title = MovieResult | TvResult;

type Outcome = 'requested' | 'here' | 'asked' | 'failed';

interface RequestResult {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  outcome: Outcome;
  message?: string;
}

/** Titles one call to /request/missing takes. */
const REQUEST_BATCH = 20;

const keyOf = (title: Title) => `${title.mediaType}:${title.id}`;

/** Released after today, or with no date yet. */
const notOutYet = (title: Title) => {
  const date =
    title.mediaType === 'movie' ? title.releaseDate : title.firstAirDate;
  return !date || date > new Date().toISOString().slice(0, 10);
};

/** Whether the title still needs requesting, as far as the page knows. */
const statusOf = (
  title: Title
): 'missing' | 'here' | 'coming' | 'asked' | 'blocked' => {
  const status = title.mediaInfo?.status;
  if (status === MediaStatus.BLOCKLISTED) {
    return 'blocked';
  }
  if (
    status === MediaStatus.AVAILABLE ||
    status === MediaStatus.PARTIALLY_AVAILABLE
  ) {
    return 'here';
  }
  if (status === MediaStatus.PROCESSING) {
    return 'coming';
  }
  if (status === MediaStatus.PENDING) {
    return 'asked';
  }
  return 'missing';
};

/**
 * Puts several titles AI Search found on a watch list, new or existing, or
 * requests the ones not here yet. Always confirmed here: the AI only sets it
 * up. Requests go through the usual rules, one title at a time.
 */
const AiBulkSheet = ({
  mode,
  titles,
  suggestedName,
  onClose,
  onRequested,
}: {
  mode: 'list' | 'request';
  titles: Title[];
  suggestedName?: string;
  onClose: () => void;
  /** Titles now requested, so the cards behind can say so. */
  onRequested?: (keys: string[]) => void;
}) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const canRequest = hasPermission(
    [Permission.REQUEST, Permission.REQUEST_MOVIE, Permission.REQUEST_TV],
    { type: 'or' }
  );
  const { data: lists } = useSWR<ListSummary[]>(
    mode === 'list' ? '/api/v1/list' : null
  );

  // Requesting: only what is not here or asked for yet is ticked.
  const [chosen, setChosen] = useState<Set<string>>(
    () =>
      new Set(
        titles
          .filter((t) => mode === 'list' || statusOf(t) === 'missing')
          .map(keyOf)
      )
  );
  const [target, setTarget] = useState<number | 'new'>('new');
  const [name, setName] = useState(suggestedName ?? '');
  const [alsoRequest, setAlsoRequest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{
    listId?: number;
    listName?: string;
    added?: number;
    skipped?: number;
    requested: number;
    requestFailed: number;
    results?: RequestResult[];
  }>();

  // A list the AI named that already exists is the one meant.
  useEffect(() => {
    if (!lists || !suggestedName) {
      return;
    }
    const match = lists.find(
      (list) =>
        list.name.trim().toLowerCase() === suggestedName.trim().toLowerCase()
    );
    if (match) {
      setTarget(match.id);
    }
  }, [lists, suggestedName]);

  const picked = useMemo(
    () => titles.filter((t) => chosen.has(keyOf(t))),
    [titles, chosen]
  );

  // What may be ticked: requesting skips what is here or asked for.
  const choosable = titles.filter(
    (t) => mode === 'list' || statusOf(t) === 'missing'
  );
  const allChosen = choosable.every((t) => chosen.has(keyOf(t)));

  const toggle = (title: Title) =>
    setChosen((now) => {
      const next = new Set(now);
      if (next.has(keyOf(title))) {
        next.delete(keyOf(title));
      } else {
        next.add(keyOf(title));
      }
      return next;
    });

  /*
   * Twenty at a time: each request goes to Radarr or Sonarr in turn, and a
   * hundred in one call could outlast a reverse proxy's time limit.
   */
  const requestInBatches = async (items: Title[]) => {
    const results: RequestResult[] = [];
    try {
      for (let i = 0; i < items.length; i += REQUEST_BATCH) {
        setProgress({ done: i, total: items.length });
        const batch = await axios.post<{ results: RequestResult[] }>(
          '/api/v1/request/missing',
          {
            items: items.slice(i, i + REQUEST_BATCH).map((t) => ({
              tmdbId: t.id,
              mediaType: t.mediaType,
            })),
          }
        );
        results.push(...batch.data.results);
      }
    } finally {
      setProgress(undefined);
      onRequested?.(
        results
          .filter((r) => r.outcome === 'requested')
          .map((r) => `${r.mediaType}:${r.tmdbId}`)
      );
    }
    return results;
  };

  const submit = async () => {
    if (!picked.length || busy) {
      return;
    }
    if (mode === 'list' && target === 'new' && !name.trim()) {
      setError(intl.formatMessage(messages.needName));
      return;
    }
    setBusy(true);
    setError(undefined);
    let summary: NonNullable<typeof done> = { requested: 0, requestFailed: 0 };
    try {
      if (mode === 'list') {
        let listId = target;
        let listName = lists?.find((l) => l.id === target)?.name ?? '';
        if (listId === 'new') {
          const created = await axios.post<{ id: number; name: string }>(
            '/api/v1/list',
            { name: name.trim() }
          );
          listId = created.data.id;
          listName = created.data.name;
        }
        const result = await axios.post<{ added: number; skipped: number }>(
          `/api/v1/list/${listId}/import`,
          {
            items: picked.map((t) => ({
              tmdbId: t.id,
              mediaType: t.mediaType,
              posterPath: t.posterPath ?? null,
            })),
          }
        );
        summary = { ...summary, listId, listName, ...result.data };
        mutate('/api/v1/list');
        mutate(MARKERS_KEY);
      }
      if (mode === 'request' || (canRequest && alsoRequest)) {
        const results = await requestInBatches(
          picked.filter((t) => statusOf(t) === 'missing')
        );
        summary = {
          ...summary,
          requested: results.filter((r) => r.outcome === 'requested').length,
          requestFailed: results.filter((r) => r.outcome === 'failed').length,
          results,
        };
      }
      setDone(summary);
    } catch {
      setError(intl.formatMessage(messages.failed));
      // What was done before it failed is still shown.
      if (summary.listId !== undefined || summary.results) {
        setDone(summary);
      }
    } finally {
      setBusy(false);
    }
  };

  const outcomeFor = (title: Title) =>
    done?.results?.find(
      (r) => r.tmdbId === title.id && r.mediaType === title.mediaType
    );

  const statusText = (title: Title) => {
    const outcome = outcomeFor(title);
    if (outcome) {
      return outcome.outcome === 'failed'
        ? outcome.message
        : intl.formatMessage(
            outcome.outcome === 'requested'
              ? messages.outcomeRequested
              : outcome.outcome === 'here'
                ? messages.outcomeHere
                : messages.outcomeAsked
          );
    }
    const status = statusOf(title);
    return status === 'missing'
      ? undefined
      : intl.formatMessage(
          status === 'here'
            ? messages.here
            : status === 'coming'
              ? messages.coming
              : status === 'blocked'
                ? messages.blocked
                : messages.asked
        );
  };

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={intl.formatMessage(
          mode === 'list' ? messages.listTitle : messages.requestTitle
        )}
        onCancel={onClose}
        cancelText={done ? intl.formatMessage(messages.close) : undefined}
        onOk={done ? undefined : submit}
        okText={intl.formatMessage(
          mode === 'list' ? messages.add : messages.request,
          { count: picked.length }
        )}
        okButtonType="primary"
        okDisabled={busy || !picked.length}
        backgroundClickable={!busy}
        showCloseButton
      >
        <div className="space-y-4 text-sm" data-testid="ai-bulk-sheet">
          {error && (
            <p className="rounded bg-red-900/40 px-3 py-2 text-red-200 light:bg-danger-soft/15 light:text-danger-text">
              {error}
            </p>
          )}
          {done && (
            <div className="space-y-1 rounded-md border border-gray-700 bg-gray-900/60 px-3 py-2 text-gray-200">
              {done.listId !== undefined && (
                <p>
                  {intl.formatMessage(messages.added, {
                    added: done.added ?? 0,
                    skipped: done.skipped ?? 0,
                    name: done.listName,
                  })}
                </p>
              )}
              {(mode === 'request' || alsoRequest) && (
                <p>
                  {intl.formatMessage(messages.requestedCount, {
                    count: done.requested,
                  })}{' '}
                  {intl.formatMessage(messages.requestFailedCount, {
                    count: done.requestFailed,
                  })}
                </p>
              )}
              {done.listId !== undefined && (
                <Link
                  href={`/lists/${done.listId}`}
                  className="inline-block pt-1 font-semibold text-indigo-300 hover:text-indigo-200 light:text-accent-text light:hover:text-accent-text"
                  onClick={onClose}
                >
                  {intl.formatMessage(messages.openList)}
                </Link>
              )}
            </div>
          )}

          {mode === 'list' && !done && (
            <div className="space-y-2">
              <label htmlFor="ai-bulk-list" className="block text-gray-400">
                {intl.formatMessage(messages.whichList)}
              </label>
              <select
                id="ai-bulk-list"
                value={target}
                onChange={(e) =>
                  setTarget(
                    e.target.value === 'new' ? 'new' : Number(e.target.value)
                  )
                }
              >
                <option value="new">
                  {intl.formatMessage(messages.newList)}
                </option>
                {(lists ?? []).map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
              {target === 'new' && (
                <input
                  type="text"
                  maxLength={100}
                  aria-label={intl.formatMessage(messages.listName)}
                  placeholder={intl.formatMessage(messages.listName)}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
              {canRequest && (
                <label className="flex cursor-pointer items-center gap-3 pt-1 text-gray-300">
                  <input
                    type="checkbox"
                    className="flex-none"
                    checked={alsoRequest}
                    onChange={(e) => setAlsoRequest(e.target.checked)}
                  />
                  <span>{intl.formatMessage(messages.alsoRequest)}</span>
                </label>
              )}
            </div>
          )}

          {(mode === 'request' || alsoRequest) &&
            !done &&
            titles.some((t) => t.mediaType === 'tv') && (
              <p className="text-xs text-gray-400">
                {intl.formatMessage(messages.seasons)}
              </p>
            )}

          {progress && (
            <div role="status">
              <div className="mb-1 text-xs text-gray-400">
                {intl.formatMessage(messages.requesting, progress)}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-700">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                  style={{
                    width: `${(progress.done / progress.total) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}

          {!done && choosable.length > 6 && (
            <button
              type="button"
              className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 light:text-accent-text light:hover:text-accent-text"
              onClick={() =>
                setChosen(allChosen ? new Set() : new Set(choosable.map(keyOf)))
              }
            >
              {intl.formatMessage(
                allChosen ? messages.chooseNone : messages.chooseAll
              )}
            </button>
          )}

          <ul className="max-h-[45vh] space-y-1 overflow-y-auto">
            {titles.map((title) => {
              const status = statusOf(title);
              const locked =
                !!done || (mode === 'request' && status !== 'missing');
              const note = statusText(title);
              const failed = outcomeFor(title)?.outcome === 'failed';
              return (
                <li key={keyOf(title)}>
                  <label
                    className={`flex items-center gap-3 rounded-md px-2 py-1.5 ${
                      locked ? '' : 'cursor-pointer hover:bg-gray-700/50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="flex-none"
                      checked={chosen.has(keyOf(title))}
                      disabled={locked}
                      onChange={() => toggle(title)}
                    />
                    <PosterBackground
                      className="h-12 w-8 flex-none rounded bg-gray-700 bg-cover bg-center"
                      posterPath={title.posterPath}
                      size="w92"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-gray-100">
                        {resultLabel(title)}
                      </span>
                      <span
                        className={`block truncate text-xs ${
                          failed ? 'text-red-300' : 'text-gray-400'
                        }`}
                      >
                        {intl.formatMessage(
                          title.mediaType === 'movie'
                            ? messages.movie
                            : messages.series
                        )}
                        {note ? ` · ${note}` : ''}
                        {!note && notOutYet(title)
                          ? ` · ${intl.formatMessage(messages.notOut)}`
                          : ''}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      </Modal>
    </Transition>
  );
};

export default AiBulkSheet;
