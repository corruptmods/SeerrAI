import { messages as listMessages } from '@app/components/AddToList';
import Button from '@app/components/Common/Button';
import useClickOutside from '@app/hooks/useClickOutside';
import { MARKERS_KEY } from '@app/hooks/useMediaMarkers';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { BookmarkIcon, PlusIcon } from '@heroicons/react/24/outline';
import { BookmarkIcon as BookmarkFilledIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.AddToList.Collection', {
  someOn: '{count} of {total} on it',
  allOn: 'All on it',
  added: '{count, plural, one {Added # film} other {Added # films}} to {list}.',
});

interface ListSummary {
  kind?: 'watch' | 'music';
  id: number;
  name: string;
}

interface AddCollectionToListProps {
  /** The collection's films, with posters. */
  movies: { tmdbId: number; posterPath?: string | null }[];
}

/**
 * Add to List for a collection: each list shows how many of its films it
 * has; choosing one adds the rest.
 */
const AddCollectionToList = ({ movies }: AddCollectionToListProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const [isOpen, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState<number[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => setOpen(false));

  const { data: allLists, mutate: revalidateLists } =
    useSWR<ListSummary[]>('/api/v1/list');
  // Films go on watch lists, not playlists.
  const lists = allLists?.filter((list) => list.kind !== 'music');

  const ids = movies.map((movie) => movie.tmdbId);
  const { data: membership, mutate: revalidateMembership } = useSWR<
    { listId: number; tmdbId: number }[]
  >(
    ids.length
      ? `/api/v1/list/contains?tmdbIds=${ids.join(',')}&mediaType=movie`
      : null
  );

  /** The collection's films on each list. */
  const onList = new Map<number, Set<number>>();
  for (const entry of membership ?? []) {
    const films = onList.get(entry.listId) ?? new Set<number>();
    films.add(entry.tmdbId);
    onList.set(entry.listId, films);
  }
  const has = (listId: number) => onList.get(listId)?.size ?? 0;
  const total = new Set(ids).size;
  const wholeOnSome = [...onList.values()].some((films) => films.size >= total);

  const reportError = (e: unknown) => {
    const detail =
      (axios.isAxiosError(e) && e.response?.data?.message) ||
      (e instanceof Error ? e.message : String(e));
    addToast(
      <span>{intl.formatMessage(listMessages.failed, { detail })}</span>,
      { appearance: 'error', autoDismiss: true }
    );
  };

  /** Adds the missing films to a list and reports how many. */
  const addTo = async (listId: number, listName: string) => {
    const already = onList.get(listId) ?? new Set<number>();
    const missing = movies.filter((movie) => !already.has(movie.tmdbId));
    if (!missing.length) return;
    setPending((current) => [...current, listId]);
    try {
      const { data } = await axios.post<{ added: number }>(
        `/api/v1/list/${listId}/import`,
        {
          items: missing.map((movie) => ({
            tmdbId: movie.tmdbId,
            mediaType: 'movie',
            posterPath: movie.posterPath ?? null,
          })),
          request: false,
        }
      );
      addToast(
        intl.formatMessage(messages.added, {
          count: data.added,
          list: listName,
        }),
        { appearance: 'success', autoDismiss: true }
      );
      await Promise.all([
        revalidateMembership(),
        revalidateLists(),
        globalMutate(MARKERS_KEY),
      ]);
    } catch (e) {
      reportError(e);
    } finally {
      setPending((current) => current.filter((id) => id !== listId));
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const { data } = await axios.post<{ id: number }>('/api/v1/list', {
        name,
      });
      setNewName('');
      await addTo(data.id, name);
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <Button
        buttonType={wholeOnSome ? 'primary' : 'default'}
        onClick={() => setOpen((open) => !open)}
      >
        {wholeOnSome ? <BookmarkFilledIcon /> : <BookmarkIcon />}
        <span>
          {intl.formatMessage(
            wholeOnSome ? listMessages.inlist : listMessages.addtolist
          )}
        </span>
      </Button>

      {/*
        Anchored to the button's start on phones (beside the request button)
        and its end on wider screens (at the page edge).
      */}
      {isOpen && (
        <div className="media-action-menu absolute start-0 z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-gray-700 bg-gray-800 p-2 shadow-lg sm:end-0 sm:start-auto">
          {lists?.length ? (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {lists.map((list) => {
                const count = has(list.id);
                const all = count >= total;
                return (
                  <li key={`list-${list.id}`}>
                    <button
                      className="flex w-full items-center space-x-2 rounded px-2 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-60 disabled:hover:bg-transparent"
                      disabled={all || pending.includes(list.id)}
                      onClick={() => addTo(list.id, list.name)}
                      type="button"
                    >
                      <input
                        checked={all}
                        className="h-4 w-4 flex-none rounded border-gray-600 bg-gray-700 text-indigo-600"
                        readOnly
                        ref={(el) => {
                          if (el) el.indeterminate = count > 0 && !all;
                        }}
                        tabIndex={-1}
                        type="checkbox"
                      />
                      <span className="min-w-0 flex-1 whitespace-normal break-words">
                        {list.name}
                        {count > 0 && (
                          <span className="block text-xs text-gray-400">
                            {all
                              ? intl.formatMessage(messages.allOn)
                              : intl.formatMessage(messages.someOn, {
                                  count,
                                  total,
                                })}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-2 py-2 text-sm text-gray-400">
              {intl.formatMessage(listMessages.nolists)}
            </p>
          )}

          <div className="mt-2 flex items-center space-x-2 border-t border-gray-700 pt-2">
            <input
              className="min-w-0 flex-1 rounded border-gray-600 bg-gray-700 px-2 py-1 text-sm text-white"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  createAndAdd();
                }
              }}
              placeholder={intl.formatMessage(listMessages.newlist)}
              type="text"
              value={newName}
            />
            <button
              aria-label={intl.formatMessage(listMessages.create)}
              className="rounded bg-indigo-600 p-1.5 text-white hover:bg-indigo-500 disabled:opacity-50"
              disabled={!newName.trim()}
              onClick={createAndAdd}
              type="button"
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AddCollectionToList;
