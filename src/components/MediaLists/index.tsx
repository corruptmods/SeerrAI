import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import { ListCardsSkeleton } from '@app/components/Common/PageSkeleton';
import PageTitle from '@app/components/Common/PageTitle';
import ListCard from '@app/components/MediaLists/ListCard';
import ShareListModal from '@app/components/MediaLists/ShareListModal';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { PlusIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MediaLists', {
  watchlists: 'Watch Lists',
  createlist: 'Create List',
  newlist: 'New list name',
  empty: 'You have no lists yet. Create one to start collecting titles.',
  createfailed: 'Could not create the list: {detail}',
});

interface ListSummary {
  id: number;
  name: string;
  owner: { id: number; displayName: string };
  isOwner: boolean;
  itemCount: number;
  watchedCount?: number;
  memberCount: number;
  previews: { tmdbId: number; posterPath?: string | null }[];
}

const MediaLists = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user } = useUser();
  const [newName, setNewName] = useState('');
  const [isCreating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<{ id: number; name: string } | null>(
    null
  );
  const { data: lists, mutate, error } = useSWR<ListSummary[]>('/api/v1/list');

  const create = async () => {
    const name = newName.trim();

    if (!name) {
      return;
    }

    setCreating(true);

    try {
      const { data } = await axios.post<{ id: number; name: string }>(
        '/api/v1/list',
        { name }
      );
      setNewName('');
      // Show the list straight away rather than waiting on a refetch, then
      // offer to share it. Both happen without a page navigation, so neither
      // waits on a server round trip.
      await mutate();
      setSharing({ id: data.id, name: data.name });
    } catch (e) {
      // Without this the button silently does nothing when the request
      // fails, which is indistinguishable from the click not registering.
      const detail =
        (axios.isAxiosError(e) && e.response?.data?.message) ||
        (e instanceof Error ? e.message : String(e));

      addToast(
        <span>{intl.formatMessage(messages.createfailed, { detail })}</span>,
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setCreating(false);
    }
  };

  if (!lists && !error) {
    return <ListCardsSkeleton />;
  }

  return (
    <>
      {sharing && (
        <ShareListModal
          listId={sharing.id}
          listName={sharing.name}
          ownerId={user?.id}
          onComplete={() => {
            setSharing(null);
            mutate();
          }}
        />
      )}
      <PageTitle title={intl.formatMessage(messages.watchlists)} />
      <div className="mb-6">
        <Header>{intl.formatMessage(messages.watchlists)}</Header>
      </div>

      <div className="mb-6 flex max-w-lg items-center space-x-2">
        <input
          className="min-w-0 flex-1 rounded border-gray-600 bg-gray-700 px-3 py-2 text-white"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              create();
            }
          }}
          placeholder={intl.formatMessage(messages.newlist)}
          type="text"
          value={newName}
        />
        <Button
          buttonType="primary"
          disabled={!newName.trim() || isCreating}
          onClick={create}
        >
          <PlusIcon />
          <span>{intl.formatMessage(messages.createlist)}</span>
        </Button>
      </div>

      {lists?.length ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {lists.map((list, index) => (
            <li key={`list-${list.id}`}>
              <ListCard
                id={list.id}
                index={index}
                isOwner={list.isOwner}
                itemCount={list.itemCount}
                watchedCount={list.watchedCount}
                memberCount={list.memberCount}
                name={list.name}
                owner={list.owner}
                previews={list.previews ?? []}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-gray-400">{intl.formatMessage(messages.empty)}</p>
      )}
    </>
  );
};

export default MediaLists;
