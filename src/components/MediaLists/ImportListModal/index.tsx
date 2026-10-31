import Modal from '@app/components/Common/Modal';
import PosterBackground from '@app/components/Common/PosterBackground';
import { RESOLVE_BATCH_SIZE, SEARCH_BATCH_SIZE } from '@app/constants/lists';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaLists.ImportListModal', {
  title: 'Import a written list',
  titleTrakt: 'Import titles or a Trakt list',
  instructions:
    'Paste your list below — one title per line. Bullets, numbering and years are fine.',
  placeholder: 'The Matrix (1999)\nPractical Magic\nPerson of Interest',
  placeholderTrakt:
    'The Matrix (1999)\nPractical Magic\nPerson of Interest\n\nor a Trakt link, like\nhttps://trakt.tv/users/name/lists/favorites',
  traktAdminHint:
    'Trakt links work here once Trakt has a Client ID in Settings → Services.',
  find: 'Find matches',
  review: 'Check these matches before adding them.',
  nomatch: 'No match found',
  skip: 'Skip',
  add: 'Add {count}',
  back: 'Back',
  nothingfound: 'Nothing recognisable in that text.',
  truncated: 'Only the first 100 lines were read.',
  searchagain: 'Search again',
  searchplaceholder: 'Search for the right title',
  alsorequest: 'Also request anything not already in the library',
  notrequested:
    'Added to the list. {count, plural, one {# title wasn’t} other {# titles weren’t}} requested (20 at most per import); request them from the list.',
  matching: 'Matching titles…',
  collection:
    ' — Collection, {count} {count, plural, one {film} other {films}}',
  series: ' — Series',
  movie: ' — Movie',
  instructionsTrakt:
    'Paste titles, one per line, or a link to a public Trakt list or watchlist.',
  readingTrakt: 'Reading the Trakt list…',
  truncatedTrakt: 'Only the first 500 titles were read.',
  traktNotSetUp:
    'Trakt is not set up here yet. An admin can add it in Settings → Services.',
  traktPrivate:
    'That Trakt list or watchlist is private. Make it public on Trakt, then try again.',
  traktNotFound: 'Trakt has no such user or list. Check the link.',
  traktBadKey:
    'Trakt did not accept this server’s Client ID. An admin can check it in Settings → Services.',
  traktLimited:
    'Trakt is limiting requests just now. Try again in a few minutes.',
  traktUnreachable: 'Could not reach Trakt. Try again in a while.',
  notTrakt: 'That isn’t a link to a Trakt list or watchlist.',
});

/** Whether the pasted text is a link to Trakt, rather than a written list. */
const TRAKT_LINK = /^(https?:\/\/)?(www\.|app\.)?trakt\.tv\/\S*$/i;

interface Candidate {
  tmdbId: number;
  mediaType: 'movie' | 'tv' | 'collection';
  /** How many films a collection would add. */
  partCount?: number;
  title?: string;
  year?: number;
  posterPath?: string | null;
}

interface LineResult {
  raw: string;
  query: string;
  year?: number;
  candidates: Candidate[];
}

interface ImportListModalProps {
  listId: number;
  onClose: () => void;
  onImported: () => void;
}

