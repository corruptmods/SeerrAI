import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import useClickOutside from '@app/hooks/useClickOutside';
import { MARKERS_KEY } from '@app/hooks/useMediaMarkers';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { BookmarkIcon, PlusIcon } from '@heroicons/react/24/outline';
import { BookmarkIcon as BookmarkFilledIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.AddToList', {
  addtolist: 'Add to List',
  inlist: 'In List',
  newlist: 'New list name',
  create: 'Create',
  nolists: 'No lists yet. Create one below.',
  alreadyon: 'Already on {lists}',
  failed: 'List update failed: {detail}',
  done: 'Done',
});

interface ListSummary {
  id: number;
  name: string;
}

interface AddToListProps {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  /**
   * Icon-only, for use inside a title card. Membership is then only fetched
   * once opened — a grid of cards each firing their own lookup would be
   * dozens of requests per page.
   */
  compact?: boolean;
}

const AddToList = ({ tmdbId, mediaType, compact }: AddToListProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const [isOpen, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState<number[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => {
    if (!compact) {
      setOpen(false);
    }
  });

  // Shared key: SWR de-duplicates this across every card on the page.
  const { data: lists, mutate: revalidateLists } = useSWR<ListSummary[]>(
    !compact || isOpen ? '/api/v1/list' : null
  );

  const { data: membership, mutate: revalidateMembership } = useSWR<
    { listId: number; listName: string }[]
  >(
    !compact || isOpen
      ? `/api/v1/list/contains?tmdbId=${tmdbId}&mediaType=${mediaType}`
      : null
  );

  const containing = new Set((membership ?? []).map((m) => m.listId));
  const isInAnyList = containing.size > 0;

  const reportError = (e: unknown) => {
    const detail =
      (axios.isAxiosError(e) && e.response?.data?.message) ||
      (e instanceof Error ? e.message : String(e));

    addToast(<span>{intl.formatMessage(messages.failed, { detail })}</span>, {
      appearance: 'error',
      autoDismiss: true,
    });
  };

  const toggle = async (listId: number) => {
    setPending((current) => [...current, listId]);

    try {
      if (containing.has(listId)) {
        await axios.delete(
          `/api/v1/list/${listId}/item?tmdbId=${tmdbId}&mediaType=${mediaType}`
        );
      } else {
        await axios.post(`/api/v1/list/${listId}/item`, { tmdbId, mediaType });
      }

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

    if (!name) {
      return;
    }

    try {
      const { data } = await axios.post<{ id: number }>('/api/v1/list', {
        name,
      });
      await axios.post(`/api/v1/list/${data.id}/item`, { tmdbId, mediaType });
      setNewName('');
      await Promise.all([
        revalidateLists(),
        revalidateMembership(),
        globalMutate(MARKERS_KEY),
      ]);
    } catch (e) {
      reportError(e);
    }
  };

  const body = (
    <>
      {/*
        Saying where a title already sits avoids adding the same thing to a
        second list without realising.
      */}
      {isInAnyList && (
        <p className="mb-2 border-b border-gray-700 px-2 pb-2 text-xs text-gray-400">
          {intl.formatMessage(messages.alreadyon, {
            lists: (membership ?? [])
              .map((entry) => entry.listName)
              .filter(Boolean)
              .join(', '),
          })}
        </p>
      )}

      {lists?.length ? (
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {lists.map((list) => (
            <li key={`list-${list.id}`}>
              <button
                className="flex w-full items-center space-x-2 rounded px-2 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50"
                disabled={pending.includes(list.id)}
                onClick={() => toggle(list.id)}
                type="button"
              >
                <input
                  checked={containing.has(list.id)}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600"
                  readOnly
                  type="checkbox"
                />
                <span className="flex-1 truncate">{list.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-2 text-sm text-gray-400">
          {intl.formatMessage(messages.nolists)}
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
          placeholder={intl.formatMessage(messages.newlist)}
          type="text"
          value={newName}
        />
        <button
          aria-label={intl.formatMessage(messages.create)}
          className="rounded bg-indigo-600 p-1.5 text-white hover:bg-indigo-500 disabled:opacity-50"
          disabled={!newName.trim()}
          onClick={createAndAdd}
          type="button"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>
    </>
  );

  return (
    <div className="relative" ref={containerRef}>
      {compact ? (
        <button
          aria-label={intl.formatMessage(messages.addtolist)}
          // On a poster, so dark in every look.
          className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-[rgb(var(--media-scrim-raised)/0.8)] text-on-media ring-1 ring-gray-600 transition hover:bg-gray-700 light:hover:bg-[rgb(var(--media-scrim-raised))]"
          onClick={(e) => {
            e.preventDefault();
            setOpen((open) => !open);
          }}
          type="button"
        >
          {isInAnyList ? (
            <BookmarkFilledIcon className="h-4 w-4" />
          ) : (
            <BookmarkIcon className="h-4 w-4" />
          )}
        </button>
      ) : (
        <Button
          buttonType={isInAnyList ? 'primary' : 'default'}
          onClick={() => setOpen((open) => !open)}
        >
          {isInAnyList ? <BookmarkFilledIcon /> : <BookmarkIcon />}
          <span>
            {intl.formatMessage(
              isInAnyList ? messages.inlist : messages.addtolist
            )}
          </span>
        </Button>
      )}

      {isOpen &&
        (compact ? (
          /*
            A 256px panel inside a ~150px card is clipped by the card's own
            overflow, and a dropdown that size is awkward on a phone. The
            modal portals above everything instead.
          */
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
              backgroundClickable
              okText={intl.formatMessage(messages.done)}
              onCancel={() => setOpen(false)}
              onOk={() => setOpen(false)}
              title={intl.formatMessage(messages.addtolist)}
            >
              {body}
            </Modal>
          </Transition>
        ) : (
          <div className="absolute right-0 z-50 mt-2 w-64 rounded-md border border-gray-700 bg-gray-800 p-2 shadow-lg">
            {body}
          </div>
        ))}
    </div>
  );
};

export default AddToList;
