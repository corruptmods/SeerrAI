import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MediaLists.ShareListModal', {
  title: 'Share "{name}"',
  description:
    'Choose who can see this list. Only you and the people you pick will see it. You can change this later.',
  save: 'Share',
  skip: 'Keep Private',
  nousers: 'There are no other users to share with.',
});

interface ShareListModalProps {
  listId: number;
  listName: string;
  /** Members already on the list, so the modal reflects current state. */
  initialMemberIds?: number[];
  ownerId?: number;
  onComplete: () => void;
}

const ShareListModal = ({
  listId,
  listName,
  initialMemberIds = [],
  ownerId,
  onComplete,
}: ShareListModalProps) => {
  const intl = useIntl();
  const [selected, setSelected] = useState<number[]>(initialMemberIds);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: users } = useSWR<{
    results: { id: number; displayName: string }[];
  }>('/api/v1/user?take=100');

  const candidates = (users?.results ?? []).filter((u) => u.id !== ownerId);

  // "Keep private" still stores the watch-sync choice — it is a property of
  // the list, not of who it is shared with.
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
        memberIds: selected,
      });
      onComplete();
    } catch (e) {
      // Without this the dialog just reappeared with no explanation.
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
    // <Transition>. Every other modal in the app is wrapped the same way.
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

        {!users ? (
          <LoadingSpinner />
        ) : candidates.length ? (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {candidates.map((user) => (
              <li key={`share-${user.id}`}>
                <label className="flex items-center space-x-3 py-1 text-sm text-gray-200">
                  <input
                    checked={selected.includes(user.id)}
                    className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600"
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(user.id)
                          ? current.filter((id) => id !== user.id)
                          : [...current, user.id]
                      )
                    }
                    type="checkbox"
                  />
                  <span>{user.displayName}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.nousers)}
          </p>
        )}
      </Modal>
    </Transition>
  );
};

export default ShareListModal;