const ImportListModal = ({
  listId,
  onClose,
  onImported,
}: ImportListModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { currentSettings } = useSettings();
  const { hasPermission } = useUser();
  const trakt = !!currentSettings.traktReady;
  const [text, setText] = useState('');
  const [fromTrakt, setFromTrakt] = useState(false);
  const [results, setResults] = useState<LineResult[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [chosen, setChosen] = useState<Record<number, number>>({});
  const [manual, setManual] = useState<Record<number, string>>({});
  const [isBusy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [alsoRequest, setAlsoRequest] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const describe = (e: unknown) =>
    (axios.isAxiosError(e) && e.response?.data?.message) ||
    (e instanceof Error ? e.message : String(e));

  /** What went wrong with Trakt, in the reader's language. */
  const traktProblem = (e: unknown): string => {
    const problem = axios.isAxiosError(e)
      ? e.response?.data?.problem
      : undefined;
    const known: Record<string, keyof typeof messages> = {
      notSetUp: 'traktNotSetUp',
      private: 'traktPrivate',
      notFound: 'traktNotFound',
      badKey: 'traktBadKey',
      rateLimited: 'traktLimited',
      unreachable: 'traktUnreachable',
      notTrakt: 'notTrakt',
    };
    return problem && known[problem]
      ? intl.formatMessage(messages[known[problem]])
      : describe(e);
  };

  /**
   * A Trakt link: the list's titles come with TMDB's ids, so each is looked
   * up rather than searched for, in batches as a written list is.
   */
  const importTrakt = async (url: string) => {
    let titles: {
      tmdbId?: number;
      mediaType: 'movie' | 'tv';
      title: string;
      year?: number;
    }[];
    let wasTruncated: boolean;
    try {
      const { data } = await axios.post<{
        titles: typeof titles;
        truncated: boolean;
      }>('/api/v1/list/import/trakt', { url });
      titles = data.titles;
      wasTruncated = data.truncated;
    } catch (e) {
      setError(traktProblem(e));
      return;
    }

    const batches: (typeof titles)[] = [];
    for (let i = 0; i < titles.length; i += RESOLVE_BATCH_SIZE) {
      batches.push(titles.slice(i, i + RESOLVE_BATCH_SIZE));
    }
    setProgress({ done: 0, total: batches.length });

    const collected: LineResult[] = [];
    for (const [index, batch] of batches.entries()) {
      const { data } = await axios.post<{ results: LineResult[] }>(
        '/api/v1/list/import/resolve',
        { items: batch }
      );
      collected.push(...data.results);
      setProgress({ done: index + 1, total: batches.length });
    }
    showResults(collected, wasTruncated, true);
  };

  const showResults = (
    collected: LineResult[],
    wasTruncated: boolean,
    trakt: boolean
  ) => {
    setResults(collected);
    setTruncated(wasTruncated);
    setFromTrakt(trakt);
    setChosen(
      Object.fromEntries(
        collected.map((line, index) => [index, line.candidates.length ? 0 : -1])
      )
    );
  };

  /**
   * Searches in batches so progress can be reported honestly. Sending the
   * whole list in one request gives no way to say how far along it is, and a
   * long list can take a while — each title is a TMDB lookup.
   */
  const search = async () => {
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: 0 });

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 1 && TRAKT_LINK.test(lines[0])) {
      try {
        await importTrakt(lines[0]);
      } catch (e) {
        setError(describe(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    const batches: string[][] = [];

    for (let i = 0; i < lines.length; i += SEARCH_BATCH_SIZE) {
      batches.push(lines.slice(i, i + SEARCH_BATCH_SIZE));
    }

    setProgress({ done: 0, total: batches.length });

    try {
      const collected: LineResult[] = [];
      let wasTruncated = false;

      for (const [index, batch] of batches.entries()) {
        const { data } = await axios.post<{
          results: LineResult[];
          truncated: boolean;
        }>('/api/v1/list/import/search', { text: batch.join('\n') });

        collected.push(...data.results);
        wasTruncated = wasTruncated || data.truncated;
        setProgress({ done: index + 1, total: batches.length });
      }

      showResults(collected, wasTruncated, false);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Re-runs a single line against a title the user typed. Automatic matching
   * always misses some, and an unmatched line with no way to correct it is a
   * dead end — the point of this feature is migrating a list that exists.
   */
  const searchOne = async (index: number) => {
    const query = (manual[index] ?? '').trim();

    if (!query || !results) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const { data } = await axios.post<{ results: LineResult[] }>(
        '/api/v1/list/import/search',
        { text: query }
      );

      const candidates = data.results[0]?.candidates ?? [];

      setResults(
        results.map((line, i) => (i === index ? { ...line, candidates } : line))
      );
      setChosen((current) => ({
        ...current,
        [index]: candidates.length ? 0 : -1,
      }));
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  const selectedCount = results
    ? results.filter((_, index) => (chosen[index] ?? -1) >= 0).length
    : 0;

  const commit = async () => {
    if (!results) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const items = results
        .map((line, index) => {
          const pick = chosen[index] ?? -1;
          return pick >= 0 ? line.candidates[pick] : null;
        })
        .filter((c): c is Candidate => !!c)
        .map((c) => ({
          tmdbId: c.tmdbId,
          mediaType: c.mediaType,
          posterPath: c.posterPath ?? null,
        }));

      const { data } = await axios.post<{ notRequested?: number }>(
        `/api/v1/list/${listId}/import`,
        {
          items,
          request: alsoRequest,
        }
      );
      if (data.notRequested) {
        addToast(
          intl.formatMessage(messages.notrequested, {
            count: data.notRequested,
          }),
          { appearance: 'info', autoDismiss: false }
        );
      }
      onImported();
      onClose();
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  };

  return (
    <Transition
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show
    >
      <Modal
        backgroundClickable={false}
        loading={isBusy && !results && progress.total === 0}
        okButtonType="primary"
        okDisabled={results ? !selectedCount || isBusy : !text.trim() || isBusy}
        okText={
          results
            ? intl.formatMessage(messages.add, { count: selectedCount })
            : intl.formatMessage(messages.find)
        }
        onCancel={onClose}
        onOk={results ? commit : search}
        onSecondary={results ? () => setResults(null) : undefined}
        secondaryButtonType="default"
        secondaryText={results ? intl.formatMessage(messages.back) : undefined}
        title={intl.formatMessage(trakt ? messages.titleTrakt : messages.title)}
      >
        {error && (
          <p className="mb-3 rounded bg-red-900/40 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}

        {!results ? (
          <>
            <p className="mb-2 text-sm text-gray-300">
              {intl.formatMessage(
                trakt ? messages.instructionsTrakt : messages.instructions
              )}
            </p>
            {!trakt && hasPermission(Permission.ADMIN) && (
              <p className="mb-2 text-xs text-gray-400">
                {intl.formatMessage(messages.traktAdminHint)}
              </p>
            )}
            <textarea
              className="h-48 w-full rounded border-gray-600 bg-gray-700 p-3 font-mono text-sm text-white"
              onChange={(e) => setText(e.target.value)}
              placeholder={intl.formatMessage(
                trakt ? messages.placeholderTrakt : messages.placeholder
              )}
              value={text}
            />

            <label className="mt-3 flex items-center space-x-2 text-sm text-gray-300">
              <input
                checked={alsoRequest}
                className="h-4 w-4 flex-none rounded border-gray-600 bg-gray-700 text-indigo-600"
                onChange={() => setAlsoRequest((v) => !v)}
                type="checkbox"
              />
              <span className="leading-none">
                {intl.formatMessage(messages.alsorequest)}
              </span>
            </label>

            {isBusy && progress.total > 0 && (
              <div className="mt-3">
                <div className="mb-1 flex justify-between text-xs text-gray-400">
                  <span>
                    {intl.formatMessage(
                      TRAKT_LINK.test(text.trim())
                        ? messages.readingTrakt
                        : messages.matching
                    )}
                  </span>
                  <span>
                    {Math.round((progress.done / progress.total) * 100)}%
                  </span>
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
          </>
        ) : (
          <>
            <p className="mb-2 text-sm text-gray-300">
              {intl.formatMessage(messages.review)}
              {truncated
                ? ` ${intl.formatMessage(
                    fromTrakt ? messages.truncatedTrakt : messages.truncated
                  )}`
                : ''}
            </p>

            {!results.length ? (
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.nothingfound)}
              </p>
            ) : (
              <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
                {results.map((line, index) => {
                  const pick = chosen[index] ?? -1;

                  return (
                    <li
                      className="rounded border border-gray-700 bg-gray-900/40 p-2"
                      key={`line-${index}`}
                    >
                      <p className="mb-1 text-xs text-gray-400 [overflow-wrap:anywhere]">
                        {line.raw}
                      </p>

                      {line.candidates.length ? (
                        <div className="flex items-center space-x-2">
                          {pick >= 0 && line.candidates[pick]?.posterPath && (
                            <PosterBackground
                              className="h-12 w-8 flex-none rounded bg-cover bg-center"
                              posterPath={line.candidates[pick].posterPath}
                              size="w92"
                            />
                          )}
                          <select
                            className="min-w-0 flex-1 rounded border-gray-600 bg-gray-700 text-sm text-white"
                            onChange={(e) =>
                              setChosen((current) => ({
                                ...current,
                                [index]: Number(e.target.value),
                              }))
                            }
                            value={pick}
                          >
                            {line.candidates.map((candidate, ci) => (
                              <option key={`c-${ci}`} value={ci}>
                                {candidate.title}
                                {candidate.year ? ` (${candidate.year})` : ''}
                                {candidate.mediaType === 'collection'
                                  ? intl.formatMessage(messages.collection, {
                                      count: candidate.partCount ?? 0,
                                    })
                                  : intl.formatMessage(
                                      candidate.mediaType === 'tv'
                                        ? messages.series
                                        : messages.movie
                                    )}
                              </option>
                            ))}
                            <option value={-1}>
                              {intl.formatMessage(messages.skip)}
                            </option>
                          </select>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500">
                          {intl.formatMessage(messages.nomatch)}
                        </p>
                      )}

                      <div className="mt-2 flex items-center space-x-2">
                        <input
                          className="min-w-0 flex-1 rounded border-gray-600 bg-gray-700 px-2 py-1 text-xs text-white"
                          onChange={(e) =>
                            setManual((current) => ({
                              ...current,
                              [index]: e.target.value,
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              searchOne(index);
                            }
                          }}
                          placeholder={intl.formatMessage(
                            messages.searchplaceholder
                          )}
                          type="text"
                          value={manual[index] ?? ''}
                        />
                        <button
                          aria-label={intl.formatMessage(messages.searchagain)}
                          className="flex-none rounded bg-gray-700 p-1.5 text-gray-200 hover:bg-gray-600 disabled:opacity-50"
                          disabled={!(manual[index] ?? '').trim() || isBusy}
                          onClick={() => searchOne(index)}
                          type="button"
                        >
                          <MagnifyingGlassIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </Modal>
    </Transition>
  );
};

export default ImportListModal;
