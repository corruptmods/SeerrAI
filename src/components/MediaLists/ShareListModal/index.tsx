import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import useDebouncedState from '@app/hooks/useDebouncedState';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MediaLists.ShareListModal', {
  title: 'Share "{name}"',
  description: 'Only you and the people you pick can see this list.',
  save: 'Share',
  skip: 'Keep Private',
  nousers: 'There are no other users to share with.',
  search: 'Search users',
  nomatch: 'No one matches "{query}".',
  searchformore: 'Not everyone is shown. Search to find someone else.',
});

/** People shown at once; others are found by searching. */
const PAGE_SIZE = 50;

interface Person {
  id: number;
  displayName: string;
}

interface ShareListModalProps {
  listId: number;
  listName: string;
  /** Current members. */
  initialMembers?: Person[];
  ownerId?: number;
  onComplete: () => void;
}

const ShareListModal = ({
  listId,
  listName,
  initialMembers = [],
  ownerId,
  onComplete,
}: ShareListModalProps) => {
  const intl = useIntl();
  // Ticked people with names, so a pick stays shown after the search changes.
  const [selected, setSelected] = useState<Person[]>(initialMembers);
  // Members at open, fixed even if the page reloads, so the save can detect
  // changes since.
  const [startedFrom] = useState(() => initialMembers.map((p) => p.id));
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, search, setSearchInput] = useDebouncedState('');

  const query = search.trim();
  const { data: users } = useSWR<{
    pageInfo: { results: number };
    results: Person[];
  }>(
    `/api/v1/user?take=${PAGE_SIZE}&sort=displayname${
      query ? `&q=${encodeURIComponent(query)}` : ''
    }`
  );

  const isSelected = (id: number) => selected.some((p) => p.id === id);

  // Chosen people first, then the rest of the page or search results.
  const candidates = [
    ...selected,
    ...(users?.results ?? []).filter(
      (u) => u.id !== ownerId && !isSelected(u.id)
    ),
  ];
  const hasMore = !!users && users.pageInfo.results > users.results.length;

  const toggle = (person: Person) =>
    setSelected((current) =>
      current.some((p) => p.id === person.id)
        ? current.filter((p) => p.id !== person.id)
        : [...current, { id: person.id, displayName: person.displayName }]
    );

  // "Keep private" still saves the watch-sync choice: it belongs to the list,
  // not its members.
  const saveWithoutMembers = async () => {
    setSaving(true);
    setError(null);

    try {
      await axios.put(`/api/v1/list/${listId}`, {
        memberIds: [],
      });
      onComplete();
    } catch (e) {
      setError(
        (axios.isAxiosError(e) && e.response?.data?.message) ||
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);

    try {
      await axios.put(`/api/v1/list/${listId}`, {
        memberIds: selected.map((p) => p.id),
        // If someone left since opening, the server refuses the save rather
        // than re-adding them.
        previousMemberIds: startedFrom,
      });
      onComplete();
    } catch (e) {
      setError(
        (axios.isAxiosError(e) && e.response?.data?.message) ||
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    // Modal renders a <Transition.Child>, which throws without a parent
    // <Transition>.
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
        loading={isSaving}
        okButtonType="primary"
        okText={intl.formatMessage(messages.save)}
        onCancel={onComplete}
        onOk={save}
        onSecondary={saveWithoutMembers}
        secondaryButtonType="default"
        secondaryText={intl.formatMessage(messages.skip)}
        title={intl.formatMessage(messages.title, { name: listName })}
      >
        {error && (
          <p className="mb-3 rounded bg-red-900/40 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}

        <p className="mb-3 text-sm text-gray-300">
          {intl.formatMessage(messages.description)}
        </p>

        <input
          aria-label={intl.formatMessage(messages.search)}
          className="mb-3 w-full rounded border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white"
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={intl.formatMessage(messages.search)}
          type="search"
          value={searchInput}
        />

        {!users && !selected.length ? (
          <LoadingSpinner />
        ) : candidates.length ? (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {candidates.map((user) => (
              <li key={`share-${user.id}`}>
                <label className="flex items-center space-x-3 py-1 text-sm text-gray-200">
                  <input
                    checked={isSelected(user.id)}
                    className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600"
                    onChange={() => toggle(user)}
                    type="checkbox"
                  />
                  <span>{user.displayName}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-400">
            {query
              ? intl.formatMessage(messages.nomatch, { query })
              : intl.formatMessage(messages.nousers)}
          </p>
        )}

        {hasMore && (
          <p className="mt-2 text-xs text-gray-400">
            {intl.formatMessage(messages.searchformore)}
          </p>
        )}
      </Modal>
    </Transition>
  );
};

export default ShareListModal;
